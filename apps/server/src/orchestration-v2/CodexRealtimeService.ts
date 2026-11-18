import {
  CodexRealtimeError,
  type CodexRealtimeStartInput,
  type CodexRealtimeStartResult,
  type CodexRealtimeStopInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { dispatchCodexVoiceTurn } from "./CodexVoiceTurn.ts";

export interface VoiceConnection {
  readonly start: (
    input: CodexRealtimeStartInput,
  ) => Effect.Effect<CodexRealtimeStartResult, CodexRealtimeError>;
  readonly stop: (input: CodexRealtimeStopInput) => Effect.Effect<void>;
}

export class CodexRealtimeService extends Context.Service<
  CodexRealtimeService,
  { readonly connect: Effect.Effect<VoiceConnection, never, Scope.Scope> }
>()("t3/orchestration-v2/CodexRealtimeService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const open = Effect.fn("CodexRealtimeService.open")(function* (input: CodexRealtimeStartInput) {
    const { threadId, callId, offer } = input;
    const unavailable = new CodexRealtimeError({ threadId, reason: "unavailable" });
    const records = yield* projections
      .getThreadRecords(threadId, ["providerThreads", "providerSessions"])
      .pipe(Effect.mapError(() => unavailable));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.driver === "codex" &&
        candidate.providerSessionId !== null,
    );
    if (
      providerThread?.providerSessionId == null ||
      providerThread.nativeThreadRef?.nativeId == null ||
      records.thread.archivedAt !== null ||
      records.thread.deletedAt !== null ||
      providerThread.providerInstanceId !== records.thread.modelSelection.instanceId
    )
      return yield* unavailable;
    if (
      !(yield* threads.isProviderInstanceEnabledForProject({
        projectId: records.thread.projectId,
        instanceId: providerThread.providerInstanceId,
      }))
    )
      return yield* unavailable;
    const modelSelection = records.thread.modelSelection;
    const resolvedRuntimePolicy = yield* runtimePolicy
      .resolve({ thread: records.thread, modelSelection })
      .pipe(Effect.mapError(() => unavailable));
    const maybeSession = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(() => unavailable));
    const resumableSession = records.providerSessions.find(
      (candidate) => candidate.id === providerThread.providerSessionId,
    );
    const runtime = Option.isSome(maybeSession)
      ? maybeSession.value
      : yield* sessions
          .open({
            threadId,
            providerSessionId: providerThread.providerSessionId,
            modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            initialNativeThreadId: providerThread.nativeThreadRef.nativeId,
            ...(resumableSession === undefined ? {} : { resumeFromSession: resumableSession }),
          })
          .pipe(Effect.mapError(() => unavailable));
    if (runtime.driver !== "codex" || !runtime.startRealtime || !runtime.stopRealtime)
      return yield* unavailable;
    const stop = runtime.stopRealtime({ providerThread, callId });
    return yield* Effect.acquireRelease(
      runtime
        .startRealtime({
          providerThread,
          callId,
          offer,
          modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          onTurnStarted: ({ nativeTurnId, text }) =>
            dispatchCodexVoiceTurn(threads, { threadId, nativeTurnId, text }),
        })
        .pipe(
          Effect.mapError(() => new CodexRealtimeError({ threadId, reason: "provider_error" })),
        ),
      () => stop.pipe(Effect.ignoreCause({ log: true })),
      { interruptible: true },
    );
  });

  return CodexRealtimeService.of({
    connect: Effect.gen(function* () {
      // Each socket owns its calls. Closing or revoking it releases the native sessions too.
      const calls = yield* FiberMap.make<string, never, CodexRealtimeError>();
      const key = (input: CodexRealtimeStopInput) => JSON.stringify([input.threadId, input.callId]);
      return {
        start: Effect.fn("CodexRealtimeService.start")(function* (input) {
          const answer = yield* Deferred.make<CodexRealtimeStartResult>();
          if (yield* FiberMap.has(calls, key(input))) {
            return yield* new CodexRealtimeError({
              threadId: input.threadId,
              detail: "This voice call is already open.",
            });
          }
          const call = yield* FiberMap.run(
            calls,
            key(input),
            Effect.scoped(
              open(input).pipe(
                Effect.tap((result) => Deferred.succeed(answer, result)),
                Effect.andThen(Effect.never),
              ),
            ),
            { onlyIfMissing: true },
          );
          return yield* Deferred.await(answer).pipe(
            Effect.raceFirst(Fiber.join(call)),
            Effect.onError(() => Fiber.interrupt(call)),
          );
        }),
        stop: (input) => FiberMap.remove(calls, key(input)),
      };
    }),
  });
});

export const layer = Layer.effect(CodexRealtimeService, make);
