import type { DesktopTunnelerState } from "@t3tools/contracts";
import { isCorporateTunnelerHost } from "@t3tools/shared/remote";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- process-group signaling must clean up Tunneler's SSH descendants
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";

const START_TIMEOUT = Duration.seconds(60);

const idleState = (): DesktopTunnelerState => ({ running: false, origin: null, error: null });

export const parseTunnelerOrigin = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !isCorporateTunnelerHost(url.hostname) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

interface TunnelerOutputEvent {
  readonly schema_version?: unknown;
  readonly type?: unknown;
  readonly public_url?: unknown;
  readonly error?: { readonly code?: unknown };
}

const TUNNELER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  startup_failed: "Tunneler failed to start.",
  identity_failed: "Tunneler could not authenticate.",
  invalid_client_certificate: "Tunneler rejected its client certificate.",
  runtime_failed: "Tunneler runtime failed.",
  project_id_in_use: "This Tunneler project is already in use.",
  public_prefix_in_use: "This Tunneler address is already in use.",
};

const decodeJsonLine = (line: string): TunnelerOutputEvent | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as TunnelerOutputEvent) : null;
  } catch {
    return null;
  }
};

export interface DesktopTunnelerProcessDriver {
  readonly spawn: typeof NodeChildProcess.spawn;
  readonly terminate: (
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
    platform: NodeJS.Platform,
  ) => void;
}

