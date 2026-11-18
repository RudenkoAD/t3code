import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as ThreadManagementService from "./ThreadManagementService.ts";

const prefix = "codex-voice:";

export function codexVoiceTurnId(message: {
  readonly id: MessageId;
  readonly creationSource: string;
}) {
  return message.creationSource === "provider" && message.id.startsWith(prefix)
    ? message.id.slice(prefix.length)
    : undefined;
}

export const dispatchCodexVoiceTurn = Effect.fn("CodexVoiceTurn.dispatch")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "dispatch">,
  input: { readonly threadId: ThreadId; readonly nativeTurnId: string; readonly text: string },
) {
  const id = prefix + input.nativeTurnId;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: input.threadId,
    text: input.text ? `Voice: ${input.text}` : "Voice request",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "provider",
  });
});
