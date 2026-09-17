import type { OpenCodeClient } from "@opencode/client";

export interface V2Api {
  server: Pick<OpenCodeClient["server"], "info">;
  session: Pick<
    OpenCodeClient["session"],
    | "create"
    | "get"
    | "list"
    | "active"
    | "remove"
    | "switchAgent"
    | "switchModel"
    | "environment"
    | "instructions"
    | "prompt"
    | "command"
    | "compact"
    | "wait"
    | "interrupt"
    | "revert"
    | "log"
    | "form"
  >;
  plugin: Pick<OpenCodeClient["plugin"], "list">;
  model: OpenCodeClient["model"];
  provider: Pick<OpenCodeClient["provider"], "list">;
  agent: Pick<OpenCodeClient["agent"], "list">;
  command: OpenCodeClient["command"];
  skill: OpenCodeClient["skill"];
  message: OpenCodeClient["message"];
  mcp: Pick<OpenCodeClient["mcp"], "add" | "list">;
  permission: Pick<OpenCodeClient["permission"], "list" | "reply">;
  event: OpenCodeClient["event"];
}
