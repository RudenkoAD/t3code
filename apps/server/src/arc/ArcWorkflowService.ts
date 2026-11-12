import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import {
  GitRunStackedActionResult,
  ArcActionInputError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type ArcRunActionInput,
  type ArcWorkflowError,
  type GitActionProgressEvent,
} from "@t3tools/contracts";

import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { parseArcPullRequest } from "../vcs/ArcVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

type ArcProgressPayload = GitActionProgressEvent extends infer Event
  ? Event extends GitActionProgressEvent
    ? Omit<Event, "actionId" | "cwd" | "action">
    : never
  : never;

export interface ArcActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void>;
}

export class ArcWorkflowService extends Context.Service<
  ArcWorkflowService,
  {
    readonly runAction: (
      input: ArcRunActionInput,
      options?: { readonly progressReporter?: ArcActionProgressReporter },
    ) => Effect.Effect<GitRunStackedActionResult, ArcWorkflowError>;
  }
>()("t3/arc/ArcWorkflowService") {}

const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runArc = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    readonly allowNonZeroExit?: boolean;
  }) =>
    process.run({
      command: "arc",
      operation: `ArcWorkflowService.${input.operation}`,
      cwd: input.cwd,
      args: input.args,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.allowNonZeroExit === undefined ? {} : { allowNonZeroExit: input.allowNonZeroExit }),
    });

  const canonicalPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  const failAction = (cwd: string, detail: string) =>
    Effect.fail(new ArcActionInputError({ operation: "runAction", cwd, detail }));

  const runAction: ArcWorkflowService["Service"]["runAction"] = Effect.fn(
    "ArcWorkflowService.runAction",
  )(function* (input, options) {
    const handle = yield* registry.resolve({ cwd: input.cwd, requestedKind: "arc" });
    if (handle.kind !== "arc") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ArcWorkflowService.runAction",
        kind: handle.kind,
        detail: "Arc actions require an Arcadia working copy.",
      });
    }
    const rootPath = yield* canonicalPath(handle.repository.rootPath);
    const cwd = yield* canonicalPath(input.cwd);
    const withinRepository = path.relative(rootPath, cwd);
    if (withinRepository.startsWith("..") || path.isAbsolute(withinRepository)) {
      return yield* failAction(
        input.cwd,
        "The selected workspace is outside the Arc working copy.",
      );
    }
    const sharedRoot = yield* canonicalPath(path.join(NodeOS.homedir(), "arcadia"));
    if (rootPath === sharedRoot) {
      return yield* failAction(
        input.cwd,
        "The shared ~/arcadia checkout is read-only. Open your personal Arc work mount to make changes.",
      );
    }
    const run = Effect.gen(function* () {
      const [branchInfo, mountInfo] = yield* Effect.all([
        runArc({ cwd: input.cwd, operation: "readBranch", args: ["info", "--json"] }),
        runArc({
          cwd: input.cwd,
          operation: "readDefaultBranch",
          args: ["info", "--json", "--mount"],
        }),
      ]);
      const branch = jsonString(branchInfo.stdout, "branch");
      const defaultBranch = jsonString(mountInfo.stdout, "default_branch");
      if (!branch || !defaultBranch) {
        return yield* failAction(
          input.cwd,
          "Could not verify the current Arc branch before making changes.",
        );
      }
      if (branch === defaultBranch) {
        return yield* failAction(
          input.cwd,
          `The ${defaultBranch} branch is read-only. Switch to a task branch or open a personal Arc work mount.`,
        );
      }
      if (input.featureBranch) {
        return yield* failAction(
          input.cwd,
          "Feature-branch generation is not supported for Arc actions yet.",
        );
      }

      const emit = (event: ArcProgressPayload) =>
        options?.progressReporter?.publish({
          ...event,
          actionId: input.actionId,
          cwd: input.cwd,
          action: input.action,
        } as GitActionProgressEvent) ?? Effect.void;
      const wantsCommit =
        input.action === "commit" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr";
      const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";
      const wantsPush =
        input.action === "push" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr";
      const phases = [
        ...(wantsCommit ? (["commit"] as const) : []),
        ...(wantsPush ? (["push"] as const) : []),
        ...(wantsPr ? (["pr"] as const) : []),
      ];
      yield* emit({ kind: "action_started", phases });

      let commitStatus: GitRunStackedActionResult["commit"] = {
        status: wantsCommit ? "skipped_no_changes" : "skipped_not_requested",
      };
      let pushStatus: GitRunStackedActionResult["push"] = {
        status: wantsPush ? "skipped_up_to_date" : "skipped_not_requested",
      };
      let prStatus: GitRunStackedActionResult["pr"] = { status: "skipped_not_requested" };

      if (wantsCommit) {
        yield* emit({ kind: "phase_started", phase: "commit", label: "Committing with Arc..." });
        const commitMessage = input.commitMessage?.trim();
        if (!commitMessage) {
          return yield* failAction(input.cwd, "Enter a commit message before committing with Arc.");
        }
        const projectScope = path.relative(rootPath, cwd);
        let commitPaths: ReadonlyArray<string>;
        let commitCwd = input.cwd;
        if (input.filePaths?.length) {
          if (
            input.filePaths.some((filePath) => {
              if (path.isAbsolute(filePath)) return true;
              const relative = path.relative(cwd, path.resolve(cwd, filePath));
              return (
                relative === ".." ||
                relative.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relative)
              );
            })
          ) {
            return yield* failAction(
              input.cwd,
              "Selected paths must stay inside the opened Arc workspace.",
            );
          }
          commitPaths = input.filePaths.map((filePath) =>
            path.relative(cwd, path.resolve(cwd, filePath)),
          );
          yield* runArc({
            cwd: input.cwd,
            operation: "stage",
            args: ["add", "--", ...commitPaths],
          });
        } else {
          if (!projectScope || projectScope === ".") {
            return yield* failAction(
              input.cwd,
              "Open an Arc project subdirectory or select specific files before committing.",
            );
          }
          commitPaths = [projectScope];
          commitCwd = rootPath;
          yield* runArc({
            cwd: rootPath,
            operation: "stage",
            args: ["add", "--all", "--", projectScope],
          });
        }
        const committed = yield* runArc({
          cwd: commitCwd,
          operation: "commit",
          args: ["commit", "--message", commitMessage, "--", ...commitPaths],
          timeoutMs: 120_000,
        });
        const subject = committed.stdout.trim().split("\n").at(-1)?.trim();
        commitStatus = {
          status: "created",
          ...(subject ? { subject: subject.slice(0, 500) } : {}),
        };
      }

      if (wantsPush && !wantsPr) {
        yield* emit({ kind: "phase_started", phase: "push", label: "Pushing with Arc..." });
        yield* runArc({ cwd: input.cwd, operation: "push", args: ["push"], timeoutMs: 120_000 });
        pushStatus = { status: "pushed" };
      }

      if (wantsPr) {
        yield* emit({ kind: "phase_started", phase: "pr", label: "Creating Arcanum review..." });
        const previous = yield* runArc({
          cwd: input.cwd,
          operation: "readPullRequest",
          args: ["pr", "status", "--json"],
          allowNonZeroExit: true,
        });
        if (previous.exitCode !== 0 && previous.exitCode !== 1) {
          return yield* new VcsProcessExitError({
            operation: "ArcWorkflowService.readPullRequest",
            command: "arc pr status --json",
            cwd: input.cwd,
            exitCode: previous.exitCode ?? 1,
            detail: "Could not check for an existing Arcanum review.",
            stderrLength: previous.stderr.length,
            stderrTruncated: previous.stderrTruncated,
          });
        }
        let detail = previous.exitCode === 0 ? parsePullRequestOutput(previous.stdout) : {};
        if (previous.exitCode === 0 && !detail.url) {
          return yield* failAction(
            input.cwd,
            "Arc reported a current review, but its details could not be read safely; no duplicate review was created.",
          );
        }
        const existing =
          Boolean(detail.url) && (detail.state === undefined || detail.state === "open");
        if (existing) {
          if (wantsPush) {
            yield* emit({
              kind: "phase_started",
              phase: "push",
              label: "Updating Arcanum review...",
            });
            yield* runArc({
              cwd: input.cwd,
              operation: "push",
              args: ["push"],
              timeoutMs: 120_000,
            });
            pushStatus = { status: "pushed" };
          }
        } else {
          const args = ["pr", "create", "--json", "--no-edit"];
          if (input.commitMessage?.trim()) args.push("--message", input.commitMessage.trim());
          const created = yield* runArc({
            cwd: input.cwd,
            operation: "createPullRequest",
            args,
            timeoutMs: 120_000,
          });
          detail = parsePullRequestOutput(created.stdout, true);
          pushStatus = { status: "pushed" };
        }
        prStatus = {
          status: existing ? "opened_existing" : "created",
          ...(detail.url ? { url: detail.url } : {}),
          ...(detail.number === undefined ? {} : { number: detail.number }),
          ...(detail.baseBranch ? { baseBranch: detail.baseBranch } : {}),
          ...(detail.headBranch ? { headBranch: detail.headBranch } : {}),
          ...(detail.title ? { title: detail.title } : {}),
        };
      }

      const result = {
        action: input.action,
        branch: { status: "skipped_not_requested" as const },
        commit: commitStatus,
        push: pushStatus,
        pr: prStatus,
        toast: {
          title: wantsPr
            ? prStatus.status === "opened_existing"
              ? "Arcanum review ready"
              : "Arcanum review created"
            : wantsPush
              ? "Arc changes pushed"
              : "Arc commit created",
          cta: prStatus.url
            ? { kind: "open_pr" as const, label: "Open review", url: prStatus.url }
            : { kind: "none" as const },
        },
      } satisfies GitRunStackedActionResult;
      yield* emit({ kind: "action_finished", result });
      return result;
    });

    return yield* withWorkspaceLease(handle.repository.rootPath, run);
  });

  return ArcWorkflowService.of({ runAction });
});

function parsePullRequestOutput(
  output: string,
  assumeOpen = false,
): {
  readonly url?: string;
  readonly number?: number;
  readonly baseBranch?: string;
  readonly headBranch?: string;
  readonly title?: string;
  readonly state?: "open" | "closed" | "merged";
} {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    const url = output.match(/https?:\/\/[^\s"']+/)?.[0];
    return url ? { url } : {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  const review = object.pull_request ?? object.pr ?? object;
  const normalized =
    assumeOpen && typeof review === "object" && review !== null && !Array.isArray(review)
      ? {
          ...(review as Record<string, unknown>),
          status: (review as Record<string, unknown>).status ?? "open",
        }
      : review;
  const pr = parseArcPullRequest(normalized);
  return pr
    ? {
        url: pr.url,
        number: pr.number,
        baseBranch: pr.baseRef,
        headBranch: pr.headRef,
        title: pr.title,
        state: pr.state,
      }
    : {};
}

function jsonString(output: string, key: string): string | null {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" && field.length > 0 ? field : null;
  } catch {
    return null;
  }
}

export const layer = Layer.effect(ArcWorkflowService, make);
