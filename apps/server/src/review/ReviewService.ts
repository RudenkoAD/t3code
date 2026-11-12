import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileStat,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

const WORKSPACE_BOUND_SUBJECTS = {
  "ReviewService.getBranchCommits": "commit list",
  "ReviewService.getDiffPreview": "diff preview",
  "ReviewService.getDiffFileContents": "diff file contents",
} as const;

const ARC_DIFF_MAX_OUTPUT_BYTES = 120_000;

function parseArcInfoField(output: string, key: string): string | null {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" && field.length > 0 ? field : null;
  } catch {
    return null;
  }
}

function parseArcDiffStats(diff: string): ReadonlyArray<ReviewDiffFileStat> {
  const files = new Map<
    string,
    { path: string; previousPath: string | null; additions: number; deletions: number }
  >();
  let current: {
    path: string;
    previousPath: string | null;
    additions: number;
    deletions: number;
  } | null = null;
  const unquote = (value: string) => {
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    return value;
  };
  const stripPrefix = (value: string, prefix: string) =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      const header = line.slice("diff --git ".length);
      const quoted = header.match(/^((?:"(?:[^"\\]|\\.)+")) ((?:"(?:[^"\\]|\\.)+"))$/u);
      const splitAt = quoted ? -1 : header.lastIndexOf(" b/");
      const newPath = quoted
        ? stripPrefix(unquote(quoted[2]!), "b/")
        : splitAt >= 0
          ? stripPrefix(header.slice(splitAt + 1), "b/")
          : null;
      if (newPath === null) {
        current = null;
        continue;
      }
      current = { path: newPath, previousPath: null, additions: 0, deletions: 0 };
      files.set(newPath, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) {
      current.previousPath = unquote(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = unquote(line.slice("rename to ".length));
      files.delete(
        [...files.entries()].find(([, value]) => value === current)?.[0] ?? current.path,
      );
      files.set(current.path, current);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  return [...files.values()];
}

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: keyof typeof WORKSPACE_BOUND_SUBJECTS,
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: `Review ${WORKSPACE_BOUND_SUBJECTS[operation]} cwd must stay within the configured workspace root.`,
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    if (handle.kind === "arc") {
      if (input.commitSha !== undefined || input.file?.sourceKind === "commit") {
        return yield* new VcsUnsupportedOperationError({
          operation: "ReviewService.getDiffPreview",
          kind: "arc",
          detail: "Arc commit-specific review diffs are not supported yet.",
        });
      }
      if (input.baseRef?.startsWith("-")) {
        return yield* new VcsRepositoryDetectionError({
          operation: "ReviewService.getDiffPreview",
          cwd: input.cwd,
          detail: "The Arc base reference must not start with an option marker.",
        });
      }
      const rawPaths = input.file
        ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])]
        : [];
      const workspacePath = (sourcePath: string) => {
        if (path.isAbsolute(sourcePath)) return null;
        const fromMount = path.relative(
          input.cwd,
          path.resolve(handle.repository.rootPath, sourcePath),
        );
        if (fromMount === "" || (!fromMount.startsWith("..") && !path.isAbsolute(fromMount))) {
          return fromMount || ".";
        }
        const fromWorkspace = path.relative(input.cwd, path.resolve(input.cwd, sourcePath));
        if (
          fromWorkspace === ".." ||
          fromWorkspace.startsWith(`..${path.sep}`) ||
          path.isAbsolute(fromWorkspace)
        ) {
          return null;
        }
        return fromWorkspace;
      };
      const selectedPaths = rawPaths.map(workspacePath);
      if (selectedPaths.some((selectedPath) => selectedPath === null)) {
        return yield* new VcsRepositoryDetectionError({
          operation: "ReviewService.getDiffPreview",
          cwd: input.cwd,
          detail: "Review diff paths must stay inside the opened Arc workspace.",
        });
      }
      const scopedPaths = selectedPaths.filter(
        (selectedPath): selectedPath is string => selectedPath !== null,
      );
      const driver = yield* vcsRegistry.get("arc");
      const [branchResult, mountResult] = yield* Effect.all([
        driver.execute({
          operation: "ReviewService.getDiffPreview.branch",
          cwd: input.cwd,
          args: ["info", "--json"],
          timeoutMs: 20_000,
          maxOutputBytes: 16_384,
        }),
        driver.execute({
          operation: "ReviewService.getDiffPreview.defaultBranch",
          cwd: input.cwd,
          args: ["info", "--json", "--mount"],
          timeoutMs: 20_000,
          maxOutputBytes: 16_384,
        }),
      ]);
      const branch = parseArcInfoField(branchResult.stdout, "branch");
      const defaultBranch = parseArcInfoField(mountResult.stdout, "default_branch");
      const readDiff = (kind: "working-tree" | "branch-range") => {
        const args = ["diff", "--git", "--relative=."];
        if (input.ignoreWhitespace) args.push("-w");
        if (kind === "working-tree") args.push("HEAD");
        else args.push("-B", input.baseRef ?? defaultBranch ?? "trunk", "HEAD");
        args.push("--", ...scopedPaths);
        return driver.execute({
          operation: `ReviewService.getDiffPreview.${kind}`,
          cwd: input.cwd,
          args,
          timeoutMs: 30_000,
          maxOutputBytes: ARC_DIFF_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        });
      };
      const kinds: ReadonlyArray<"working-tree" | "branch-range"> = input.file?.sourceKind
        ? [input.file.sourceKind]
        : input.sourceKind
          ? [input.sourceKind]
          : ["working-tree", "branch-range"];
      const diffs = yield* Effect.forEach(
        kinds,
        (kind) =>
          readDiff(kind).pipe(
            Effect.flatMap((result) => {
              const files = parseArcDiffStats(result.stdout);
              return digest
                .digest(
                  Digest.sha256,
                  new TextEncoder().encode(JSON.stringify([result.stdout, files])),
                )
                .pipe(
                  Effect.map(Hex.encode),
                  Effect.map((diffHash) => ({
                    kind,
                    files,
                    diffHash,
                    diff: input.metadataOnly ? "" : result.stdout,
                    truncated: result.stdoutTruncated,
                    patchesDeferred: input.metadataOnly,
                  })),
                );
            }),
          ),
        { concurrency: 2 },
      );
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: diffs.map((result) => ({
          id: result.kind === "working-tree" ? "arc-working-tree" : "arc-branch-range",
          kind: result.kind,
          title:
            result.kind === "working-tree"
              ? "Uncommitted"
              : `Changes vs ${input.baseRef ?? defaultBranch ?? "trunk"}`,
          baseRef:
            result.kind === "working-tree" ? (branch ?? "HEAD") : (input.baseRef ?? defaultBranch),
          headRef: result.kind === "working-tree" ? null : (branch ?? "HEAD"),
          diff: result.diff,
          files: result.files,
          diffHash: result.diffHash,
          truncated: result.truncated,
          ...(result.patchesDeferred ? { patchesDeferred: true } : {}),
        })),
        ...(diffs.some((result) => result.truncated) || input.trackedOnly
          ? { incomplete: true }
          : {}),
      };
    }

    return yield* git.getReviewDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getBranchCommits,
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);
