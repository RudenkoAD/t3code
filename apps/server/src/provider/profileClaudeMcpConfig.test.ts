import { expect, it } from "@effect/vitest";

import {
  CLAUDE_DISABLED_MCP_SERVERS_KEY,
  readClaudeMcpServers,
  setClaudeMcpEnabled,
} from "./profileClaudeMcpConfig.ts";

const activeDefinition = {
  type: "stdio",
  command: "/opt/work-tool",
  args: ["--mode", "worker"],
  env: { PRIVATE_VALUE: "test-only-secret-marker" },
};

it("projects MCP inventory to names and status without exposing definitions", () => {
  const inventory = readClaudeMcpServers({
    mcpServers: {
      enabled: activeDefinition,
      reenabledElsewhere: { command: "/external/tool" },
    },
    [CLAUDE_DISABLED_MCP_SERVERS_KEY]: {
      disabled: { command: "/opt/disabled-tool", env: { KEY: "private" } },
      reenabledElsewhere: { command: "/stale/definition" },
    },
  });

  expect(inventory).toEqual([
    { name: "disabled", enabled: false },
    { name: "enabled", enabled: true },
    { name: "reenabledElsewhere", enabled: true },
  ]);
  expect(JSON.stringify(inventory)).not.toContain("command");
  expect(JSON.stringify(inventory)).not.toContain("test-only-secret-marker");
});

it("distinguishes invalid maps from a valid empty inventory", () => {
  expect(readClaudeMcpServers(null)).toBeUndefined();
  expect(readClaudeMcpServers({ mcpServers: [] })).toBeUndefined();
  expect(readClaudeMcpServers({ [CLAUDE_DISABLED_MCP_SERVERS_KEY]: null })).toBeUndefined();
  expect(readClaudeMcpServers({})).toEqual([]);
});

it("disables only the chosen active MCP server and preserves unrelated nested config", () => {
  const original = {
    projects: { "/work/repo": { hasTrustDialogAccepted: true } },
    oauthAccount: { organizationUuid: "test-org" },
    unrelatedNested: { retain: { number: 7, text: "keep" } },
    mcpServers: {
      work: activeDefinition,
      common: { type: "http", url: "http://127.0.0.1/mcp" },
    },
  };
  const result = setClaudeMcpEnabled(JSON.stringify(original), "work", false);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const parsed = JSON.parse(result.content);
  expect(parsed.mcpServers).toEqual({ common: original.mcpServers.common });
  expect(parsed[CLAUDE_DISABLED_MCP_SERVERS_KEY]).toEqual({ work: activeDefinition });
  expect(parsed.projects).toEqual(original.projects);
  expect(parsed.oauthAccount).toEqual(original.oauthAccount);
  expect(parsed.unrelatedNested).toEqual(original.unrelatedNested);
});

it("re-enables the stored definition without overwriting other active servers", () => {
  const disabled = {
    settingsVersion: 3,
    mcpServers: { common: { type: "http", url: "https://example.invalid/mcp" } },
    [CLAUDE_DISABLED_MCP_SERVERS_KEY]: { work: activeDefinition },
  };
  const result = setClaudeMcpEnabled(JSON.stringify(disabled), "work", true);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const parsed = JSON.parse(result.content);
  expect(parsed.mcpServers).toEqual({ ...disabled.mcpServers, work: activeDefinition });
  expect(parsed[CLAUDE_DISABLED_MCP_SERVERS_KEY]).toBeUndefined();
  expect(parsed.settingsVersion).toBe(3);
});

