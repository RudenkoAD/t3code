import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayClient from "@t3tools/shared/relayClient";

/** This fork pairs directly over the corporate Tunneler instead of T3 Connect. */
export const LEGACY_CLOUD_CONNECT_ENABLED = false;

export const LegacyCloudConnectEnabled = Context.Reference<boolean>(
  "t3/cloud/LegacyCloudConnectEnabled",
  { defaultValue: () => true },
);

export const LEGACY_CLOUD_CONNECT_DISABLED_MESSAGE =
  "T3 Connect is disabled in this build. Use direct pairing from the desktop app.";

const refuseInstall = () =>
  Effect.fail(
    new RelayClient.RelayClientInstallError({
      reason: "managed_by_policy",
      message: LEGACY_CLOUD_CONNECT_DISABLED_MESSAGE,
    }),
  );

/** A hard stop: legacy or explicitly requested cloud configs cannot install cloudflared. */
export const layerDisabledRelayClient = Layer.succeed(
  RelayClient.RelayClient,
  RelayClient.RelayClient.of({
    resolve: Effect.succeed({ status: "missing", version: RelayClient.CLOUDFLARED_VERSION }),
    install: refuseInstall(),
    installWithProgress: refuseInstall,
    pruneManagedVersions: Effect.void,
  }),
);
