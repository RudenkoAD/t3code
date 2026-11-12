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

export const ProfileSetMcpServerEnabledInput = Schema.Struct({
  scope: ProjectProfile,
  provider: Schema.Literals(["codex", "claude"]),
  name: Schema.String.check(Schema.isNonEmpty()),
  enabled: Schema.Boolean,
});
export type ProfileSetMcpServerEnabledInput = typeof ProfileSetMcpServerEnabledInput.Type;

export const ProfileMcpServerToggleErrorReason = Schema.Literals([
  "missing_server",
  "invalid_config",
  "unsupported_layout",
  "conflict",
  "write_failed",
  "linked_config",
]);

export class ProfileMcpServerToggleError extends Schema.TaggedError<ProfileMcpServerToggleError>()(
  "ProfileMcpServerToggleError",
  { reason: ProfileMcpServerToggleErrorReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing_server":
        return "This MCP server is no longer configured.";
      case "invalid_config":
        return "This provider's MCP configuration is invalid.";
      case "unsupported_layout":
        return "Use the provider's CLI to edit this configuration layout.";
      case "conflict":
        return "The MCP configuration changed. Refresh and try again.";
      case "write_failed":
        return "Could not update the provider's MCP configuration.";
      case "linked_config":
        return "This MCP configuration is linked and cannot be edited independently.";
    }
  }
}
