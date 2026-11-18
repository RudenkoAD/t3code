import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

const KIND = SourceControlProviderKind.make("arcanum");
const BASE = "https://arcanum.yandex.net/api";
const FIELDS =
  "id,url,author,summary,description,created_at,updated_at,closed_at,status,labels,vcs,approvers,assignees,attention_required,auto_merge,merge_allowed";
type Check = {
  key?: { system?: string; type?: string };
  status?: string;
  required?: boolean;
  satisfied?: boolean;
  description?: string;
  uri?: string;
};
type Metadata = {
  id: number;
  summary: string;
  description?: string;
  status: string;
  author?: { name?: string };
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  labels?: ReadonlyArray<{ name: string }>;
  vcs?: { from_branch?: string; to_branch?: string };
  approvers?: ReadonlyArray<{ name?: string }>;
  assignees?: ReadonlyArray<{ name?: string }>;
  attention_required?: ReadonlyArray<{ name?: string }>;
  auto_merge?: string | null;
  merge_allowed?: boolean;
};
type ArcanumComment = {
  id: number | string;
  content?: string;
  created_at?: string;
  updated_at?: string;
  published_at?: string | null;
  thread_updated_at?: string;
  user?: { name?: string } | null;
  anchor?: { file?: { path?: string }; file_path?: string };
  issue_status?: string | null;
};

