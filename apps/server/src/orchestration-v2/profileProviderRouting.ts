import {
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  profileProviderInstanceBaseId,
  type ServerSettings,
  resolveProjectProviderInstanceId,
} from "@t3tools/contracts";

export function projectNativeToolPolicy(
  settings: ServerSettings,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
) {
  const instance = profileProviderInstanceBaseId(instanceId);
  if (projectId === null || !instance) return undefined;
  const policy =
    settings.projectSettingsOverrides[projectId]?.profileToolAccess?.[instance.profile];
  if (!policy) return undefined;
  const provider = instance.baseId === "codex" ? "codex" : "claude";
  const deniedMcpServers = Object.keys(policy.mcpServers?.[provider] ?? {}).sort();
  const deniedSkills = Object.keys(policy.skills?.[provider] ?? {}).sort();
  return deniedMcpServers.length || deniedSkills.length
    ? { deniedMcpServers, deniedSkills }
    : undefined;
}

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
