import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
  type VcsError,
  type SourceControlProviderInfo,
} from "@t3tools/contracts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as RepositoryLocator from "./RepositoryLocator.ts";

const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const ARCANUM_PROVIDER: SourceControlProviderInfo = {
  kind: "arcanum" as SourceControlProviderInfo["kind"],
  name: "Arcanum",
  baseUrl: "https://a.yandex-team.ru",
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringField = (value: unknown, key: string): string | null => {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
};

const collectStatusPaths = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.flatMap((item) => (typeof item === "string" ? [item] : collectStatusPaths(item)));
  const object = record(value);
  if (!object) return [];
  const ownPath = stringField(object, "path") ?? stringField(object, "file");
  return [
    ...(ownPath ? [ownPath] : []),
    ...Object.entries(object)
      .filter(([key]) => key !== "path" && key !== "file")
      .flatMap(([, child]) => collectStatusPaths(child)),
  ];
};

const parseJson = (stdout: string): Record<string, unknown> => {
  try {
    return record(JSON.parse(stdout)) ?? {};
  } catch {
    return {};
  }
};

const parseJsonArray = (stdout: string): ReadonlyArray<unknown> => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const numberField = (value: unknown, key: string): number | null => {
  const candidate = record(value)?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
};

export const parseArcPullRequest = (value: unknown): VcsStatusRemoteResult["pr"] => {
  const object = record(value);
  if (!object) return null;
  const id = numberField(object, "id") ?? numberField(object, "number");
  const status = stringField(object, "status")?.toLowerCase();
  const state =
    status === "open" || status === "in_progress"
      ? "open"
      : status === "merged"
        ? "merged"
        : status === "discarded" || status === "closed"
          ? "closed"
          : null;
  const title = stringField(object, "summary") ?? stringField(object, "title");
  const url =
    stringField(object, "url") ?? (id !== null ? `https://a.yandex-team.ru/review/${id}` : null);
  const baseRef = stringField(object, "to_branch") ?? stringField(object, "baseRef");
  const headRef = stringField(object, "from_branch") ?? stringField(object, "headRef");
  if (
    id === null ||
    title === null ||
    url === null ||
    baseRef === null ||
    headRef === null ||
    state === null
  )
    return null;
  const updatedAtValue = object.updated_at ?? object.updatedAt;
  const updatedAt =
    typeof updatedAtValue === "string"
      ? updatedAtValue
      : numberField(updatedAtValue, "seconds") !== null
        ? DateTime.formatIso(DateTime.makeUnsafe(numberField(updatedAtValue, "seconds")! * 1_000))
        : null;
  return {
    number: id,
    title,
    url,
    baseRef,
    headRef,
    state,
    ...(updatedAt !== null ? { updatedAt } : {}),
  };
};

export interface ArcRepositoryContext {
  readonly rootPath: string;
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly mountId: string | null;
  readonly repositoryType: string | null;
  readonly repository: string | null;
}

export class ArcVcsDriver extends Context.Service<
  ArcVcsDriver,
  VcsDriver.VcsDriver["Service"] & {
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, VcsError>;
    readonly localStatus: (input: VcsStatusInput) => Effect.Effect<VcsStatusLocalResult, VcsError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusRemoteResult, VcsError>;
    readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, VcsError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, VcsError>;
    readonly getRepositoryContext: (
      cwd: string,
    ) => Effect.Effect<ArcRepositoryContext | null, VcsError>;
  }
>()("t3/vcs/ArcVcsDriver") {}

