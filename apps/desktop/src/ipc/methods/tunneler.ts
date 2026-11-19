import { DesktopTunnelerStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopTunneler from "../../backend/DesktopTunneler.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const startTunneler = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_TUNNELER_CHANNEL,
  payload: Schema.Void,
  result: DesktopTunnelerStateSchema,
  handler: Effect.fn("desktop.ipc.tunneler.start")(function* () {
    const tunneler = yield* DesktopTunneler.DesktopTunneler;
    return yield* tunneler.start;
  }),
});

export const getTunnelerState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_TUNNELER_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopTunnelerStateSchema,
  handler: Effect.fn("desktop.ipc.tunneler.getState")(function* () {
    const tunneler = yield* DesktopTunneler.DesktopTunneler;
    return yield* tunneler.getState;
  }),
});

export const stopTunneler = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_TUNNELER_CHANNEL,
  payload: Schema.Void,
  result: DesktopTunnelerStateSchema,
  handler: Effect.fn("desktop.ipc.tunneler.stop")(function* () {
    const tunneler = yield* DesktopTunneler.DesktopTunneler;
    return yield* tunneler.stop;
  }),
});
