import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeForToken, readArcanumJson } from "./ArcanumPullRequestProvider.ts";

it.effect("sends OAuth auth and reads metadata as a watch fingerprint", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      return url.includes("/comments")
        ? Response.json({
            data: [
              {
                id: 7,
                content: "Looks good",
                created_at: "2026-11-17T18:53:00Z",
                user: { name: "reviewer" },
              },
            ],
          })
        : url.includes("active-diff")
          ? Response.json({ data: { id: 41078429 } })
          : url.includes("/checks")
            ? Response.json({
                data: {
                  checks: [
                    {
                      key: { system: "ci", type: "build" },
                      required: true,
                      satisfied: true,
                      status: "success",
                    },
                  ],
                },
              })
            : Response.json({
                data: {
                  id: 17236921,
                  status: "merged",
                  updated_at: "2026-11-17T18:54:15Z",
                  labels: [{ name: "ready" }],
                },
              });
    }) as typeof fetch;
    try {
      const result = yield* makeForToken("test-oauth").getChangeRequestWatchFingerprint!({
        cwd: "/repo",
        repository: "arc_vcs",
        host: "a.yandex-team.ru",
        number: 17236921,
      });
      expect(result).toEqual({
        status: "merged:2026-11-17T18:54:15Z:unknown::ci/build=success:true",
        remarks: "ready|7:2026-11-17T18:53:00Z",
      });
      expect(calls).toHaveLength(4);
      expect(calls[0]).toMatchObject({ authorization: "OAuth test-oauth" });
      expect(calls[0]?.url).toContain("/v2/pull-requests/17236921");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

it.effect("follows the active diff before reading checks and normalizes their state", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("active-diff")
        ? Response.json({ data: { id: 41078429 } })
        : Response.json({
            data: {
              checks: [
                {
                  key: { system: "ci", type: "tests" },
                  required: true,
                  satisfied: true,
                  status: "success",
                  uri: "https://ci.example/run/1",
                },
                {
                  key: { system: "ci", type: "optional" },
                  required: false,
                  satisfied: false,
                  status: "not_started",
                },
              ],
            },
          });
    }) as typeof fetch;
    try {
      const result = yield* makeForToken("test-oauth").getChangeRequestChecks!({
        cwd: "/repo",
        repository: "arc_vcs",
        host: "a.yandex-team.ru",
        number: 17236921,
      });
      expect(
        urls.findIndex((url) => url.includes("/v1/pull-requests/17236921/active-diff")),
      ).toBeLessThan(urls.findIndex((url) => url.includes("/v2/public/diff/41078429/checks")));
      expect(result.state).toBe("open");
      expect(result.checks[0]?.status).toBe("success");
      expect(result.checks).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

it.effect("builds the watched review detail from metadata and required checks", () =>
  Effect.gen(function* () {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      return url.includes("active-diff")
        ? Response.json({ data: { id: 41 } })
        : url.includes("/checks")
          ? Response.json({
              data: {
                checks: [
                  {
                    key: { system: "ci", type: "tests" },
                    required: true,
                    satisfied: true,
                    status: "success",
                  },
                ],
              },
            })
          : Response.json({
              data: {
                id: 17236921,
                status: "open",
                summary: "Review title",
                description: "Review body",
                created_at: "2026-11-17T18:41:40Z",
                updated_at: "2026-11-17T18:54:15Z",
                author: { name: "rudenkoad" },
                vcs: { from_branch: "users/me/topic", to_branch: "trunk" },
                labels: [{ name: "ready" }],
              },
            });
    }) as typeof fetch;
    try {
      const result = yield* makeForToken("test-oauth").getChangeRequest({
        cwd: "/repo",
        repository: "arc_vcs",
        host: "a.yandex-team.ru",
        number: 17236921,
      });
      expect(result).toMatchObject({
        number: 17236921,
        title: "Review title",
        body: "Review body",
        state: "open",
        headBranch: "users/me/topic",
        baseBranch: "trunk",
        checksState: "passing",
      });
      expect(result.checks[0]).toMatchObject({
        name: "ci/tests",
        status: "success",
        required: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);

it.effect(
  "reads reviewer identities, approval verdict, comments, and fingerprints review changes",
  () =>
    Effect.gen(function* () {
      const originalFetch = globalThis.fetch;
      let approved = true;
      let commentUpdatedAt = "2026-11-17T18:53:00Z";
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.includes("/comments"))
          return Response.json({
            data: [
              {
                id: 7,
                content: "Reviewed",
                created_at: "2026-11-17T18:52:00Z",
                updated_at: commentUpdatedAt,
                user: { name: "reviewer" },
              },
            ],
          });
        if (url.includes("active-diff")) return Response.json({ data: { id: 41 } });
        if (url.includes("/checks"))
          return Response.json({
            data: {
              checks: [
                {
                  key: { system: "arcanum", type: "approved" },
                  required: true,
                  satisfied: approved,
                  status: approved ? "success" : "failure",
                },
              ],
            },
          });
        return Response.json({
          data: {
            id: 17236921,
            status: "open",
            summary: "Review title",
            created_at: "2026-11-17T18:41:40Z",
            updated_at: "2026-11-17T18:54:15Z",
            approvers: approved ? [{ name: "reviewer" }] : [],
            assignees: [{ name: "reviewer" }, { name: "pending-reviewer" }],
          },
        });
      }) as typeof fetch;
      try {
        const provider = makeForToken("test-oauth");
        const input = {
          cwd: "/repo",
          repository: "arc_vcs",
          host: "a.yandex-team.ru",
          number: 17236921,
        };
        const detail = yield* provider.getChangeRequest(input);
        expect(detail.reviewDecision).toBe("approved");
        expect(detail.reviewers.map((x) => x.login)).toEqual(["reviewer", "pending-reviewer"]);
        const activity = yield* provider.getChangeRequestActivity(input);
        expect(activity).toMatchObject({
          commentCount: 1,
          commentsTruncated: false,
          reviewers: [{ login: "reviewer" }, { login: "pending-reviewer" }],
          comments: [
            { id: "7", author: { login: "reviewer" }, body: "Reviewed", kind: "issue-comment" },
          ],
        });
        const first = yield* provider.getChangeRequestWatchFingerprint!(input);
        if (first === null) throw new Error("Expected an Arcanum watch fingerprint");
        approved = false;
        commentUpdatedAt = "2026-11-17T18:55:00Z";
        const changed = yield* provider.getChangeRequestWatchFingerprint!(input);
        if (changed === null) throw new Error("Expected an Arcanum watch fingerprint");
        expect(changed.status).not.toBe(first.status);
        expect(changed.remarks).not.toBe(first.remarks);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
);

it("does not leak an OAuth token in an HTTP failure", async () => {
  const failure = await readArcanumJson("/v2/pull-requests/1", "secret", async (_input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("OAuth secret");
    return new Response("", { status: 403 });
  }).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Arcanum returned HTTP 403");
});
