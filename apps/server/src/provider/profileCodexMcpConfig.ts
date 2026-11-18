// @effect-diagnostics nodeBuiltinImport:off -- deep compare parsed TOML values, including dates.
import * as NodeUtil from "node:util";

import * as TOML from "smol-toml";
import * as TOMLCST from "toml-eslint-parser";

export type SetCodexMcpEnabledResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-config" | "server-not-found" | "unsupported-layout" | "unsafe-edit";
    };

type RecordValue = Record<string, unknown>;
type TomlTopLevelItem = TOMLCST.AST.TOMLKeyValue | TOMLCST.AST.TOMLTable;

const asRecord = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
    ? (value as RecordValue)
    : null;

const keyParts = (key: TOMLCST.AST.TOMLKey): ReadonlyArray<string> =>
  key.keys.map((part) => (part.type === "TOMLBare" ? part.name : part.value));

const samePath = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const isInlineTable = (value: TOMLCST.AST.TOMLContentNode): value is TOMLCST.AST.TOMLInlineTable =>
  value.type === "TOMLInlineTable";

function parseSemantic(content: string): unknown | null {
  try {
    return TOML.parse(content) as unknown;
  } catch {
    return null;
  }
}

function insertAt(content: string, offset: number, value: string): string {
  return `${content.slice(0, offset)}${value}${content.slice(offset)}`;
}

function newlineOf(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function addLineAt(content: string, insertion: number, line: string): string {
  const newline = newlineOf(content);
  const prefix = insertion > 0 && !content.slice(0, insertion).endsWith("\n") ? newline : "";
  const suffix = insertion < content.length || content.endsWith("\n") ? newline : "";
  return insertAt(content, insertion, `${prefix}${line}${suffix}`);
}

function addToTable(
  content: string,
  items: ReadonlyArray<TomlTopLevelItem>,
  table: TOMLCST.AST.TOMLTable,
  line: string,
): string {
  const position = items.indexOf(table);
  const nextTable = items.slice(position + 1).find((item) => item.type === "TOMLTable");
  const insertion = nextTable?.range[0] ?? content.length;
  return addLineAt(content, insertion, line);
}

function addInlineProperty(
  content: string,
  table: TOMLCST.AST.TOMLInlineTable,
  name: string,
  enabled: boolean,
): string | null {
  const [start, end] = table.range;
  if (content[start] !== "{" || content[end - 1] !== "}") return null;
  const separator = table.body.length === 0 ? "" : ",";
  return insertAt(content, start + 1, ` ${name} = ${enabled}${separator}`);
}

/** Changes only the named server's enabled field and validates the resulting TOML structure. */
export function setCodexMcpEnabled(
  content: string,
  name: string,
  enabled: boolean,
): SetCodexMcpEnabledResult {
  let ast: TOMLCST.AST.TOMLProgram;
  try {
    ast = TOMLCST.parseTOML(content);
  } catch {
    return { ok: false, reason: "invalid-config" };
  }
  const parsed = parseSemantic(content);
  const root = asRecord(parsed);
  const servers = asRecord(root?.mcp_servers);
  if (parsed === null) return { ok: false, reason: "invalid-config" };
  if (!root) return { ok: false, reason: "invalid-config" };
  if (!servers)
    return {
      ok: false,
      reason: root.mcp_servers === undefined ? "server-not-found" : "invalid-config",
    };
  const server = asRecord(servers[name]);
  if (!server) return { ok: false, reason: "server-not-found" };
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
    return { ok: false, reason: "invalid-config" };
  }
  if (server.enabled === enabled || (server.enabled === undefined && enabled)) {
    return { ok: true, content };
  }

  const items = ast.body[0].body;
  const target = ["mcp_servers", name];
  const locations: {
    serverTable?: TOMLCST.AST.TOMLTable;
    childTable?: TOMLCST.AST.TOMLTable;
    serversTable?: TOMLCST.AST.TOMLTable;
    enabledValue?: TOMLCST.AST.TOMLContentNode;
    inlineServer?: TOMLCST.AST.TOMLInlineTable;
  } = {};

  const visitKeyValue = (entry: TOMLCST.AST.TOMLKeyValue, base: ReadonlyArray<string>) => {
    const resolvedPath = [...base, ...keyParts(entry.key)];
    if (samePath(resolvedPath, [...target, "enabled"])) locations.enabledValue = entry.value;
    if (samePath(resolvedPath, target) && isInlineTable(entry.value))
      locations.inlineServer = entry.value;
    if (isInlineTable(entry.value)) {
      for (const child of entry.value.body) visitKeyValue(child, resolvedPath);
    }
  };
  for (const item of items) {
    if (item.type === "TOMLTable") {
      const tablePath = item.resolvedKey.map(String);
      if (samePath(tablePath, target)) locations.serverTable = item;
      else if (
        tablePath.length > target.length &&
        target.every((part, index) => tablePath[index] === part) &&
        (!locations.childTable || item.range[0] < locations.childTable.range[0])
      ) {
        locations.childTable = item;
      } else if (samePath(tablePath, ["mcp_servers"])) locations.serversTable = item;
      for (const entry of item.body) visitKeyValue(entry, tablePath);
    } else {
      visitKeyValue(item, []);
    }
  }
  let changed: string | null = null;
  if (locations.enabledValue) {
    const [start, end] = locations.enabledValue.range;
    changed = `${content.slice(0, start)}${enabled}${content.slice(end)}`;
  } else if (locations.inlineServer) {
    changed = addInlineProperty(content, locations.inlineServer, "enabled", enabled);
  } else if (locations.serverTable) {
    changed = addToTable(content, items, locations.serverTable, `enabled = ${enabled}`);
  } else if (locations.childTable) {
    const newline = newlineOf(content);
    const header = `[mcp_servers.${JSON.stringify(name)}]${newline}enabled = ${enabled}${newline}${newline}`;
    changed = insertAt(content, locations.childTable.range[0], header);
  } else if (locations.serversTable) {
    changed = addToTable(
      content,
      items,
      locations.serversTable,
      `${JSON.stringify(name)}.enabled = ${enabled}`,
    );
  } else {
    const position = items.find((item) => item.type === "TOMLTable")?.range[0] ?? content.length;
    changed = addLineAt(
      content,
      position,
      `mcp_servers.${JSON.stringify(name)}.enabled = ${enabled}`,
    );
  }
  if (changed === null) return { ok: false, reason: "unsupported-layout" };

  const reparsed = parseSemantic(changed);
  server.enabled = enabled;
  if (!NodeUtil.isDeepStrictEqual(reparsed, parsed)) return { ok: false, reason: "unsafe-edit" };
  return { ok: true, content: changed };
}
