import { SourceControlProviderError } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import { definition } from "../shared/definition.ts";
import * as PullRequests from "./ArcanumPullRequestProvider.ts";

const HAS_TOKEN = Boolean(process.env.ARC_OAUTH_TOKEN?.trim());

const unavailable = (operation: string) => (input: { cwd: string }) =>
  new SourceControlProviderError({
    provider: definition.kind,
    operation,
    cwd: input.cwd,
    detail: `Arcanum ${operation} is not supported.`,
  });
const sourceControl = SourceControlProvider.SourceControlProvider.of({
  kind: definition.kind,
  listChangeRequests: Effect.fn("ArcanumSourceControlProvider.listChangeRequests")(() =>
    Effect.succeed([]),
  ),
  getChangeRequest: unavailable("getChangeRequest"),
  createChangeRequest: unavailable("createChangeRequest"),
  getRepositoryCloneUrls: unavailable("getRepositoryCloneUrls"),
  createRepository: unavailable("createRepository"),
  getDefaultBranch: Effect.fn("ArcanumSourceControlProvider.getDefaultBranch")(() =>
    Effect.succeed(null),
  ),
  checkoutChangeRequest: unavailable("checkoutChangeRequest"),
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: Effect.map(PullRequests.make, (pullRequests) => ({
    sourceControl,
    discovery: {
      type: "api",
      kind: definition.kind,
      label: "Arcanum",
      installHint: "Set ARC_OAUTH_TOKEN on the server to read Arcanum reviews.",
      probeAuth: Effect.sync(() =>
        providerAuth({
          status: HAS_TOKEN ? "unknown" : "unauthenticated",
          host: "a.yandex-team.ru",
        }),
      ),
    },
    pullRequests,
  })),
});
