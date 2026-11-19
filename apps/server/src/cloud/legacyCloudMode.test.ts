import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RelayClient from "@t3tools/shared/relayClient";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { requireConnectAllowed } from "../cli/connect.ts";
import { LegacyCloudConnectEnabled } from "./legacyCloudMode.ts";
import { layerDisabledRelayClient } from "./legacyCloudMode.ts";

it.effect("legacy fork mode never installs cloudflared", () =>
  Effect.gen(function* () {
    const relayClient = yield* RelayClient.RelayClient;
    assert.deepEqual(yield* relayClient.resolve, {
      status: "missing",
      version: RelayClient.CLOUDFLARED_VERSION,
    });
    const failure = yield* Effect.flip(relayClient.install);
    assert.equal(failure.reason, "managed_by_policy");
    assert.include(failure.message, "direct pairing");
  }).pipe(Effect.provide(layerDisabledRelayClient)),
);

it.effect("legacy fork mode refuses cloud linking from the CLI", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(requireConnectAllowed);
    assert.include(failure.message, "direct pairing");
  }).pipe(
    Effect.provideService(LegacyCloudConnectEnabled, false),
    Effect.provide(ManagedPolicy.layerTest()),
  ),
);