const unsupported = (operation: string) =>
  new VcsUnsupportedOperationError({
    operation,
    kind: "arc",
    detail: "Arc repository initialization is not supported.",
  });

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation,
      command: "arc",
      args,
      cwd,
      timeoutMs: 20_000,
      maxOutputBytes: MAX_STATUS_BYTES,
      allowNonZeroExit: true,
    });

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    process.run({ command: "arc", ...input, allowNonZeroExit: input.allowNonZeroExit ?? false });

  const canonicalProjectScope = Effect.fn("ArcVcsDriver.canonicalProjectScope")(function* (
    cwd: string,
    rootPath: string,
  ) {
    const canonicalCwd = yield* fileSystem
      .realPath(path.resolve(cwd))
      .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    const relative = path.relative(rootPath, canonicalCwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return { cwd: canonicalCwd, relative: relative || "." };
  });

  const projectRelativePaths = (
    rawPaths: ReadonlyArray<string>,
    rootPath: string,
    projectPath: string,
  ) => {
    const result = new Set<string>();
    for (const rawPath of rawPaths) {
      if (rawPath.length === 0 || path.isAbsolute(rawPath)) continue;
      const absolute = path.resolve(rootPath, rawPath);
      const fromRoot = path.relative(rootPath, absolute);
      if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
        continue;
      const relative = path.relative(projectPath, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        continue;
      if (relative.length > 0) result.add(relative);
    }
    return [...result];
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    detectRepository(cwd).pipe(Effect.map((repository) => repository !== null));

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "ArcVcsDriver.detectRepository",
  )(function* (cwd) {
    // Arc's VFS has a local root marker. Walk ancestors with point stats only; do not spawn
    // `arc` for personal repositories or enumerate any directory contents.
    const marker = yield* RepositoryLocator.locateRepositoryMarker(cwd, fileSystem, path);
    if (!marker || marker.kind !== "arc") return null;
    return {
      kind: "arc" as const,
      rootPath: marker.rootPath,
      metadataPath: marker.metadataPath,
      freshness: yield* nowFreshness(),
    };
  });

  const getRepositoryContext: ArcVcsDriver["Service"]["getRepositoryContext"] = Effect.fn(
    "ArcVcsDriver.getRepositoryContext",
  )(function* (cwd) {
    const repository = yield* detectRepository(cwd);
    if (!repository) return null;
    const [currentResult, mountResult] = yield* Effect.all([
      run("ArcVcsDriver.getRepositoryContext", cwd, ["info", "--json"]),
      run("ArcVcsDriver.getRepositoryContext", cwd, ["info", "--json", "--mount"]),
    ]);
    if (currentResult.exitCode !== 0 || mountResult.exitCode !== 0) {
      const failed = currentResult.exitCode !== 0 ? currentResult : mountResult;
      return yield* new VcsProcessExitError({
        operation: "ArcVcsDriver.getRepositoryContext",
        command: "arc info --json",
        cwd,
        exitCode: failed.exitCode,
        detail: failed.stderr.trim() || "arc info failed",
      });
    }
    const current = parseJson(currentResult.stdout);
    const mount = parseJson(mountResult.stdout);
    return {
      rootPath: repository.rootPath,
      branch: stringField(current, "branch"),
      defaultBranch: stringField(mount, "default_branch"),
      mountId: stringField(mount, "mount_id") ?? stringField(current, "mount_id"),
      repositoryType:
        stringField(mount, "repository_type") ?? stringField(current, "repository_type"),
      repository: stringField(mount, "repository") ?? stringField(current, "repository"),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "ArcVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    // Arc status reports touched paths without a filesystem walk. Keep output bounded.
    const repository = yield* detectRepository(cwd);
    if (!repository) return { paths: [], truncated: false, freshness: yield* nowFreshness() };
    const project = yield* canonicalProjectScope(cwd, repository.rootPath);
    if (!project) return { paths: [], truncated: false, freshness: yield* nowFreshness() };
    const result = yield* run("ArcVcsDriver.listWorkspaceFiles", repository.rootPath, [
      "status",
      "--json",
      "--",
      project.relative,
    ]);
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "ArcVcsDriver.listWorkspaceFiles",
        command: "arc status --json",
        cwd: repository.rootPath,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "arc status failed",
      });
    }
    const freshness = yield* nowFreshness();
    const paths = projectRelativePaths(
      collectStatusPaths(parseJson(result.stdout).status),
      repository.rootPath,
      project.cwd,
    );
    return { paths, truncated: result.stdoutTruncated, freshness };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "ArcVcsDriver.listRemotes",
  )(function* (_cwd) {
    const freshness = yield* nowFreshness();
    return { remotes: [], freshness };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = (_cwd, paths) =>
    Effect.succeed(paths);

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (_input) =>
    Effect.fail(unsupported("ArcVcsDriver.initRepository"));

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.succeed(false),
    restoreCheckpoint: () => Effect.succeed(false),
    diffCheckpoints: () => Effect.succeed(""),
    listAuthoredPaths: () => Effect.succeed(null),
    deleteCheckpointRefs: () => Effect.void,
  };

  const currentBranch: ArcVcsDriver["Service"]["currentBranch"] = Effect.fn(
    "ArcVcsDriver.currentBranch",
  )(function* (cwd) {
    const repository = yield* detectRepository(cwd);
    if (!repository) return null;
    const result = yield* run("ArcVcsDriver.currentBranch", cwd, ["info", "--json"]);
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "ArcVcsDriver.currentBranch",
        command: "arc info --json",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "arc info failed",
      });
    }
    return stringField(parseJson(result.stdout), "branch");
  });

  const localStatus: ArcVcsDriver["Service"]["localStatus"] = Effect.fn("ArcVcsDriver.localStatus")(
    function* (input) {
      const repository = yield* detectRepository(input.cwd);
      if (!repository) {
        return {
          vcsKind: "arc",
          isRepo: false,
          hasPrimaryRemote: false,
          isDefaultRef: false,
          refName: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0, lineCountsKnown: true },
        } satisfies VcsStatusLocalResult;
      }
      const project = yield* canonicalProjectScope(input.cwd, repository.rootPath);
      if (!project) {
        return {
          vcsKind: "arc",
          isRepo: false,
          hasPrimaryRemote: false,
          isDefaultRef: false,
          refName: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0, lineCountsKnown: false },
        } satisfies VcsStatusLocalResult;
      }
      const result = yield* run("ArcVcsDriver.status", repository.rootPath, [
        "status",
        "--json",
        "--branch",
        "--",
        project.relative,
      ]);
      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "ArcVcsDriver.status",
          command: "arc status --json --branch -- <project-scope>",
          cwd: repository.rootPath,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "arc status failed",
        });
      }
      const statusJson = parseJson(result.stdout);
      const branchInfo = record(statusJson.branch_info);
      const localBranch = record(branchInfo?.local);
      const remoteBranch = record(branchInfo?.remote);
      const refName = stringField(localBranch, "name");
      const remoteName = stringField(remoteBranch, "name");
      const mountResult = yield* run("ArcVcsDriver.localStatus.defaultBranch", input.cwd, [
        "info",
        "--json",
        "--mount",
      ]);
      const defaultBranch =
        mountResult.exitCode === 0
          ? stringField(parseJson(mountResult.stdout), "default_branch")
          : null;
      const paths = projectRelativePaths(
        collectStatusPaths(statusJson.status),
        repository.rootPath,
        project.cwd,
      );
      return {
        vcsKind: "arc",
        isRepo: true,
        sourceControlProvider: ARCANUM_PROVIDER,
        hasPrimaryRemote: true,
        isDefaultRef:
          refName !== null &&
          (defaultBranch === refName ||
            (defaultBranch === null &&
              remoteName !== null &&
              refName === remoteName.split("/").at(-1))),
        refName,
        hasWorkingTreeChanges: paths.length > 0,
        workingTree: {
          rootPath: project.cwd,
          lineCountsKnown: false,
          files: paths.map((filePath) => ({ path: filePath, insertions: 0, deletions: 0 })),
          insertions: 0,
          deletions: 0,
        },
      } satisfies VcsStatusLocalResult;
    },
  );

  const remoteStatus: ArcVcsDriver["Service"]["remoteStatus"] = Effect.fn(
    "ArcVcsDriver.remoteStatus",
  )(function* (input) {
    const repository = yield* detectRepository(input.cwd);
    if (!repository)
      return {
        hasUpstream: false,
        trackingCountsKnown: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      } satisfies VcsStatusRemoteResult;
    const branchInfoResult = yield* run("ArcVcsDriver.remoteStatus.branch", input.cwd, [
      "status",
      "--json",
      "--branch",
      "--",
      ".",
    ]);
    const branchInfo = record(parseJson(branchInfoResult.stdout).branch_info);
    const local = record(branchInfo?.local);
    const remote = record(branchInfo?.remote);
    const localCommit = stringField(local?.commit, "id");
    const remoteCommit = stringField(remote?.commit, "id");
    const hasUpstream =
      branchInfoResult.exitCode === 0 && remote !== null && stringField(remote, "name") !== null;
    const prResult = yield* run("ArcVcsDriver.remoteStatus.pullRequest", input.cwd, [
      "pr",
      "status",
      "--json",
    ]);
    let pr: VcsStatusRemoteResult["pr"] = null;
    if (prResult.exitCode === 0) {
      const prRoot = parseJson(prResult.stdout);
      pr = parseArcPullRequest(prRoot.pull_request ?? prRoot.pr ?? prRoot);
    } else if (
      !/no pull request|can.t find any pr/iu.test(`${prResult.stdout}\n${prResult.stderr}`)
    ) {
      return yield* new VcsProcessExitError({
        operation: "ArcVcsDriver.remoteStatus.pullRequest",
        command: "arc pr status --json",
        cwd: input.cwd,
        exitCode: prResult.exitCode,
        detail: prResult.stderr.trim() || prResult.stdout.trim() || "arc pr status failed",
      });
    }
    const trackingCountsKnown =
      hasUpstream && localCommit !== null && remoteCommit !== null && localCommit === remoteCommit;
    return {
      hasUpstream,
      trackingCountsKnown,
      aheadCount: 0,
      behindCount: 0,
      pr,
    } satisfies VcsStatusRemoteResult;
  });

  const listRefs: ArcVcsDriver["Service"]["listRefs"] = Effect.fn("ArcVcsDriver.listRefs")(
    function* (input) {
      const repository = yield* detectRepository(input.cwd);
      if (!repository) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        } satisfies VcsListRefsResult;
      }
      const context = yield* getRepositoryContext(input.cwd);
      const current = context?.branch ?? null;
      const args = ["branch", "--list", "--json"];
      const result = yield* run("ArcVcsDriver.listRefs", input.cwd, args);
      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "ArcVcsDriver.listRefs",
          command: "arc branch --list --json",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "arc branch failed",
        });
      }
      const records = parseJsonArray(result.stdout);
      const localRecords = records.filter((value) => record(value)?.local === true);
      const unique = new Map<string, Record<string, unknown>>();
      for (const value of localRecords) {
        const item = record(value);
        const name = stringField(item, "name");
        if (name && !unique.has(name)) unique.set(name, item!);
      }
      const defaultBranch = context?.defaultBranch;
      const allRefs: VcsRef[] = [...unique.entries()]
        .map(([name, item]) => ({
          name,
          current: item.current === true || name === current,
          isDefault: name === defaultBranch,
          worktreePath: null,
        }))
        .sort(
          (left, right) =>
            Number(right.current) - Number(left.current) ||
            Number(right.isDefault) - Number(left.isDefault) ||
            left.name.localeCompare(right.name),
        );
      const query = input.query?.toLocaleLowerCase();
      const filtered = (input.refKind === "remote" ? [] : allRefs).filter(
        (ref) => query === undefined || ref.name.toLocaleLowerCase().includes(query),
      );
      const offset = input.cursor ?? 0;
      const limit = input.limit ?? 100;
      const refs = filtered.slice(offset, offset + limit);
      const nextCursor = offset + refs.length < filtered.length ? offset + refs.length : null;
      return {
        refs,
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor,
        totalCount: filtered.length,
      } satisfies VcsListRefsResult;
    },
  );

  const status: ArcVcsDriver["Service"]["status"] = Effect.fn("ArcVcsDriver.status")(
    function* (input) {
      const [local, remote] = yield* Effect.all([localStatus(input), remoteStatus(input)]);
      return { ...local, ...remote } satisfies VcsStatusResult;
    },
  );

  return ArcVcsDriver.of({
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    currentBranch,
    localStatus,
    remoteStatus,
    listRefs,
    status,
    getRepositoryContext,
  });
});

const nowFreshness = Effect.fn("ArcVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return { source: "live-local" as const, observedAt: now, expiresAt: Option.none() };
});
