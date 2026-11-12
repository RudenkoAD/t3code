import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  readonly gitWorktrees?: ReadonlyArray<string>;
  readonly arcDiffs?: { readonly workingTree: string; readonly branchRange: string };
  readonly arcRootPath?: string;
  readonly arcCommands?: Array<{
    readonly args: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
    readonly appendTruncationMarker?: boolean;
  }>;
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: (kind) =>
          kind === "arc" && input.arcDiffs !== undefined
            ? Effect.succeed({
                execute: (command: Omit<VcsProcess.VcsProcessInput, "command">) => {
                  input.arcCommands?.push({
                    args: command.args,
                    ...(command.maxOutputBytes === undefined
                      ? {}
                      : { maxOutputBytes: command.maxOutputBytes }),
                    ...(command.appendTruncationMarker === undefined
                      ? {}
                      : { appendTruncationMarker: command.appendTruncationMarker }),
                  });
                  const isInfo = command.args[0] === "info";
                  const branchRange = command.args.includes("-B");
                  return Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: isInfo
                      ? command.args.includes("--mount")
                        ? '{"default_branch":"trunk"}'
                        : '{"branch":"users/test/arc-review"}'
                      : branchRange
                        ? input.arcDiffs!.branchRange
                        : input.arcDiffs!.workingTree,
                    stderr: "",
                    stdoutTruncated: !isInfo && branchRange,
                    stderrTruncated: false,
                  });
                },
              } as unknown as VcsDriverRegistry.VcsDriverHandle["driver"])
            : Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            if (!input.arcDiffs) return null;
            return {
              kind: "arc",
              repository: {
                kind: "arc",
                rootPath: input.arcRootPath ?? input.workspaceRoot,
                metadataPath: null,
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-11-12T00:00:00.000Z"),
                  expiresAt: { _tag: "None" },
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            } as unknown as VcsDriverRegistry.VcsDriverHandle;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                { worktreePath: "t3-review-relative" },
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("renders bounded Arc working and branch diffs with file mode and rename metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-arc-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-arc-base-" });
      const cwd = `${workspaceRoot}/quality/offline/project`;
      yield* fs.makeDirectory(cwd, { recursive: true });
      const arcCommands: Array<{
        readonly args: ReadonlyArray<string>;
        readonly maxOutputBytes?: number;
        readonly appendTruncationMarker?: boolean;
      }> = [];
      const workingTree = [
        "diff --git a/mode file.txt b/mode file.txt",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/old-name.txt b/new-name.txt",
        "similarity index 100%",
        "rename from old-name.txt",
        "rename to new-name.txt",
        "diff --git a/src/change.txt b/src/change.txt",
        "index 0000000..1111111 100644",
        "--- a/src/change.txt",
        "+++ b/src/change.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n");
      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({
          cwd,
          metadataOnly: true,
          baseRef: "feature-base",
          ignoreWhitespace: true,
        });
        const filePreview = yield* review.getDiffPreview({
          cwd,
          sourceKind: "working-tree",
          file: {
            path: "quality/offline/project/src/change file.txt",
            previousPath: null,
            sourceKind: "working-tree",
          },
        });
        return { preview, filePreview };
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            arcRootPath: workspaceRoot,
            baseDir,
            arcDiffs: { workingTree, branchRange: workingTree },
            arcCommands,
          }),
        ),
      );

      const working = result.preview.sources.find((source) => source.kind === "working-tree");
      const branch = result.preview.sources.find((source) => source.kind === "branch-range");
      assert.isDefined(working);
      assert.isDefined(branch);
      assert.equal(working.diff, "");
      assert.isTrue(working.patchesDeferred);
      assert.isTrue(working.files?.some((file) => file.path === "mode file.txt"));
      assert.deepEqual(
        working.files?.find((file) => file.path === "new-name.txt"),
        {
          path: "new-name.txt",
          previousPath: "old-name.txt",
          additions: 0,
          deletions: 0,
        },
      );
      assert.deepEqual(
        working.files?.find((file) => file.path === "src/change.txt"),
        {
          path: "src/change.txt",
          previousPath: null,
          additions: 1,
          deletions: 1,
        },
      );
      assert.isTrue(branch.truncated);
      assert.isTrue(result.preview.incomplete);
      assert.isTrue(working.diffHash.length > 0);
      assert.isTrue(
        arcCommands.some(
          (command) =>
            command.args.join(" ") === "diff --git --relative=. -w HEAD --" &&
            command.maxOutputBytes === 120_000 &&
            command.appendTruncationMarker === true,
        ),
      );
      assert.isTrue(
        arcCommands.some(
          (command) =>
            command.args.includes("-B") &&
            command.args.includes("feature-base") &&
            command.args.includes("HEAD") &&
            command.args.includes("-w"),
        ),
      );
      assert.isTrue(
        arcCommands.some(
          (command) =>
            command.args.includes("src/change file.txt") && command.args.includes("--relative=."),
        ),
      );
      assert.equal(result.filePreview.sources.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
