import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const codexProbeCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../provider/CodexProvider.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../provider/CodexProvider.ts")>();
  const Effect = await import("effect/Effect");
  return {
    ...original,
    probeCodexSkillsForCwd: (input: Record<string, unknown>) => {
      codexProbeCalls.push(input);
      return Effect.succeed([{ name: "signed-out-skill", scope: "repo", enabled: true }]);
    },
  };
});

import { readProjectToolsInventory } from "./ProjectToolsInventory.ts";

it.effect("includes trusted native project MCP names without exposing definitions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-tools-inventory-" });
    const workspaceRoot = path.join(root, "workspace");
    const profileHomeDirectory = path.join(root, "profiles");
    const codexHome = path.join(profileHomeDirectory, "work", "codex");
    const claudeHome = path.join(profileHomeDirectory, "work", "claude");
    yield* fs.makeDirectory(path.join(workspaceRoot, ".codex"), { recursive: true });
    yield* fs.makeDirectory(codexHome, { recursive: true });
    yield* fs.makeDirectory(claudeHome, { recursive: true });
    yield* fs.writeFileString(
      path.join(codexHome, "config.toml"),
      `[projects."${workspaceRoot}"]\ntrust_level = "trusted"\n[mcp_servers.profile-codex]\ncommand = "secret-profile-command"\n`,
    );
    yield* fs.writeFileString(
      path.join(workspaceRoot, ".codex", "config.toml"),
      `[mcp_servers.project-codex]\ncommand = "secret-project-command"\n`,
    );
    yield* fs.writeFileString(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [workspaceRoot]: {
            hasTrustDialogAccepted: true,
            mcpServers: { profileProjectClaude: { command: "secret-claude-command" } },
          },
        },
        mcpServers: { profileClaude: { command: "secret-profile-claude-command" } },
      }),
    );
    yield* fs.writeFileString(
      path.join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          enabledLocalClaude: { command: "secret-enabled-command" },
          disabledLocalClaude: { command: "secret-disabled-command" },
          unapprovedLocalClaude: { command: "secret-unapproved-command" },
        },
      }),
    );
    yield* fs.writeFileString(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    yield* fs.makeDirectory(path.join(workspaceRoot, ".claude"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workspaceRoot, ".claude", "settings.json"),
      JSON.stringify({
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: ["enabledLocalClaude"],
        disabledMcpjsonServers: ["disabledLocalClaude"],
      }),
    );
    yield* fs.writeFileString(
      path.join(workspaceRoot, ".claude", "settings.local.json"),
      JSON.stringify({ disabledMcpjsonServers: ["enabledLocalClaude"] }),
    );

    const settings = DEFAULT_SERVER_SETTINGS;
    const providerInstanceRegistry = {
      getInstance: (instanceId: string) =>
        Effect.succeed({
          snapshot: { auth: { status: "authenticated" } },
          snapshotForCwd: () =>
            Effect.succeed({
              skills: instanceId.endsWith("_codex")
                ? [
                    { name: "codex-skill", scope: "repo", enabled: true },
                    { name: "shared-skill", scope: "user", enabled: false },
                    { name: "shared-skill", scope: "repo", enabled: true },
                  ]
                : [{ name: "claude-skill", scope: "project", enabled: true }],
            }),
        }),
    };
    const inventory = yield* readProjectToolsInventory({
      projectId: "project-test" as never,
      profile: "work",
      workspaceRoot,
      profileHomeDirectory,
      settings,
      codexAuthStatus: "authenticated",
      providerInstanceRegistry: providerInstanceRegistry as never,
    });
    assert.deepEqual(
      inventory.mcpServers
        .map(({ name, provider, source, enabled }) => ({ name, provider, source, enabled }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: "disabledLocalClaude", provider: "claude", source: "project", enabled: false },
        { name: "enabledLocalClaude", provider: "claude", source: "project", enabled: false },
        { name: "profile-codex", provider: "codex", source: "profile", enabled: true },
        { name: "profileClaude", provider: "claude", source: "profile", enabled: true },
        { name: "profileProjectClaude", provider: "claude", source: "project", enabled: true },
        { name: "project-codex", provider: "codex", source: "project", enabled: true },
        { name: "unapprovedLocalClaude", provider: "claude", source: "project", enabled: false },
      ],
    );
    assert.equal(JSON.stringify(inventory).includes("secret-"), false);
    assert.equal(inventory.skills.length, 3);
    assert.deepEqual(
      inventory.skills.filter((skill) => skill.name === "shared-skill"),
      [{ name: "shared-skill", provider: "codex", source: "project", enabled: true }],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("uses the profile-scoped Codex skills/list fallback when signed out", () =>
  Effect.gen(function* () {
    codexProbeCalls.length = 0;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-tools-signed-out-" });
    const workspaceRoot = path.join(root, "workspace");
    const profileHomeDirectory = path.join(root, "profiles");
    const providerInstanceRegistry = {
      getInstance: () => Effect.succeed({ snapshotForCwd: () => Effect.succeed({ skills: [] }) }),
    };
    const inventory = yield* readProjectToolsInventory({
      projectId: "project-signed-out" as never,
      profile: "personal",
      workspaceRoot,
      profileHomeDirectory,
      settings: DEFAULT_SERVER_SETTINGS,
      codexAuthStatus: "unauthenticated",
      providerInstanceRegistry: providerInstanceRegistry as never,
    });
    assert.deepEqual(codexProbeCalls, [
      {
        binaryPath: "codex",
        homePath: path.join(profileHomeDirectory, "personal", "codex"),
        cwd: workspaceRoot,
      },
    ]);
    assert.deepEqual(
      inventory.skills.filter((skill) => skill.name === "signed-out-skill"),
      [{ name: "signed-out-skill", provider: "codex", source: "project", enabled: true }],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
