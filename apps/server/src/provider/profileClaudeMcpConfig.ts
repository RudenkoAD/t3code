/** User-scope Claude MCP servers disabled by T3 are kept in this inert sibling map. */
export const CLAUDE_DISABLED_MCP_SERVERS_KEY = "t3DisabledMcpServers" as const;

type ClaudeMcpServerInventoryEntry = {
  readonly name: string;
  readonly enabled: boolean;
};

type SetClaudeMcpEnabledResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-config" | "server-not-found";
    };

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isServerMap = (value: unknown): value is Record<string, JsonObject> =>
  value === undefined ||
  (isJsonObject(value) &&
    Object.entries(value).every(
      ([name, server]) => name.trim().length > 0 && isJsonObject(server),
    ));

const parseRoot = (content: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isJsonObject(parsed)) return undefined;
    if (!isServerMap(parsed.mcpServers) || !isServerMap(parsed[CLAUDE_DISABLED_MCP_SERVERS_KEY])) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

/** Projects MCP inventory to names and enabled state, omitting every server definition. */
export const readClaudeMcpServers = (
  parsedRoot: unknown,
): ReadonlyArray<ClaudeMcpServerInventoryEntry> | undefined => {
  if (!isJsonObject(parsedRoot)) return undefined;
  const active = parsedRoot.mcpServers;
  const disabled = parsedRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY];
  if (!isServerMap(active) || !isServerMap(disabled)) return undefined;

  const status = new Map<string, boolean>();
  for (const name of Object.keys(active ?? {})) status.set(name, true);
  for (const name of Object.keys(disabled ?? {})) {
    // A native/other writer may have re-added a name while T3's disabled copy is stale.
    if (!status.has(name)) status.set(name, false);
  }
  return [...status]
    .map(([name, enabled]) => ({ name, enabled }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

/** Moves a user-scope server between Claude's active map and T3's inert map. */
export const setClaudeMcpEnabled = (
  content: string,
  name: string,
  enabled: boolean,
): SetClaudeMcpEnabledResult => {
  if (name.trim().length === 0) return { ok: false, reason: "invalid-config" };
  const root = parseRoot(content);
  if (root === undefined) return { ok: false, reason: "invalid-config" };

  const active = (root.mcpServers ?? {}) as Record<string, JsonObject>;
  const disabled = (root[CLAUDE_DISABLED_MCP_SERVERS_KEY] ?? {}) as Record<string, JsonObject>;
  const hasActive = Object.hasOwn(active, name);
  const hasDisabled = Object.hasOwn(disabled, name);

  // Claude/native writers may re-add a server while its old disabled snapshot
  // remains. The active definition is authoritative: enabling is already done,
  // while disabling replaces only that server's stale snapshot with the active one.
  if (enabled && hasActive) return { ok: true, content };
  if (!enabled && hasDisabled && !hasActive) return { ok: true, content };
  if (enabled && !hasDisabled) return { ok: false, reason: "server-not-found" };
  if (!enabled && !hasActive) return { ok: false, reason: "server-not-found" };

  if (enabled) {
    root.mcpServers = { ...active, [name]: disabled[name] };
    delete disabled[name];
    if (Object.keys(disabled).length === 0) delete root[CLAUDE_DISABLED_MCP_SERVERS_KEY];
  } else {
    root[CLAUDE_DISABLED_MCP_SERVERS_KEY] = { ...disabled, [name]: active[name] };
    delete active[name];
  }
  return { ok: true, content: JSON.stringify(root, null, 2) };
};
