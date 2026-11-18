import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ArcRunActionInput } from "@t3tools/contracts";

import * as ArcWorkflowService from "./ArcWorkflowService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const decodeArcRunActionInput = Schema.decodeSync(ArcRunActionInput);

const output = (stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const makeWorkflowLayer = (
  rootPath: string,
  calls: string[],
  prStatus = "",
  branch = "users/test/arc-work",
) =>
  ArcWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "arc",
            repository: {
              kind: "arc",
              rootPath,
              metadataPath: null,
              freshness: {
                source: "live-local",
                observedAt: DateTime.makeUnsafe("2026-11-12T00:00:00.000Z"),
                expiresAt: { _tag: "None" },
              },
            },
            driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
          } as unknown as VcsDriverRegistry.VcsDriverHandle),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          calls.push(input.args.join(" "));
          if (input.args[0] === "info" && input.args.includes("--mount")) {
            return Effect.succeed(output('{"default_branch":"trunk"}'));
          }
          if (input.args[0] === "info" && input.args[1] === "--json") {
            return Effect.succeed(output(JSON.stringify({ branch })));
          }
          if (input.args[0] === "pr" && input.args[1] === "status") {
            return Effect.succeed(output(prStatus, prStatus ? 0 : 1));
          }
          return Effect.succeed(output(""));
        },
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("keeps shared default branches read-only before staging or push", () => {
  const input = decodeArcRunActionInput({
    actionId: "arc-action-1",
    cwd: "/tmp/arc-workspace",
    action: "commit_push_pr",
    commitMessage: "Implement Arc action",
  });
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-arc-action-" });
    const calls: string[] = [];
    const scopedInput = { ...input, cwd: rootPath };
    const exit = yield* Effect.gen(function* () {
      const workflow = yield* ArcWorkflowService.ArcWorkflowService;
      return yield* Effect.exit(workflow.runAction(scopedInput));
    }).pipe(Effect.provide(makeWorkflowLayer(rootPath, calls, "", "trunk")));

    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(calls.some((call) => /^(add|commit|push|pr)/.test(call)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
});

it.effect("returns existing Arcanum review identity from Arc's real JSON field names", () => {
  const input = decodeArcRunActionInput({
    actionId: "arc-action-2",
    cwd: "/tmp/arc-workspace",
    action: "create_pr",
  });
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-arc-action-" });
    const calls: string[] = [];
    const events: Array<{ readonly kind: string }> = [];
    const scopedInput = { ...input, cwd: rootPath };
    const prStatus = JSON.stringify({
      id: 42,
      url: "https://a.yandex-team.ru/review/42",
      summary: "Arcadia feature",
      status: "open",
      from_branch: "users/test/arc-work",
      to_branch: "trunk",
    });
    const result = yield* Effect.gen(function* () {
      const workflow = yield* ArcWorkflowService.ArcWorkflowService;
      return yield* workflow.runAction(scopedInput, {
        progressReporter: { publish: (event) => Effect.sync(() => events.push(event)) },
      });
    }).pipe(Effect.provide(makeWorkflowLayer(rootPath, calls, prStatus)));

    assert.equal(result.pr.status, "opened_existing");
    assert.equal(result.pr.number, 42);
    assert.equal(result.pr.title, "Arcadia feature");
    assert.equal(result.pr.url, "https://a.yandex-team.ru/review/42");
    assert.equal(result.pr.headBranch, "users/test/arc-work");
    assert.equal(result.pr.baseBranch, "trunk");
    assert.isFalse(calls.some((call) => call.startsWith("push")));
    assert.equal(events.at(-1)?.kind, "action_finished");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
});
