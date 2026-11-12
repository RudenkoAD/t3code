import * as TOML from "smol-toml";
import type {
  ProfileMcpInventoryInput,
  ProfileMcpInventoryResult,
  ProfileSetMcpServerEnabledInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { profileProviderHomeDirectory } from "./profileProviderHome.ts";
import { readClaudeMcpServers } from "./profileClaudeMcpConfig.ts";
import { updateProfileMcpConfig } from "./profileMcpConfigFile.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
type ProviderInventory = ProfileMcpInventoryResult["codex"];

const empty = (status: ProviderInventory["status"]): ProviderInventory => ({ status, servers: [] });

const projectServerEntries = (value: unknown): ProviderInventory => {
  if (value === undefined || value === null) return empty("empty");
  if (typeof value !== "object" || Array.isArray(value)) return empty("parse_error");
  const entries = Object.entries(value);
  const servers = [];
  for (const [name, definition] of entries) {
    if (name.trim().length === 0) return empty("parse_error");
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      return empty("parse_error");
    }
    const config = definition as Record<string, unknown>;
    if (config.enabled !== undefined && typeof config.enabled !== "boolean")
      return empty("parse_error");
    servers.push({ name, enabled: config.enabled !== false });
  }
  return { status: servers.length === 0 ? "empty" : "configured", servers };
};

const readConfig = Effect.fn("ProfileMcpInventory.readConfig")(function* (
  filePath: string,
  provider: "codex" | "claude",
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return empty("missing");
  const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (content.length === 0) return empty("parse_error");
  const parsed =
    provider === "codex"
      ? yield* Effect.try({
          try: () => TOML.parse(content) as unknown,
          catch: () => "invalid-config" as const,
        }).pipe(Effect.orElseSucceed(() => null))
      : yield* decodeJson(content).pipe(Effect.orElseSucceed(() => null));
  if (parsed === null) return empty("parse_error");
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty("parse_error");
  }
  const root = parsed as Record<string, unknown>;
  if (provider === "codex") return projectServerEntries(root.mcp_servers);
  const servers = readClaudeMcpServers(root);
  if (!servers) return empty("parse_error");
  return { status: servers.length ? "configured" : "empty", servers } satisfies ProviderInventory;
});

export const setProfileMcpServerEnabled = Effect.fn("ProfileMcpInventory.setServerEnabled")(
  function* (input: ProfileSetMcpServerEnabledInput, profilesDirectory: string) {
    yield* updateProfileMcpConfig(input, profilesDirectory);
    return yield* readProfileMcpInventory({ scope: input.scope }, profilesDirectory);
  },
);

/** Reads only fixed provider profile files and projects out non-sensitive inventory fields. */
export const readProfileMcpInventory = Effect.fn("ProfileMcpInventory.read")(function* (
  input: ProfileMcpInventoryInput,
  profilesDirectory: string,
) {
  const path = yield* Path.Path;
  const codexHome = profileProviderHomeDirectory(path, profilesDirectory, input.scope, "codex");
  const claudeHome = profileProviderHomeDirectory(path, profilesDirectory, input.scope, "claude");
  const [codex, claude] = yield* Effect.all([
    readConfig(path.join(codexHome, "config.toml"), "codex"),
    readConfig(path.join(claudeHome, ".claude.json"), "claude"),
  ]);
  return { scope: input.scope, codex, claude } satisfies ProfileMcpInventoryResult;
});
