import {
  type ProjectId,
  type ProjectProfile,
  type ProjectToolsInventoryResult,
  ProviderInstanceId,
  profileProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TOML from "smol-toml";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { probeCodexSkillsForCwd } from "../provider/CodexProvider.ts";
import { readProfileMcpInventory } from "../provider/ProfileMcpInventory.ts";

type McpRows = ReadonlyArray<{
  readonly name: string;
  readonly provider: "codex" | "claude";
  readonly source: "profile" | "project";
  readonly enabled: boolean;
}>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const readJson = Effect.fn("ProjectToolsInventory.readJson")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return undefined;
  const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (!content) return undefined;
  return yield* decodeJson(content).pipe(Effect.orElseSucceed(() => undefined));
});

const codexProjectMcp = Effect.fn("ProjectToolsInventory.codexProjectMcp")(function* (
  workspaceRoot: string,
  codexHome: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const profileConfigPath = path.join(codexHome, "config.toml");
  const profileExists = yield* fs.exists(profileConfigPath).pipe(Effect.orElseSucceed(() => false));
  if (!profileExists) return [] satisfies McpRows;
  const profileText = yield* fs
    .readFileString(profileConfigPath)
    .pipe(Effect.orElseSucceed(() => ""));
  const trusted = yield* Effect.try({
    try: () => {
      const root = TOML.parse(profileText) as Record<string, unknown>;
      const projects = asRecord(root.projects);
      const project = asRecord(projects?.[workspaceRoot]);
      return project?.trust_level === "trusted";
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));
  if (!trusted) return [] satisfies McpRows;
  const localConfigPath = path.join(workspaceRoot, ".codex", "config.toml");
  const localExists = yield* fs.exists(localConfigPath).pipe(Effect.orElseSucceed(() => false));
  if (!localExists) return [] satisfies McpRows;
  const localText = yield* fs.readFileString(localConfigPath).pipe(Effect.orElseSucceed(() => ""));
  return yield* Effect.try({
    try: () => {
      const root = TOML.parse(localText) as Record<string, unknown>;
      const servers = asRecord(root.mcp_servers) ?? {};
      return Object.entries(servers)
        .filter(([name, value]) => name.trim().length > 0 && asRecord(value) !== undefined)
        .map(([name, value]) => ({
          name,
          provider: "codex" as const,
          source: "project" as const,
          enabled: asRecord(value)?.enabled !== false,
        }));
    },
    catch: () => [] as McpRows,
  }).pipe(Effect.orElseSucceed(() => [] satisfies McpRows));
});

const claudeProjectMcp = Effect.fn("ProjectToolsInventory.claudeProjectMcp")(function* (
  workspaceRoot: string,
  claudeHome: string,
) {
  const path = yield* Path.Path;
  const trustedSettings = asRecord(yield* readJson(path.join(claudeHome, ".claude.json")));
  const projectSettings = asRecord(asRecord(trustedSettings?.projects)?.[workspaceRoot]);
  if (projectSettings?.hasTrustDialogAccepted !== true) return [] satisfies McpRows;

  const rows = new Map<string, McpRows[number]>();
  const projectServers = asRecord(projectSettings.mcpServers);
  for (const name of Object.keys(projectServers ?? {})) {
    if (name.trim()) rows.set(name, { name, provider: "claude", source: "project", enabled: true });
  }

  const mcpJson = asRecord(yield* readJson(path.join(workspaceRoot, ".mcp.json")));
  const jsonServers = asRecord(mcpJson?.mcpServers);
  const settings = [
    asRecord(yield* readJson(path.join(claudeHome, "settings.json"))),
    asRecord(yield* readJson(path.join(workspaceRoot, ".claude", "settings.json"))),
    asRecord(yield* readJson(path.join(workspaceRoot, ".claude", "settings.local.json"))),
  ].filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const resolveSetting = (key: string): unknown =>
    settings.reduce<unknown>(
      (resolved, entry) => (key in entry ? entry[key] : resolved),
      undefined,
    );
  const namesFor = (key: string): ReadonlyArray<string> => {
    const value = resolveSetting(key);
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === "string")
      : [];
  };
  const enabledNames = namesFor("enabledMcpjsonServers");
  const disabledNames = namesFor("disabledMcpjsonServers");
  const allowAll = resolveSetting("enableAllProjectMcpServers") === true;
  for (const name of Object.keys(jsonServers ?? {})) {
    if (name.trim()) {
      rows.set(name, {
        name,
        provider: "claude",
        source: "project",
        enabled: !disabledNames.includes(name) && (allowAll || enabledNames.includes(name)),
      });
    }
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
});

const readScopedSkills = Effect.fn("ProjectToolsInventory.readScopedSkills")(function* (input: {
  readonly provider: "codex" | "claude";
  readonly profile: ProjectProfile;
  readonly profileHome: string;
  readonly workspaceRoot: string;
  readonly codexAuthStatus: "authenticated" | "unauthenticated" | "unknown" | undefined;
  readonly registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}) {
  const baseId = ProviderInstanceId.make(input.provider === "codex" ? "codex" : "claudeAgent");
  const instance = yield* input.registry.getInstance(
    profileProviderInstanceId(input.profile, baseId),
  );
  if (instance?.snapshotForCwd === undefined) {
    return { status: "unavailable" as const, rows: [] };
  }
  const result = yield* instance.snapshotForCwd(input.workspaceRoot).pipe(Effect.result);
  if (result._tag === "Success") {
    const nativeSkills = result.success.skills;
    // Codex's signed-out snapshot is empty even though skills/list is available without auth.
    if (
      input.provider !== "codex" ||
      input.codexAuthStatus !== "unauthenticated" ||
      nativeSkills.length > 0
    ) {
      return {
        status: "available" as const,
        rows: nativeSkills.map((skill) => ({
          name: skill.name,
          provider: input.provider,
          source:
            skill.scope === "repo" || skill.scope === "project"
              ? ("project" as const)
              : ("profile" as const),
          enabled: skill.enabled,
        })),
      };
    }
  }
  if (input.provider === "codex" && input.codexAuthStatus === "unauthenticated") {
    return yield* probeCodexSkillsForCwd({
      binaryPath: "codex",
      homePath: input.profileHome,
      cwd: input.workspaceRoot,
    }).pipe(
      Effect.scoped,
      Effect.timeout("15 seconds"),
      Effect.map((skills) => ({
        status: "available" as const,
        rows: skills.map((skill) => ({
          name: skill.name,
          provider: "codex" as const,
          source:
            skill.scope === "repo" || skill.scope === "project"
              ? ("project" as const)
              : ("profile" as const),
          enabled: skill.enabled,
        })),
      })),
      Effect.orElseSucceed(() => ({ status: "unavailable" as const, rows: [] })),
    );
  }
  return { status: "unavailable" as const, rows: [] };
});

/**
 * A names-only view of native tools available to one project. It deliberately
 * reads only the project's profile and native project skill roots; credentials,
 * MCP definitions, paths and skill contents never enter the result.
 */
export const readProjectToolsInventory = Effect.fn("ProjectToolsInventory.read")(function* (input: {
  readonly projectId: ProjectId;
  readonly profile: ProjectProfile;
  readonly workspaceRoot: string;
  readonly profileHomeDirectory: string;
  readonly settings: ServerSettings;
  readonly providerInstanceRegistry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  readonly codexAuthStatus: "authenticated" | "unauthenticated" | "unknown" | undefined;
}) {
  const path = yield* Path.Path;
  const codexHome = path.join(input.profileHomeDirectory, input.profile, "codex");
  const claudeHome = path.join(input.profileHomeDirectory, input.profile, "claude");
  const [mcp, codexProjectRows, claudeProjectRows, codexSkills, claudeSkills] = yield* Effect.all(
    [
      readProfileMcpInventory({ scope: input.profile }, input.profileHomeDirectory),
      codexProjectMcp(input.workspaceRoot, codexHome),
      claudeProjectMcp(input.workspaceRoot, claudeHome),
      readScopedSkills({
        provider: "codex",
        profile: input.profile,
        profileHome: codexHome,
        workspaceRoot: input.workspaceRoot,
        codexAuthStatus: input.codexAuthStatus,
        registry: input.providerInstanceRegistry,
      }),
      readScopedSkills({
        provider: "claude",
        profile: input.profile,
        profileHome: claudeHome,
        workspaceRoot: input.workspaceRoot,
        codexAuthStatus: input.codexAuthStatus,
        registry: input.providerInstanceRegistry,
      }),
    ],
    { concurrency: "unbounded" },
  );
  const profileSettings = input.settings.profileProviderSettings[input.profile];
  const profileMcpServers: ProjectToolsInventoryResult["mcpServers"] = [
    ...mcp.codex.servers.map((server) => ({
      ...server,
      provider: "codex" as const,
      source: "profile" as const,
    })),
    ...mcp.claude.servers.map((server) => ({
      ...server,
      provider: "claude" as const,
      source: "profile" as const,
    })),
  ];
  const mcpServers: ProjectToolsInventoryResult["mcpServers"] = [
    ...profileMcpServers.filter((server) =>
      server.provider === "codex"
        ? !codexProjectRows.some((project) => project.name === server.name)
        : !claudeProjectRows.some((project) => project.name === server.name),
    ),
    ...codexProjectRows,
    ...claudeProjectRows,
  ];
  const skillsByProviderAndName = new Map<string, ProjectToolsInventoryResult["skills"][number]>();
  for (const skill of [...codexSkills.rows, ...claudeSkills.rows]) {
    const key = `${skill.provider}\u0000${skill.name}`;
    const previous = skillsByProviderAndName.get(key);
    if (previous === undefined) {
      skillsByProviderAndName.set(key, skill);
      continue;
    }
    skillsByProviderAndName.set(key, {
      ...skill,
      source: previous.source === "project" || skill.source === "project" ? "project" : "profile",
      enabled: previous.enabled || skill.enabled,
    });
  }
  const skills: ProjectToolsInventoryResult["skills"] = [...skillsByProviderAndName.values()];

  return {
    projectId: input.projectId,
    profile: input.profile,
    providerEnabled: {
      codex: profileSettings.codexEnabled,
      claude: profileSettings.claudeEnabled,
    },
    mcpServers,
    skills,
    providerStatus: {
      codex: codexProjectRows.length > 0 ? "configured" : mcp.codex.status,
      claude: claudeProjectRows.length > 0 ? "configured" : mcp.claude.status,
    },
    skillsStatus: { codex: codexSkills.status, claude: claudeSkills.status },
  } satisfies ProjectToolsInventoryResult;
});