it("treats a native re-add as authoritative and refreshes only its stale disabled snapshot", () => {
  const externalDefinition = { type: "stdio", command: "/opt/new-tool", args: ["--new"] };
  const content = JSON.stringify({
    mcpServers: { work: externalDefinition },
    [CLAUDE_DISABLED_MCP_SERVERS_KEY]: { work: activeDefinition },
    otherProvider: { keep: { command: "/outside/provider" } },
    otherDisabled: { keep: { command: "/outside/disabled" } },
  });

  expect(setClaudeMcpEnabled(content, "work", true)).toEqual({ ok: true, content });
  const disabled = setClaudeMcpEnabled(content, "work", false);
  expect(disabled.ok).toBe(true);
  if (!disabled.ok) return;
  const disabledRoot = JSON.parse(disabled.content);
  expect(disabledRoot.mcpServers.work).toBeUndefined();
  expect(disabledRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY].work).toEqual(externalDefinition);
  expect(disabledRoot.otherProvider).toEqual({ keep: { command: "/outside/provider" } });
  expect(disabledRoot.otherDisabled).toEqual({ keep: { command: "/outside/disabled" } });

  const reenabled = setClaudeMcpEnabled(disabled.content, "work", true);
  expect(reenabled.ok).toBe(true);
  if (!reenabled.ok) return;
  const reenabledRoot = JSON.parse(reenabled.content);
  expect(reenabledRoot.mcpServers.work).toEqual(externalDefinition);
  expect(reenabledRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY]).toBeUndefined();
  expect(reenabledRoot.otherProvider).toEqual({ keep: { command: "/outside/provider" } });
  expect(reenabledRoot.otherDisabled).toEqual({ keep: { command: "/outside/disabled" } });
});

it("returns non-sensitive failures for invalid config and missing names", () => {
  expect(setClaudeMcpEnabled("not json", "work", false)).toEqual({
    ok: false,
    reason: "invalid-config",
  });
  expect(setClaudeMcpEnabled(JSON.stringify({ mcpServers: [] }), "work", false)).toEqual({
    ok: false,
    reason: "invalid-config",
  });
  expect(setClaudeMcpEnabled(JSON.stringify({ mcpServers: {} }), "work", false)).toEqual({
    ok: false,
    reason: "server-not-found",
  });
  expect(setClaudeMcpEnabled("{}", "  ", true)).toEqual({
    ok: false,
    reason: "invalid-config",
  });
});

it("treats already enabled or disabled definitions idempotently", () => {
  const activeContent = JSON.stringify({ mcpServers: { work: activeDefinition } });
  const disabledContent = JSON.stringify({
    [CLAUDE_DISABLED_MCP_SERVERS_KEY]: { work: activeDefinition },
  });

  expect(setClaudeMcpEnabled(activeContent, "work", true)).toEqual({
    ok: true,
    content: activeContent,
  });
  expect(setClaudeMcpEnabled(disabledContent, "work", false)).toEqual({
    ok: true,
    content: disabledContent,
  });
});

it("moves prototype-sensitive server names as ordinary JSON keys", () => {
  const content =
    '{"mcpServers":{"__proto__":{"type":"stdio","command":"/proto"},"constructor":{"type":"stdio","command":"/constructor"}}}';

  const disabledProto = setClaudeMcpEnabled(content, "__proto__", false);
  expect(disabledProto.ok).toBe(true);
  if (!disabledProto.ok) return;
  const protoRoot = JSON.parse(disabledProto.content);
  expect(Object.hasOwn(protoRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY], "__proto__")).toBe(true);
  expect(protoRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY]["__proto__"]).toEqual({
    type: "stdio",
    command: "/proto",
  });
  expect(readClaudeMcpServers(protoRoot)).toContainEqual({ name: "__proto__", enabled: false });

  const reenabledProto = setClaudeMcpEnabled(disabledProto.content, "__proto__", true);
  expect(reenabledProto.ok).toBe(true);
  if (!reenabledProto.ok) return;
  const reenabledRoot = JSON.parse(reenabledProto.content);
  expect(Object.hasOwn(reenabledRoot.mcpServers, "__proto__")).toBe(true);
  expect(reenabledRoot.mcpServers["__proto__"].command).toBe("/proto");

  const disabledConstructor = setClaudeMcpEnabled(content, "constructor", false);
  expect(disabledConstructor.ok).toBe(true);
  if (!disabledConstructor.ok) return;
  const constructorRoot = JSON.parse(disabledConstructor.content);
  expect(Object.hasOwn(constructorRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY], "constructor")).toBe(true);
  expect(constructorRoot[CLAUDE_DISABLED_MCP_SERVERS_KEY].constructor.command).toBe("/constructor");
});
