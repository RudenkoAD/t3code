import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodexRealtimeStartInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  offer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128 * 1024)),
});
export type CodexRealtimeStartInput = typeof CodexRealtimeStartInput.Type;

export const CodexRealtimeStartResult = Schema.Struct({ answer: Schema.String });
export type CodexRealtimeStartResult = typeof CodexRealtimeStartResult.Type;

export const CodexRealtimeStopInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
});
export type CodexRealtimeStopInput = typeof CodexRealtimeStopInput.Type;

export class CodexRealtimeError extends Schema.TaggedError<CodexRealtimeError>()(
  "CodexRealtimeError",
  {
    threadId: ThreadId,
    reason: Schema.optionalKey(Schema.Literals(["unavailable", "provider_error"])),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const message =
      this.reason === "provider_error"
        ? "Codex could not start realtime voice. Check that Codex is signed in and up to date."
        : "Realtime voice is available only for a live Codex thread enabled in this project.";
    return this.detail === undefined ? message : `${message} ${this.detail}`;
  }
}
