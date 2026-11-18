import { createCodexRealtimeEnvironmentAtoms } from "@t3tools/client-runtime/state/codexRealtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const codexRealtimeEnvironment = createCodexRealtimeEnvironmentAtoms(connectionAtomRuntime);
