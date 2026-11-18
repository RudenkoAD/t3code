import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitActionProgressEvent, GitRunStackedActionInput } from "./git.ts";
import { VcsError } from "./vcs.ts";

/** Arc CLI action errors are the same sanitized process and repository failures used by VCS RPCs. */
export class ArcActionInputError extends Schema.TaggedError<ArcActionInputError>()(
  "ArcActionInputError",
  {
    operation: Schema.Literals(["runAction"]),
    cwd: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
export const ArcWorkflowError = Schema.Union([VcsError, ArcActionInputError]);
export type ArcWorkflowError = typeof ArcWorkflowError.Type;

export const ArcRunActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  action: GitRunStackedActionInput.fields.action,
  commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
  filePaths: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(Schema.isMinLength(1)),
  ),
  featureBranch: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
});
export type ArcRunActionInput = typeof ArcRunActionInput.Type;

export const ArcActionProgressEvent = GitActionProgressEvent;
export type ArcActionProgressEvent = typeof ArcActionProgressEvent.Type;
