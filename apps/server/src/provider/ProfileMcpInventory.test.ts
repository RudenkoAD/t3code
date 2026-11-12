import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ProfileMcpServerToggleError } from "@t3tools/contracts";
import { readProfileMcpInventory, setProfileMcpServerEnabled } from "./ProfileMcpInventory.ts";

const createProviderHome = Effect.fn(function* (
  root: string,
  scope: "work" | "personal",
  provider: "codex" | "claude",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(root, scope, provider);
  yield* fs.makeDirectory(home, { recursive: true });
  return home;
});

const writeCodexConfig = Effect.fn(function* (
  root: string,
  scope: "work" | "personal",
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* createProviderHome(root, scope, "codex");
  const filePath = path.join(home, "config.toml");
  yield* fs.writeFileString(filePath, content);
  return filePath;
});

const writeClaudeConfig = Effect.fn(function* (
  root: string,
  scope: "work" | "personal",
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* createProviderHome(root, scope, "claude");
  const filePath = path.join(home, ".claude.json");
  yield* fs.writeFileString(filePath, content);
  return filePath;
});

const codexEntry = (id: string, enabled = true) =>
  `[mcp_servers."${id}"]\ncommand = "node"\nenabled = ${enabled}\n`;

const claudeConfig = (id: string, enabled = true) =>
  JSON.stringify(enabled ? { mcpServers: { [id]: { command: "node" } } } : {});

const toggle = (
  root: string,
  scope: "work" | "personal",
  provider: "codex" | "claude",
  name: string,
  enabled: boolean,
) => setProfileMcpServerEnabled({ scope, provider, name, enabled }, root);

const expectToggleError = Effect.fn(function* (
  effect: Effect.Effect<unknown, ProfileMcpServerToggleError, FileSystem.FileSystem | Path.Path>,
  reason: ProfileMcpServerToggleError["reason"],
) {
  const result = yield* Effect.result(effect);
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) {
    assert.instanceOf(result.failure, ProfileMcpServerToggleError);
    assert.equal(result.failure.reason, reason);
  }
});

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
      '[mcp_servers."build-helper"]\ncommand = "/secret/bin/runner"\nenabled = false\nenv = { API_TOKEN = "codex-secret-value" }\n\n[mcp_servers."disabled-field-only"]\ncommand = "node"\ndisabled = true\n',
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
      codex: {
        status: "configured",
        servers: [
          { name: "build-helper", enabled: false },
          { name: "disabled-field-only", enabled: true },
        ],
      },
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

