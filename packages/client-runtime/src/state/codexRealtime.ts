import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createCodexRealtimeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-realtime:start",
      tag: WS_METHODS.codexRealtimeStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-realtime:stop",
      tag: WS_METHODS.codexRealtimeStop,
    }),
  };
}
