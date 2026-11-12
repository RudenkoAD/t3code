import * as Schema from "effect/Schema";
import { ProjectProfile } from "./project.ts";

export const ProfileMcpInventoryInput = Schema.Struct({ scope: ProjectProfile });
export type ProfileMcpInventoryInput = typeof ProfileMcpInventoryInput.Type;

export const ProfileMcpInventoryProviderStatus = Schema.Literals([
  "missing",
  "empty",
  "configured",
  "parse_error",
]);

export const ProfileMcpServer = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
});

export const ProfileMcpInventoryProvider = Schema.Struct({
  status: ProfileMcpInventoryProviderStatus,
  servers: Schema.Array(ProfileMcpServer),
});

export const ProfileMcpInventoryResult = Schema.Struct({
  scope: ProjectProfile,
  codex: ProfileMcpInventoryProvider,
  claude: ProfileMcpInventoryProvider,
});
export type ProfileMcpInventoryResult = typeof ProfileMcpInventoryResult.Type;
