export interface CodexNativeSkillPolicyEntry {
  readonly path: string;
  readonly enabled: boolean;
}

export interface CodexProjectPolicyConfigInput {
  /** Existing app-server thread config; preserved, including injected MCP settings. */
  readonly baseConfig?: Readonly<Record<string, unknown>>;
  /** Full native skills/list result, including profile-level disabled entries. */
  readonly nativeSkills: readonly CodexNativeSkillPolicyEntry[];
  /** Canonical absolute SKILL.md paths denied by the project policy. */
  readonly deniedSkillPaths: readonly string[];
}

/** Compose per-thread native skill denials without writing to the user's Codex home. */
export function buildCodexThreadPolicyConfig(
  input: CodexProjectPolicyConfigInput,
): Record<string, unknown> {
  const entries = new Map<string, { path: string; enabled: false }>();

  for (const skill of input.nativeSkills) {
    if (!skill.enabled && skill.path) entries.set(skill.path, { path: skill.path, enabled: false });
  }
  for (const path of input.deniedSkillPaths) {
    if (path) entries.set(path, { path, enabled: false });
  }

  const baseConfig = input.baseConfig ?? {};
  const baseSkills = isRecord(baseConfig.skills) ? baseConfig.skills : {};
  const existingEntries = Array.isArray(baseSkills.config) ? baseSkills.config : [];
  const retainedEntries = existingEntries.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry),
  );
  const byPath = new Map<string, Record<string, unknown>>();
  for (const entry of retainedEntries) {
    if (typeof entry.path === "string") byPath.set(entry.path, entry);
  }
  for (const entry of entries.values()) {
    byPath.set(entry.path, { ...byPath.get(entry.path), ...entry });
  }

  return {
    ...baseConfig,
    skills: {
      ...baseSkills,
      config: [...byPath.values()],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