export async function readArcanumJson<T>(
  path: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(`${BASE}${path}`, {
    headers: { Authorization: `OAuth ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw Object.assign(new Error(`Arcanum returned HTTP ${response.status}`), {
      status: response.status,
    });
  return (await response.json()) as T;
}

const providerError = (operation: string, cause: unknown) => {
  const missingCredential =
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    cause.reason === "missing-tool";
  const status =
    typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined;
  const reason = missingCredential
    ? "missing-tool"
    : status === 401
      ? "unauthenticated"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not-found"
          : status === 429
            ? "rate-limited"
            : "failed";
  return new PullRequestProviderError({
    provider: KIND,
    operation,
    reason,
    detail: cause instanceof Error ? cause.message : "Arcanum request failed",
    cause,
  });
};
const request = <T>(operation: string, path: string, token: string) =>
  Effect.tryPromise({
    try: () => {
      if (!token)
        throw Object.assign(
          new Error("Set ARC_OAUTH_TOKEN on the server to read Arcanum reviews."),
          {
            reason: "missing-tool",
          },
        );
      return readArcanumJson<T>(path, token);
    },
    catch: (cause) => providerError(operation, cause),
  });
const readMetadata = (number: number, token: string) =>
  request<{ data: Metadata }>(
    "getChangeRequest",
    `/v2/pull-requests/${number}?fields=${encodeURIComponent(FIELDS)}`,
    token,
  ).pipe(Effect.map((x) => x.data));
const readChecks = (number: number, token: string) =>
  request<{ data: { id: number } }>(
    "getChangeRequestChecks",
    `/v1/pull-requests/${number}/active-diff?fields=${encodeURIComponent("commit_ids(base,merge),id")}`,
    token,
  ).pipe(
    Effect.flatMap((diff) =>
      request<{ data: { checks?: ReadonlyArray<Check> } }>(
        "getChangeRequestChecks",
        `/v2/public/diff/${diff.data.id}/checks`,
        token,
      ).pipe(Effect.map((x) => x.data.checks ?? [])),
    ),
  );
const readComments = (number: number, token: string) =>
  request<{ data: ReadonlyArray<ArcanumComment> }>(
    "getChangeRequestActivity",
    `/v1/public/review-requests/${number}/comments`,
    token,
  ).pipe(Effect.map((x) => x.data ?? []));
const actors = (pr: Metadata) => {
  const byLogin = new Map<string, { login: string; name: string; avatarUrl: null }>();
  for (const person of [
    ...(pr.assignees ?? []),
    ...(pr.approvers ?? []),
    ...(pr.attention_required ?? []),
  ]) {
    const login = person.name?.trim();
    if (login) byLogin.set(login.toLowerCase(), { login, name: login, avatarUrl: null });
  }
  return [...byLogin.values()];
};
const reviewDecision = (rows: ReadonlyArray<Check>) => {
  const approval = rows.find(
    (x) => x.key?.system?.toLowerCase() === "arcanum" && x.key.type === "approved",
  );
  if (approval?.satisfied === true || approval?.status === "success") return "approved" as const;
  return approval ? ("review-required" as const) : null;
};
const state = (status: string) =>
  status === "merged"
    ? ("merged" as const)
    : status === "closed" || status === "discarded"
      ? ("closed" as const)
      : ("open" as const);
const checkState = (rows: ReadonlyArray<Check>) => {
  const required = rows.filter((x) => x.required);
  if (
    required.some(
      (x) =>
        ["failed", "failure", "error"].includes(x.status ?? "") ||
        (x.satisfied === false &&
          x.status !== "not_started" &&
          x.status !== "pending" &&
          x.status !== "running"),
    )
  )
    return "failing" as const;
  if (
    required.some(
      (x) =>
        x.satisfied === false || ["running", "pending", "not_started"].includes(x.status ?? ""),
    )
  )
    return "pending" as const;
  if (
    required.length > 0 &&
    required.every((x) => x.satisfied === true || ["success", "skipped"].includes(x.status ?? ""))
  )
    return "passing" as const;
  if (rows.some((x) => ["failed", "failure", "error"].includes(x.status ?? "")))
    return "failing" as const;
  if (rows.some((x) => ["running", "pending", "not_started"].includes(x.status ?? "")))
    return "pending" as const;
  return rows.length > 0 ? ("passing" as const) : null;
};
const checkRows = (rows: ReadonlyArray<Check>) =>
  rows.map((x) => ({
    name: `${x.key?.system ?? ""}/${x.key?.type ?? "check"}`,
    status:
      x.status === "success"
        ? ("success" as const)
        : x.status === "failed" || x.status === "failure" || x.status === "error"
          ? ("failure" as const)
          : x.status === "skipped"
            ? ("skipped" as const)
            : x.status === "action_required"
              ? ("action-required" as const)
              : ("pending" as const),
    description: x.description ?? null,
    url: x.uri ?? null,
    ...(x.required === undefined ? {} : { required: x.required }),
  }));
const unsupported = (operation: string) =>
  Effect.fail(
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail: `Arcanum ${operation} is not supported.`,
    }),
  );

export const makeForToken = (token: string): PullRequestProviderApi => ({
  kind: KIND,
  capabilities: {
    diff: false,
    comment: false,
    actions: [],
    mergeMethods: [],
    search: false,
    reactions: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  unavailableRequirement: {
    missing: "Set ARC_OAUTH_TOKEN on the server to read Arcanum reviews.",
    unauthenticated: "Check ARC_OAUTH_TOKEN on the server.",
  },
  getViewer: () => Effect.succeed(""),
  listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: false }),
  getChangeRequestSummary: (input) =>
    readMetadata(input.number, token).pipe(
      Effect.map((x) => ({
        number: x.id,
        title: x.summary,
        url: `https://a.yandex-team.ru/review/${x.id}`,
        headBranch: x.vcs?.from_branch ?? "",
        baseBranch: x.vcs?.to_branch ?? "",
        state: state(x.status),
        updatedAt: x.updated_at,
        closedAt: x.closed_at ?? null,
        mergedAt: state(x.status) === "merged" ? (x.closed_at ?? null) : null,
      })),
    ),
  getChangeRequestWatchFingerprint: (input) =>
    Effect.all([
      readMetadata(input.number, token),
      readChecks(input.number, token),
      readComments(input.number, token),
    ]).pipe(
      Effect.map(([pr, rows, comments]) => ({
        status: `${pr.status}:${pr.updated_at}:${reviewDecision(rows) ?? "unknown"}:${actors(pr)
          .map((x) => x.login.toLowerCase())
          .sort()
          .join(",")}:${rows
          .map(
            (x) =>
              `${x.key?.system ?? ""}/${x.key?.type ?? ""}=${x.status ?? "unknown"}:${x.satisfied ?? "?"}`,
          )
          .sort()
          .join(",")}`,
        remarks: `${(pr.labels ?? [])
          .map((label) => label.name)
          .sort()
          .join(",")}|${comments
          .map((x) => `${x.id}:${x.updated_at ?? x.thread_updated_at ?? x.created_at ?? ""}`)
          .sort()
          .join(",")}`,
      })),
    ),
  getChangeRequestChecks: (input) =>
    Effect.all([readMetadata(input.number, token), readChecks(input.number, token)]).pipe(
      Effect.map(([pr, rows]) => ({ state: state(pr.status), checks: checkRows(rows) })),
    ),
  getChangeRequest: (input) =>
    readMetadata(input.number, token).pipe(
      Effect.flatMap((x) =>
        readChecks(input.number, token).pipe(
          Effect.map((rows) => ({
            number: x.id,
            title: x.summary,
            url: `https://a.yandex-team.ru/review/${x.id}`,
            author: x.author?.name
              ? { login: x.author.name, name: x.author.name, avatarUrl: null }
              : null,
            headBranch: x.vcs?.from_branch ?? "",
            baseBranch: x.vcs?.to_branch ?? "",
            state: state(x.status),
            isDraft: false,
            mergeability: "unknown" as const,
            additions: 0,
            deletions: 0,
            createdAt: x.created_at,
            closedAt: x.closed_at ?? null,
            mergedAt: state(x.status) === "merged" ? (x.closed_at ?? null) : null,
            updatedAt: x.updated_at,
            reviewRequestLogins: actors(x).map((reviewer) => reviewer.login),
            labels: (x.labels ?? []).map((label) => ({
              name: label.name,
              color: null,
              description: null,
            })),
            reviewDecision: reviewDecision(rows),
            checksState: checkState(rows),
            body: x.description ?? "",
            changedFiles: 0,
            reviewers: actors(x),
            checks: checkRows(rows),
            mergeCapabilities: { merge: false, squash: false, rebase: false },
            viewerPermissions: {
              actions: [],
              comment: false,
              resolve: false,
              verdicts: [],
              requestReviewers: false,
            },
          })),
        ),
      ),
    ),
  getChangeRequestActivity: (input) =>
    Effect.all([readMetadata(input.number, token), readComments(input.number, token)]).pipe(
      Effect.map(([pr, rows]) => {
        const reviewers = actors(pr);
        const comments = rows.map((comment) => {
          const login = comment.user?.name?.trim();
          const author = login ? { login, name: login, avatarUrl: null } : null;
          const createdAt =
            comment.published_at ?? comment.created_at ?? comment.updated_at ?? pr.updated_at;
          return {
            id: String(comment.id),
            kind: "issue-comment" as const,
            author,
            body: comment.content ?? "",
            createdAt,
            editedAt: comment.updated_at ?? null,
            url: `https://a.yandex-team.ru/review/${pr.id}#comment-${comment.id}`,
            path: comment.anchor?.file?.path ?? comment.anchor?.file_path ?? null,
            reviewState: comment.issue_status ?? null,
          };
        });
        return {
          author: pr.author?.name
            ? { login: pr.author.name, name: pr.author.name, avatarUrl: null }
            : null,
          reviewers,
          comments,
          commentCount: comments.length,
          commentsTruncated: false,
          reviewThreads: [],
          commits: [],
        };
      }),
    ),
  getViewerPermissions: () =>
    Effect.succeed({
      actions: [],
      comment: false,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    }),
  getDiff: () => unsupported("getDiff"),
  runAction: () => unsupported("runAction"),
  comment: () => unsupported("comment"),
  submitReview: () => unsupported("submitReview"),
  listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
  setReviewerRequest: () => unsupported("setReviewerRequest"),
  replyToThread: () => unsupported("replyToThread"),
  setReaction: () => unsupported("setReaction"),
  setThreadResolution: () => unsupported("setThreadResolution"),
});

const SERVER_TOKEN = process.env.ARC_OAUTH_TOKEN?.trim() ?? "";
export const make = Effect.succeed(makeForToken(SERVER_TOKEN));
