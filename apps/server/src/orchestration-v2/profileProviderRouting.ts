import {
  type ModelSelection,
  type ProjectId,
  profileProviderInstanceBaseId,
  type ServerSettings,
  resolveProjectProviderInstanceId,
} from "@t3tools/contracts";

/** Route legacy and formerly scoped built-in selections to the project's current profile. */
export function routeProfileProviderSelection(
  settings: ServerSettings,
  projectId: ProjectId | null,
  selection: ModelSelection,
): ModelSelection | undefined {
  if (projectId === null) return selection;
  const baseId =
    profileProviderInstanceBaseId(selection.instanceId)?.baseId ?? selection.instanceId;
  const instanceId = resolveProjectProviderInstanceId(settings, projectId, baseId);
  return instanceId === undefined ? undefined : { ...selection, instanceId };
}
