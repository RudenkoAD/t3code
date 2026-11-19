import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- these fixtures must mimic subprocess pipes
import * as NodeStream from "node:stream";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import {
  layerWithProcessDriver,
  parseTunnelerOrigin,
  type DesktopTunnelerProcessDriver,
  DesktopTunneler,
} from "./DesktopTunneler.ts";

type FakeProcess = Parameters<DesktopTunnelerProcessDriver["terminate"]>[0];

describe("parseTunnelerOrigin", () => {
  it.each([
    "https://owner-7-vla-1.tun.si.yandex-team.ru",
    "https://owner-7-vla-1.tunneler-si.yandex-team.ru/",
  ])("accepts workstation tunnel hostname %s", (value) => {
    assert.strictEqual(parseTunnelerOrigin(value), new URL(value).origin);
  });

  it.each([
    "http://owner-7-vla-1.tun.si.yandex-team.ru",
    "https://yandex-team.ru",
    "https://owner-7-vla-1.tun.si.yandex-team.ru.attacker.example",
    "https://owner-7-vla-1.tun.si.yandex-team.ru:8443",
    "https://user:secret@owner-7-vla-1.tun.si.yandex-team.ru",
    "https://owner-7-vla-1.tun.si.yandex-team.ru/private",
    "not a url",
  ])("rejects unsafe or malformed address %s", (value) => {
    assert.isNull(parseTunnelerOrigin(value));
  });
});

class FakeChild extends NodeEvents.EventEmitter {
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly pid = undefined;
  kill = (signal: NodeJS.Signals) => {
    this.emit("close", null, signal);
    return true;
  };
}

const makeLayer = (children: FakeChild[], driverOverride?: DesktopTunnelerProcessDriver) => {
  const spawned = new NodeEvents.EventEmitter();
  const underlyingDriver: DesktopTunnelerProcessDriver = driverOverride ?? {
    spawn: (() =>
      new FakeChild() as unknown as FakeProcess) as DesktopTunnelerProcessDriver["spawn"],
    terminate: (child) => (child as unknown as FakeChild).emit("close", null, "SIGTERM"),
  };
  const driver: DesktopTunnelerProcessDriver = {
    ...underlyingDriver,
    spawn: ((...args: Parameters<DesktopTunnelerProcessDriver["spawn"]>) => {
      const child = underlyingDriver.spawn(...args);
      children.push(child as unknown as FakeChild);
      setImmediate(() => spawned.emit("spawn", child));
      return child;
    }) as DesktopTunnelerProcessDriver["spawn"],
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(DesktopServerExposure.DesktopServerExposure, {
      backendConfig: Effect.succeed({
        port: 4123,
        bindHost: "127.0.0.1",
      } as DesktopServerExposure.DesktopServerExposureBackendConfig),
    }),
    Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {
      read: Effect.undefined,
    }),
    DesktopAppSettings.layerTest({
      ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      localEnvironmentEnabled: true,
    }),
    Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment, {
      awaitDiscovery: Effect.succeed(true),
    }),
    DesktopBackendPool.layerTest([
      {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Local"),
        start: Effect.void,
        stop: () => Effect.void,
        currentConfig: Effect.succeedNone,
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.some(123),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(true),
      },
    ]),
  );
  return {
    layer: layerWithProcessDriver(driver).pipe(Layer.provide(dependencies)),
    waitForChild: () => new Promise<FakeChild>((resolve) => spawned.once("spawn", resolve)),
  };
};

describe("DesktopTunneler lifecycle", () => {
  it.effect("stops and restarts the owned child without accepting stale output", () => {
    const children: FakeChild[] = [];
    const fixture = makeLayer(children);
    return Effect.gen(function* () {
      const tunneler = yield* DesktopTunneler;
      const firstChildPromise = fixture.waitForChild();
      const firstStart = yield* Effect.forkScoped(tunneler.start);
      const firstChild = yield* Effect.promise(() => firstChildPromise);
      assert.strictEqual(children.length, 1);
      assert.deepEqual(yield* tunneler.start, { running: true, origin: null, error: null });
      assert.strictEqual(children.length, 1);
      firstChild.stdout.write(
        '{"schema_version":1,"type":"tunnel_published","public_url":"https://host-a.tun.si.yandex-team.ru"}\n',
      );
      assert.deepEqual(yield* Fiber.join(firstStart), {
        running: true,
        origin: "https://host-a.tun.si.yandex-team.ru",
        error: null,
      });

      assert.deepEqual(yield* tunneler.stop, { running: false, origin: null, error: null });
      firstChild.stdout.write(
        '{"schema_version":1,"type":"tunnel_published","public_url":"https://stale.tun.si.yandex-team.ru"}\n',
      );
      const secondChildPromise = fixture.waitForChild();
      const secondStart = yield* Effect.forkScoped(tunneler.start);
      const secondChild = yield* Effect.promise(() => secondChildPromise);
      assert.strictEqual(children.length, 2);
      secondChild.stdout.write(
        '{"schema_version":1,"type":"tunnel_published","public_url":"https://host-b.tun.si.yandex-team.ru"}\n',
      );
      assert.deepEqual(yield* Fiber.join(secondStart), {
        running: true,
        origin: "https://host-b.tun.si.yandex-team.ru",
        error: null,
      });
      yield* tunneler.stop;

      const rejectedChildPromise = fixture.waitForChild();
      const rejectedStart = yield* Effect.forkScoped(tunneler.start);
      const rejectedChild = yield* Effect.promise(() => rejectedChildPromise);
      rejectedChild.stdout.write(
        '{"schema_version":1,"type":"error","error":{"code":"identity_failed","message":"private detail"}}\n',
      );
      assert.deepEqual(yield* Fiber.join(rejectedStart), {
        running: true,
        origin: null,
        error: "Tunneler could not authenticate.",
      });
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect("reports a missing ya executable without exposing process output", () => {
    const children: FakeChild[] = [];
    const driver = {
      spawn: (() => {
        return new FakeChild() as unknown as FakeProcess;
      }) as DesktopTunnelerProcessDriver["spawn"],
      terminate: (child) => (child as unknown as FakeChild).emit("close"),
    } satisfies DesktopTunnelerProcessDriver;
    const fixture = makeLayer(children, driver);
    return Effect.gen(function* () {
      const tunneler = yield* DesktopTunneler;
      const childPromise = fixture.waitForChild();
      const starting = yield* Effect.forkScoped(tunneler.start);
      const child = yield* Effect.promise(() => childPromise);
      const missing = Object.assign(new Error("private stderr must not be reported"), {
        code: "ENOENT",
      });
      child.emit("error", missing);
      assert.equal(
        (yield* Fiber.join(starting)).error,
        "Could not find ya on the desktop login shell PATH.",
      );
      child.emit("close");

      const restartedChildPromise = fixture.waitForChild();
      const restarted = yield* Effect.forkScoped(tunneler.start);
      const restartedChild = yield* Effect.promise(() => restartedChildPromise);
      restartedChild.stdout.write(
        '{"schema_version":1,"type":"tunnel_published","public_url":"https://recovered.tun.si.yandex-team.ru"}\n',
      );
      assert.deepEqual(yield* Fiber.join(restarted), {
        running: true,
        origin: "https://recovered.tun.si.yandex-team.ru",
        error: null,
      });
      yield* tunneler.stop;
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });
});
