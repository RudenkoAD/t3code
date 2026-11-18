import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("routes branch and status reads from an Arc project without invoking Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-arc-routing-" });
      const cwd = path.join(root, "project");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(path.join(root, ".arcadia.root"), "");
      const commands: string[] = [];
      const processLayer = Layer.mock(VcsProcess.VcsProcess)({
        run: ({ command, args }) =>
          Effect.sync(() => {
            commands.push(command);
            assert.equal(command, "arc");
            const output =
              args[0] === "status"
                ? {
                    branch_info: { local: { name: "work" } },
                    status: { changed: [{ path: "project/readme" }] },
                  }
                : args[0] === "pr"
                  ? {
                      id: 42,
                      summary: "Update readme",
                      status: "open",
                      url: "https://example.org/review/42",
                      from_branch: "work",
                      to_branch: "trunk",
                    }
                  : args[0] === "branch"
                    ? [{ local: true, current: true, name: "work" }]
                    : {
                        branch: "work",
                        default_branch: "trunk",
                        repository: "repo",
                        mount_id: "mount",
                      };
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify(output),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });
      const layer = GitWorkflowService.layer.pipe(
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make)),
        Layer.provide(
          Layer.mock(VcsProjectConfig.VcsProjectConfig)({
            resolveKind: () => Effect.succeed("auto"),
          }),
        ),
        Layer.provide(processLayer),
      );
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const local = yield* workflow.localStatus({ cwd });
        assert.equal(local.vcsKind, "arc");
        assert.equal(local.hasWorkingTreeChanges, true);
        assert.equal(yield* workflow.currentBranch(cwd), "work");
        assert.equal((yield* workflow.remoteStatus({ cwd }))?.pr?.number, 42);
        assert.equal((yield* workflow.listRefs({ cwd })).refs[0]?.name, "work");
        const before = commands.length;
        assert.equal(
          (yield* Effect.flip(workflow.createWorktree({ cwd, refName: "work", path: null })))._tag,
          "GitCommandError",
        );
        assert.equal(commands.length, before);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