it.effect("persists identical server IDs independently by profile and provider", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-isolation-" });
    yield* writeCodexConfig(root, "work", codexEntry("shared-server"));
    yield* writeCodexConfig(root, "personal", codexEntry("shared-server"));
    yield* writeClaudeConfig(root, "work", claudeConfig("shared-server"));
    yield* writeClaudeConfig(root, "personal", claudeConfig("shared-server"));

    const result = yield* toggle(root, "work", "codex", "shared-server", false);
    assert.deepEqual(result.codex.servers, [{ name: "shared-server", enabled: false }]);
    assert.deepEqual(result.claude.servers, [{ name: "shared-server", enabled: true }]);

    const personal = yield* readProfileMcpInventory({ scope: "personal" }, root);
    assert.deepEqual(personal.codex.servers, [{ name: "shared-server", enabled: true }]);
    assert.deepEqual(personal.claude.servers, [{ name: "shared-server", enabled: true }]);
    const workCodex = yield* fs.readFileString(path.join(root, "work", "codex", "config.toml"));
    const personalCodex = yield* fs.readFileString(
      path.join(root, "personal", "codex", "config.toml"),
    );
    assert.include(workCodex, "enabled = false");
    assert.include(personalCodex, "enabled = true");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serializes concurrent T3 updates without losing either change", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-concurrent-" });
    yield* writeCodexConfig(
      root,
      "work",
      `${codexEntry("first-server")}\n${codexEntry("second-server")}`,
    );

    yield* Effect.all(
      [
        toggle(root, "work", "codex", "first-server", false),
        toggle(root, "work", "codex", "second-server", false),
      ],
      { concurrency: 2 },
    );
    const final = yield* readProfileMcpInventory({ scope: "work" }, root);
    assert.deepEqual(final.codex.servers, [
      { name: "first-server", enabled: false },
      { name: "second-server", enabled: false },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("writes the staged provider config with owner-only permissions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-mode-" });
    const filePath = yield* writeCodexConfig(root, "work", codexEntry("docs-server"));
    yield* fs.chmod(filePath, 0o644);

    yield* toggle(root, "work", "codex", "docs-server", false);

    assert.equal((yield* fs.stat(filePath)).mode & 0o777, 0o600);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses external config links and leaves external contents unchanged", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-link-file-" });
    const external = path.join(root, "outside", "config.toml");
    const codexHome = yield* createProviderHome(root, "work", "codex");
    yield* fs.makeDirectory(path.dirname(external), { recursive: true });
    yield* fs.writeFileString(external, codexEntry("docs-server"));
    yield* fs.symlink(external, path.join(codexHome, "config.toml"));

    yield* expectToggleError(toggle(root, "work", "codex", "docs-server", false), "linked_config");
    assert.equal(yield* fs.readFileString(external), codexEntry("docs-server"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a linked provider home without touching the other profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-link-home-" });
    const externalHome = path.join(root, "external", "codex-home");
    yield* fs.makeDirectory(externalHome, { recursive: true });
    const externalConfig = path.join(externalHome, "config.toml");
    yield* fs.writeFileString(externalConfig, codexEntry("docs-server"));
    yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });
    yield* fs.symlink(externalHome, path.join(root, "work", "codex"));
    yield* writeCodexConfig(root, "personal", codexEntry("docs-server"));

    yield* expectToggleError(toggle(root, "work", "codex", "docs-server", false), "linked_config");
    const personal = yield* readProfileMcpInventory({ scope: "personal" }, root);
    assert.deepEqual(personal.codex.servers, [{ name: "docs-server", enabled: true }]);
    assert.equal(yield* fs.readFileString(externalConfig), codexEntry("docs-server"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves a concurrent native edit and cleans up the failed T3 write", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-conflict-" });
    const config = yield* writeCodexConfig(root, "work", codexEntry("shared"));
    const nativeEdit = codexEntry("shared") + codexEntry("added-with-cli");
    const update = toggle(root, "work", "codex", "shared", false).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (stage, content, opts) =>
          fs
            .writeFileString(stage, content, opts)
            .pipe(Effect.andThen(fs.writeFileString(config, nativeEdit))),
      }),
    );
    yield* expectToggleError(update, "conflict");
    assert.equal(yield* fs.readFileString(config), nativeEdit);
    assert.deepEqual(yield* fs.readDirectory(path.dirname(config)), ["config.toml"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails closed for read-only, missing, and invalid configurations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profile-mcp-invalid-" });
    const readonlyConfig = yield* writeCodexConfig(root, "work", codexEntry("readonly-server"));
    yield* writeClaudeConfig(
      root,
      "work",
      JSON.stringify({ mcpServers: { "claude-server": { command: "node" } } }),
    );
    yield* writeCodexConfig(root, "personal", "mcp_servers = [\n");
    yield* fs.chmod(readonlyConfig, 0o444);

    yield* expectToggleError(
      toggle(root, "work", "codex", "not-configured", false),
      "missing_server",
    );
    yield* expectToggleError(
      toggle(root, "personal", "codex", "readonly-server", false),
      "invalid_config",
    );
    yield* expectToggleError(
      toggle(root, "work", "codex", "readonly-server", false),
      "write_failed",
    );
    yield* expectToggleError(
      toggle(root, "work", "claude", "missing-claude", false),
      "missing_server",
    );

    assert.include(yield* fs.readFileString(readonlyConfig), "enabled = true");
  }).pipe(Effect.provide(NodeServices.layer)),
);
