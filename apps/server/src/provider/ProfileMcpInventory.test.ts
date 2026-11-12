import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readProfileMcpInventory } from "./ProfileMcpInventory.ts";

it.effect("projects profile MCP inventory to names and enabled booleans only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-" });
    const codex = path.join(root, "work", "codex");
    const claude = path.join(root, "work", "claude");
    yield* fs.makeDirectory(codex, { recursive: true });
    yield* fs.makeDirectory(claude, { recursive: true });
    yield* fs.writeFileString(
      path.join(codex, "config.toml"),
      '[mcp_servers."build-helper"]\ncommand = "/secret/bin/runner"\nenabled = false\nenv = { API_TOKEN = "codex-secret-value" }\n',
    );
    yield* fs.writeFileString(
      path.join(claude, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "docs-search": {
            command: "/secret/claude-command",
            args: ["--token", "claude-secret-value"],
            env: { API_KEY: "another-secret-value" },
          },
        },
      }),
    );

    const result = yield* readProfileMcpInventory({ scope: "work" }, root);
    assert.deepEqual(result, {
      scope: "work",
      codex: { status: "configured", servers: [{ name: "build-helper", enabled: false }] },
      claude: { status: "configured", servers: [{ name: "docs-search", enabled: true }] },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "/secret/bin/runner",
      "codex-secret-value",
      "/secret/claude-command",
      "claude-secret-value",
      "another-secret-value",
    ])
      assert.isFalse(serialized.includes(secret));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports missing and malformed profile files without returning their contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-" });
    const codex = path.join(root, "personal", "codex");
    const claude = path.join(root, "personal", "claude");
    yield* fs.makeDirectory(codex, { recursive: true });
    yield* fs.makeDirectory(claude, { recursive: true });
    yield* fs.writeFileString(path.join(codex, "config.toml"), "mcp_servers = [");
    yield* fs.writeFileString(path.join(claude, ".claude.json"), '{"mcpServers":');

    assert.deepEqual(yield* readProfileMcpInventory({ scope: "personal" }, root), {
      scope: "personal",
      codex: { status: "parse_error", servers: [] },
      claude: { status: "parse_error", servers: [] },
    });
    assert.deepEqual(yield* readProfileMcpInventory({ scope: "work" }, root), {
      scope: "work",
      codex: { status: "missing", servers: [] },
      claude: { status: "missing", servers: [] },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