const defaultProcessDriver: DesktopTunnelerProcessDriver = {
  spawn: NodeChildProcess.spawn,
  terminate: (current, signal, platform) => {
    if (current.pid === undefined) return;
    try {
      if (platform === "win32") {
        const treeKiller = NodeChildProcess.spawn(
          "taskkill",
          ["/pid", String(current.pid), "/t", "/f"],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        treeKiller.on("error", () => {});
      } else {
        process.kill(-current.pid, signal);
      }
    } catch {
      try {
        current.kill(signal);
      } catch {}
    }
  },
};

export class DesktopTunneler extends Context.Service<
  DesktopTunneler,
  {
    readonly start: Effect.Effect<DesktopTunnelerState>;
    readonly getState: Effect.Effect<DesktopTunnelerState>;
    readonly stop: Effect.Effect<DesktopTunnelerState>;
  }
>()("@t3tools/desktop/backend/DesktopTunneler") {}

export const layerWithProcessDriver = (driver: DesktopTunnelerProcessDriver) =>
  Layer.effect(
    DesktopTunneler,
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
      const managedPolicy = yield* DesktopManagedPolicy.DesktopManagedPolicy;
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
      const backendPool = yield* DesktopBackendPool.DesktopBackendPool;
      const serviceScope = yield* Scope.Scope;
      let state = idleState();
      let child: NodeChildProcess.ChildProcess | null = null;
      let resolveStart: ((result: DesktopTunnelerState) => void) | null = null;
      let startupTimeoutFiber: Fiber.Fiber<void> | null = null;
      let killTimerFiber: Fiber.Fiber<void> | null = null;
      let generation = 0;
      let starting = false;
      let stopping: Promise<void> | null = null;
      const runFork = Effect.runForkWith(yield* Effect.context<never>());

      const interruptFiber = (fiber: Fiber.Fiber<void> | null) => {
        if (fiber !== null) runFork(Fiber.interrupt(fiber));
      };

      const finishStart = (error: string | null) => {
        interruptFiber(startupTimeoutFiber);
        startupTimeoutFiber = null;
        if (error !== null) state = { running: child !== null, origin: null, error };
        resolveStart?.(state);
        resolveStart = null;
      };

      const stopNow = () => {
        const current = child;
        generation += 1;
        interruptFiber(startupTimeoutFiber);
        startupTimeoutFiber = null;
        starting = false;
        if (current === null) {
          state = idleState();
          resolveStart?.(state);
          resolveStart = null;
          return Promise.resolve(state);
        }
        if (stopping !== null) return stopping.then(() => state);
        state = { running: true, origin: state.origin, error: null };
        stopping = new Promise<void>((resolve) => {
          const finish = () => {
            current.removeListener("close", finish);
            interruptFiber(killTimerFiber);
            killTimerFiber = null;
            if (child === current) child = null;
            state = idleState();
            resolveStart?.(state);
            resolveStart = null;
            resolve();
          };
          current.once("close", finish);
          killTimerFiber = runFork(
            Effect.sleep(Duration.seconds(2)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (child === current) driver.terminate(current, "SIGKILL", platform);
                }),
              ),
            ),
          );
          driver.terminate(current, "SIGTERM", platform);
        }).finally(() => {
          stopping = null;
        });
        return stopping.then(() => state);
      };

      const stopWithError = (error: string) => {
        const current = child;
        generation += 1;
        interruptFiber(startupTimeoutFiber);
        startupTimeoutFiber = null;
        state = { running: current !== null, origin: null, error };
        starting = false;
        resolveStart?.(state);
        resolveStart = null;
        if (current !== null) {
          driver.terminate(current, "SIGTERM", platform);
          if (child === current) {
            killTimerFiber = runFork(
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (child === current) driver.terminate(current, "SIGKILL", platform);
                  }),
                ),
              ),
            );
          }
        }
        return state;
      };

      const start = Effect.suspend(() => {
        if (starting || child !== null || stopping !== null) return Effect.succeed(state);
        starting = true;
        const myGeneration = ++generation;
        return Effect.gen(function* () {
          const appSettingsValue = yield* appSettings.get;
          if (myGeneration !== generation) return state;
          if (!appSettingsValue.localEnvironmentEnabled) {
            return (state = { ...idleState(), error: "The local desktop backend is disabled." });
          }

          const policyResult = yield* managedPolicy.read.pipe(
            Effect.map((found) => ({ ok: true as const, policy: found?.document })),
            Effect.orElseSucceed(() => ({ ok: false as const })),
          );
          if (!policyResult.ok) {
            return (state = {
              ...idleState(),
              error: "Managed access policy could not be checked. The tunnel was not started.",
            });
          }
          if (myGeneration !== generation) return state;
          const policy = policyResult.policy;
          if (
            (policy?.limits?.clients !== undefined && !policy.limits.clients.includes("remote")) ||
            policy?.limits?.connect === false
          ) {
            return (state = {
              ...idleState(),
              error: "Remote access is disabled by your organization's policy.",
            });
          }

          yield* shellEnvironment.awaitDiscovery;
          if (myGeneration !== generation) return state;
          const backendConfig = yield* serverExposure.backendConfig;
          if (myGeneration !== generation) return state;
          if (backendConfig.bindHost !== "127.0.0.1") {
            return (state = {
              ...idleState(),
              error: "Set desktop network access to Local only before starting this tunnel.",
            });
          }

          const primaryBackend = yield* backendPool.primary;
          const primarySnapshot = yield* primaryBackend.snapshot;
          if (!primarySnapshot.ready) {
            return (state = {
              ...idleState(),
              error: "The local desktop backend is not running yet.",
            });
          }
          if (myGeneration !== generation) return state;

          const spawnResult = yield* Effect.try({
            try: () => ({
              child: driver.spawn(
                "ya",
                [
                  "tool",
                  "tunneler",
                  "--json",
                  "--destination",
                  `127.0.0.1:${backendConfig.port}`,
                  "--public-domain",
                  "yandex-team.ru",
                ],
                {
                  detached: platform !== "win32",
                  windowsHide: true,
                  stdio: ["ignore", "pipe", "pipe"],
                },
              ),
            }),
            catch: (cause) => ({ cause }),
          }).pipe(Effect.catch((error) => Effect.succeed(error)));
          if ("cause" in spawnResult) {
            const missingYa =
              typeof spawnResult.cause === "object" &&
              spawnResult.cause !== null &&
              "code" in spawnResult.cause &&
              spawnResult.cause.code === "ENOENT";
            return (state = {
              ...idleState(),
              error: missingYa
                ? "Could not find ya on the desktop login shell PATH."
                : "Could not start ya tool tunneler.",
            });
          }
          const childProcess: NodeChildProcess.ChildProcess = spawnResult.child;

          child = childProcess;
          state = { running: true, origin: null, error: null };
          const published = new Promise<DesktopTunnelerState>((resolve) => {
            resolveStart = resolve;
          });

          const backendReadinessMonitor = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(Duration.seconds(1));
              if (child !== childProcess || myGeneration !== generation) return;
              const snapshot = yield* primaryBackend.snapshot;
              if (!snapshot.ready) {
                stopWithError(
                  "The local desktop backend stopped. Start the tunnel again when it is ready.",
                );
                return;
              }
            }
          });

          const stdout = NodeReadline.createInterface({ input: childProcess.stdout! });
          const stderr = NodeReadline.createInterface({ input: childProcess.stderr! });
          stdout.on("line", (line) => {
            if (child !== childProcess || myGeneration !== generation) return;
            const event = decodeJsonLine(line);
            if (event?.schema_version !== 1) return;
            if (event.type === "tunnel_published") {
              const origin = parseTunnelerOrigin(event.public_url);
              if (origin === null) {
                stopWithError("Tunneler returned an invalid workstation address.");
                return;
              }
              state = { running: true, origin, error: null };
              finishStart(null);
            } else if (event.type === "retry_scheduled") {
              stopWithError("The tunnel connection was interrupted. Start it again to reconnect.");
            } else if (event.type === "error") {
              const errorCode = typeof event.error?.code === "string" ? event.error.code : "";
              stopWithError(
                TUNNELER_ERROR_MESSAGES[errorCode] ?? "Tunneler failed. Start it again to retry.",
              );
            }
          });
          // Both output pipes are drained independently; their contents can contain private credentials.
          stderr.on("line", () => {});
          childProcess.once("error", (error) => {
            if (child !== childProcess || myGeneration !== generation) return;
            const message =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
                ? "Could not find ya on the desktop login shell PATH."
                : "Could not start ya tool tunneler.";
            stopWithError(message);
          });
          childProcess.once("close", () => {
            if (child !== childProcess) return;
            child = null;
            interruptFiber(startupTimeoutFiber);
            startupTimeoutFiber = null;
            interruptFiber(killTimerFiber);
            killTimerFiber = null;
            if (stopping !== null) return;
            if (state.error !== null) {
              state = { ...idleState(), error: state.error };
            } else if (myGeneration === generation) {
              state = { ...idleState(), error: "Tunneler stopped unexpectedly." };
            } else if (stopping === null) {
              state = idleState();
            }
            finishStart(state.error);
          });

          startupTimeoutFiber = runFork(
            Effect.sleep(START_TIMEOUT).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (child === childProcess) {
                    stopWithError("Tunneler did not publish a workstation address in time.");
                  }
                }),
              ),
            ),
          );
          yield* Effect.forkIn(backendReadinessMonitor, serviceScope);
          return yield* Effect.promise(() => published);
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (myGeneration === generation) {
                state = result;
                starting = false;
              }
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (myGeneration === generation) starting = false;
            }),
          ),
        );
      });

      const getState = Effect.sync(() => state);
      const stop = Effect.promise(stopNow);
      const onExit = () => {
        if (child !== null) driver.terminate(child, "SIGTERM", platform);
      };
      process.once("exit", onExit);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => {
          process.removeListener("exit", onExit);
          interruptFiber(startupTimeoutFiber);
          interruptFiber(killTimerFiber);
          return stopNow().then(() => undefined);
        }),
      );

      return DesktopTunneler.of({ start, getState, stop });
    }),
  );

export const layer = layerWithProcessDriver(defaultProcessDriver);
