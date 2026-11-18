import * as Schema from "effect/Schema";

import { ProfileMcpInventoryProviderStatus } from "./profileMcpInventory.ts";
import { ProjectId } from "./baseSchemas.ts";
import { ProjectProfile } from "./project.ts";

export const ProjectToolsInventoryInput = Schema.Struct({ projectId: ProjectId });
export type ProjectToolsInventoryInput = typeof ProjectToolsInventoryInput.Type;

export class ProjectToolsInventoryError extends Schema.TaggedError<
  ProjectToolsInventoryError,
  { readonly brand: unique symbol }
>()("ProjectToolsInventoryError", { message: Schema.String }) {}

export const ProjectToolsInventoryProvider = Schema.Literals(["codex", "claude"]);
export const ProjectToolsInventorySource = Schema.Literals(["profile", "project"]);
export const ProjectToolsInventoryRow = Schema.Struct({
  name: Schema.String,
  provider: ProjectToolsInventoryProvider,
  source: ProjectToolsInventorySource,
  /** Native/inherited state. Project-level denials are returned through Settings separately. */
  enabled: Schema.Boolean,
});
export type ProjectToolsInventoryRow = typeof ProjectToolsInventoryRow.Type;

export const ProjectToolsInventoryAvailability = Schema.Literals(["available", "unavailable"]);

export const ProjectToolsInventoryResult = Schema.Struct({
  projectId: ProjectId,
  profile: ProjectProfile,
  providerEnabled: Schema.Struct({ codex: Schema.Boolean, claude: Schema.Boolean }),
  mcpServers: Schema.Array(ProjectToolsInventoryRow),
  skills: Schema.Array(ProjectToolsInventoryRow),
  providerStatus: Schema.Struct({
    codex: ProfileMcpInventoryProviderStatus,
    claude: ProfileMcpInventoryProviderStatus,
  }),
  skillsStatus: Schema.Struct({
    codex: ProjectToolsInventoryAvailability,
    claude: ProjectToolsInventoryAvailability,
  }),
});
export type ProjectToolsInventoryResult = typeof ProjectToolsInventoryResult.Type;
