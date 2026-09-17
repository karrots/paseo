import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";

const SyntheticQuotasSchema = z.object({
  rollingFiveHourLimit: z
    .object({
      nextTickAt: z.string().datetime({ offset: true }),
      remaining: z.number().finite().nonnegative(),
      max: z.number().finite().nonnegative(),
    })
    .nullish(),
  weeklyTokenLimit: z
    .object({
      percentRemaining: z.number().finite().min(0).max(100),
      nextRegenAt: z.string().datetime({ offset: true }).nullish(),
    })
    .nullish(),
  subscription: z.object({
    limit: z.number().finite().nonnegative(),
    requests: z.number().finite().nonnegative(),
    renewsAt: z.string().datetime({ offset: true }),
  }),
});
const OpenCodeKeySchema = z.object({ type: z.literal("key"), key: z.string().trim().min(1) });
const LegacyAuthSchema = z.object({
  synthetic: z.object({ type: z.literal("api"), key: z.string().trim().min(1) }).optional(),
});

// @types/node@20 predates node:sqlite; keep the runtime import narrow, as for Cursor.
interface CredentialDatabase {
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => CredentialDatabase;
}
interface SyntheticQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

class SyntheticUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticUsageError";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readOpenCodeKey(homeDir: string): Promise<string | null> {
  const dataDir = join(
    process.env["XDG_DATA_HOME"] || join(homeDir, ".local", "share"),
    "opencode",
  );
  const databaseName = process.env["OPENCODE_DB"] ?? "opencode.db";
  const databasePath = resolve(dataDir, databaseName);
  const hasDatabase = databaseName !== ":memory:" && (await fileExists(databasePath));
  if (hasDatabase) {
    const sqliteSpecifier: string = "node:sqlite";
    const sqlite: NodeSqliteModule = await import(sqliteSpecifier);
    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      // Match OpenCode 2's selected credential, including its deterministic tie breaker.
      const hasCredentials = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
        .get();
      const row = hasCredentials
        ? db
            .prepare(
              "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
            )
            .get("synthetic")
        : undefined;
      if (row) {
        const value = z.string().parse(row["value"]);
        return OpenCodeKeySchema.parse(JSON.parse(value)).key;
      }
    } finally {
      db.close();
    }
  }
  const authPath = join(dataDir, "auth.json");
  if (!(await fileExists(authPath))) return null;
  const auth = LegacyAuthSchema.parse(JSON.parse(await readFile(authPath, "utf8")));
  return auth.synthetic?.key ?? null;
}

export class SyntheticQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "synthetic";
  readonly displayName = "Synthetic";
  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string;

  constructor(options: SyntheticQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir ?? homedir();
  }

  async fetchUsage(): Promise<ProviderUsage> {
    let key = process.env["SYNTHETIC_API_KEY"]?.trim() || null;
    if (!key) {
      try {
        key = await readOpenCodeKey(this.homeDir);
      } catch {
        // JSON/SQLite errors can contain credential contents; never forward them to logs/UI.
        throw new SyntheticUsageError("Could not read Synthetic credentials from OpenCode");
      }
    }
    if (!key) return unavailableUsage(this);
    const response = await fetchProviderApi(this.fetchApi, "https://api.synthetic.new/v2/quotas", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!response.ok) {
      this.logger.debug({ status: response.status }, "Synthetic usage fetch failed");
      if (response.status === 401 || response.status === 403) return unavailableUsage(this);
      throw new SyntheticUsageError(`Synthetic usage request failed (HTTP ${response.status})`);
    }
    let quotas: z.infer<typeof SyntheticQuotasSchema>;
    try {
      quotas = SyntheticQuotasSchema.parse(await response.json());
    } catch {
      throw new SyntheticUsageError("Synthetic returned an invalid quota response");
    }
    const rolling = quotas.rollingFiveHourLimit;
    const requests = rolling
      ? Math.max(0, rolling.max - rolling.remaining)
      : quotas.subscription.requests;
    const limit = rolling ? rolling.max : quotas.subscription.limit;
    const hasLegacyReset = !rolling && requests > 0;
    const resetsAt = hasLegacyReset ? quotas.subscription.renewsAt : null;
    const usedPct = usedPctOf(requests, limit);
    const fiveHourWindow = windowFromUsedPct({
      id: "subscription",
      label: "5 hours",
      utilizationPct: usedPct,
      resetsAt,
      tone: toneFromUsedPct(usedPct),
    });
    fiveHourWindow.detail = `${requests} / ${limit} requests`;
    if (rolling && requests > 0) fiveHourWindow.refillsAt = rolling.nextTickAt;
    const windows = [fiveHourWindow];
    if (quotas.weeklyTokenLimit) {
      const weeklyUsedPct = 100 - quotas.weeklyTokenLimit.percentRemaining;
      const weeklyWindow = windowFromUsedPct({
        id: "weekly",
        label: "Weekly",
        utilizationPct: weeklyUsedPct,
        tone: toneFromUsedPct(weeklyUsedPct),
      });
      // nextRegenAt marks a partial refill, not a full weekly reset.
      if (weeklyUsedPct > 0 && quotas.weeklyTokenLimit.nextRegenAt) {
        weeklyWindow.refillsAt = quotas.weeklyTokenLimit.nextRegenAt;
      }
      windows.push(weeklyWindow);
    }
    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }
}
