import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as DateTime from "effect/DateTime";

import * as ArcVcsDriver from "./ArcVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const processOutput = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const layer = (calls: Array<{ readonly cwd: string; readonly args: ReadonlyArray<string> }>) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        calls.push({ cwd: input.cwd, args: input.args });
        return Effect.succeed(
          input.args[0] === "status"
            ? processOutput(
                JSON.stringify({
                  branch_info: {
                    local: { name: "users/tester/topic" },
                    remote: { name: "arcadia/trunk" },
                  },
                  status:
                    input.args[1] === "--branch"
                      ? { modified: [{ path: "project/readme.md" }, { path: "other/secret.md" }] }
                      : { modified: [{ path: "project/readme.md" }, { path: "other/secret.md" }] },
                }),
              )
            : processOutput(JSON.stringify({ default_branch: "trunk" })),
        );
      },
    }),
  );

it("projects Arcanum status JSON into the chat PR summary", () => {
  const result = ArcVcsDriver.parseArcPullRequest({
    id: 42,
    url: "https://a.yandex-team.ru/review/42",
    summary: "Update project notes",
    status: "merged",
    from_branch: "users/tester/update-notes",
    to_branch: "trunk",
    updated_at: { seconds: 1700000000, nanos: 0 },
  });

  assert.deepEqual(result, {
    number: 42,
    title: "Update project notes",
    url: "https://a.yandex-team.ru/review/42",
    baseRef: "trunk",
    headRef: "users/tester/update-notes",
    state: "merged",
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(1700000000_000)),
  });
});

it("maps discarded Arc reviews to closed and does not invent incomplete review data", () => {
  assert.equal(
    ArcVcsDriver.parseArcPullRequest({
      id: 12,
      summary: "Changes",
      status: "discarded",
      from_branch: "feature",
      to_branch: "trunk",
    })?.state,
    "closed",
  );
  assert.equal(ArcVcsDriver.parseArcPullRequest({ id: 12, summary: "Changes" }), null);
});

it.effect("keeps local Arc status off the PR network path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rootPath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-arc-status-" });
    yield* fileSystem.writeFileString(`${rootPath}/.arcadia.root`, "");
    const canonicalRoot = yield* fileSystem.realPath(rootPath);
    const projectPath = `${canonicalRoot}/project`;
    yield* fileSystem.makeDirectory(projectPath);
    const calls: Array<{ readonly cwd: string; readonly args: ReadonlyArray<string> }> = [];
    const driver = yield* ArcVcsDriver.make.pipe(Effect.provide(layer(calls)));

    const status = yield* driver.localStatus({ cwd: projectPath });
    assert.equal(status.vcsKind, "arc");
    assert.equal(status.refName, "users/tester/topic");
    assert.equal(status.isDefaultRef, false);
    assert.equal(status.workingTree.rootPath, projectPath);
    assert.deepEqual(
      status.workingTree.files.map((item) => item.path),
      ["readme.md"],
    );
    const statusCall = calls.find((call) => call.args[0] === "status" && call.args[1] === "--json");
    assert.equal(statusCall?.cwd, canonicalRoot);
    assert.deepEqual(statusCall?.args.slice(-2), ["--", "project"]);
    assert.isFalse(calls.some((call) => call.args[0] === "pr"));

    const files = yield* driver.listWorkspaceFiles(projectPath);
    assert.deepEqual(files.paths, ["readme.md"]);
    const listCall = calls.find(
      (call) =>
        call.args[0] === "status" && call.args[1] === "--json" && !call.args.includes("--branch"),
    );
    assert.equal(listCall?.cwd, canonicalRoot);
    assert.deepEqual(listCall?.args.slice(-2), ["--", "project"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
