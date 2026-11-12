import { assert, it } from "@effect/vitest";
import * as TOML from "smol-toml";

import { setCodexMcpEnabled } from "./profileCodexMcpConfig.ts";

const updated = (content: string, name: string, enabled: boolean) => {
  const result = setCodexMcpEnabled(content, name, enabled);
  assert.isTrue(result.ok, JSON.stringify(result));
  return result.content;
};

const record = (value: unknown) => value as Record<string, unknown>;

it("changes a quoted server table and preserves comments, env, and other settings", () => {
  const source = `# retain this comment
model = "gpt-5-codex"
approval_policy = "never"
last_updated = 1979-05-27T07:32:00Z
[mcp_servers."build.helper"]
command = "/private/tool"
enabled = false # preserve trailing comment
[mcp_servers."build.helper".env]
TOKEN = "secret-value"
FLAG = true
NESTED = "unchanged"
[mcp_servers.other]
enabled = false
command = "other"
`;
  const result = updated(source, "build.helper", true);
  assert.include(result, "# retain this comment");
  assert.include(result, `enabled = true # preserve trailing comment`);
  assert.include(result, `NESTED = "unchanged"`);
  assert.include(result, `[mcp_servers.other]\nenabled = false`);
  const parsed = record(TOML.parse(result));
  const server = record(record(parsed.mcp_servers)["build.helper"]);
  const env = record(server.env);
  assert.equal(parsed.model, "gpt-5-codex");
  assert.equal((parsed.last_updated as Date).toISOString(), "1979-05-27T07:32:00.000Z");
  assert.equal(env.TOKEN, "secret-value");
  assert.equal(env.FLAG, true);
});

it("edits inline and dotted server layouts, including quoted dotted names", () => {
  const inline = `model = "gpt-5-codex"
mcp_servers = { "foo.bar" = { command = "tool", enabled = false, env = { TOKEN = "keep" } }, other = { enabled = true } }
`;
  const inlineResult = updated(inline, "foo.bar", true);
  assert.include(
    inlineResult,
    `"foo.bar" = { command = "tool", enabled = true, env = { TOKEN = "keep" } }`,
  );
  assert.deepEqual(record(record(record(TOML.parse(inlineResult)).mcp_servers).other), {
    enabled: true,
  });

  const dotted = `mcp_servers."foo.bar".enabled = false # keep this
mcp_servers."foo.bar".command = "tool"
other = { preserved = 7 }
`;
  const dottedResult = updated(dotted, "foo.bar", true);
  assert.include(dottedResult, `mcp_servers."foo.bar".enabled = true # keep this`);
  assert.deepEqual(TOML.parse(dottedResult).other, { preserved: 7 });
});

it("adds a missing enabled key before nested tables and is idempotent", () => {
  const source = `[mcp_servers.helper.env]
TOKEN = "keep"
`;
  const first = updated(source, "helper", false);
  assert.equal(
    first,
    `[mcp_servers."helper"]\nenabled = false\n\n[mcp_servers.helper.env]\nTOKEN = "keep"\n`,
  );
  assert.equal(updated(first, "helper", false), first);
  assert.deepEqual(record(record(record(TOML.parse(first)).mcp_servers).helper), {
    enabled: false,
    env: { TOKEN: "keep" },
  });

  const inline = `mcp_servers = { helper = { command = "tool", } }\n`;
  const inlineEnabled = updated(inline, "helper", false);
  assert.equal(record(record(record(TOML.parse(inlineEnabled)).mcp_servers).helper).enabled, false);
});

it("preserves escaped quoted names and a missing final newline", () => {
  const serverName = 'escaped"name';
  const source = `[mcp_servers."escaped\\"name"]\ncommand = "tool"\nenabled = false # keep final comment`;
  const result = updated(source, serverName, true);
  assert.isFalse(result.endsWith("\n"));
  assert.include(result, `enabled = true # keep final comment`);
  const server = record(record(record(TOML.parse(result)).mcp_servers)[serverName]);
  assert.equal(server.enabled, true);
  assert.equal(server.command, "tool");
});

it("adds a missing field to a multiline table without adding a final newline", () => {
  const source = `[mcp_servers."server.with.dot"]\ncommand = "tool"`;
  const result = updated(source, "server.with.dot", false);
  assert.isFalse(result.endsWith("\n"));
  assert.include(result, `enabled = false`);
  const server = record(record(record(TOML.parse(result)).mcp_servers)["server.with.dot"]);
  assert.equal(server.enabled, false);
  assert.equal(server.command, "tool");
});

it("does not create unknown servers and rejects invalid config without exposing its content", () => {
  assert.deepEqual(
    setCodexMcpEnabled(`mcp_servers = { configured = { command = "x" } }`, "missing", true),
    {
      ok: false,
      reason: "server-not-found",
    },
  );
  assert.deepEqual(setCodexMcpEnabled(`mcp_servers = [`, "anything", true), {
    ok: false,
    reason: "invalid-config",
  });
  assert.deepEqual(setCodexMcpEnabled(`mcp_servers.server.enabled = "yes"`, "server", true), {
    ok: false,
    reason: "invalid-config",
  });
  assert.deepEqual(setCodexMcpEnabled(`model = "gpt-5-codex"`, "server", true), {
    ok: false,
    reason: "server-not-found",
  });
});
