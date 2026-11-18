import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const commands = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));

vi.mock(import("../../state/codexRealtime"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    codexRealtimeEnvironment: {
      ...actual.codexRealtimeEnvironment,
      start: { ...actual.codexRealtimeEnvironment.start, label: "start" },
      stop: { ...actual.codexRealtimeEnvironment.stop, label: "stop" },
    },
  };
});
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => true,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (command: { readonly label: string }) =>
    command.label.includes("start") ? commands.start : commands.stop,
}));

import { CodexRealtimeButton } from "./CodexRealtimeButton";

class TestPeerConnection {
  static latest: TestPeerConnection;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = {
    type: "offer",
    sdp: "offer-sdp",
    toJSON: () => ({ type: "offer", sdp: "offer-sdp" }),
  };
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  addTrack = vi.fn();
  createDataChannel = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "offer-sdp" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn();

  constructor() {
    TestPeerConnection.latest = this;
  }
}

describe("CodexRealtimeButton", () => {
  it("captures audio, applies the SDP answer, toggles mute, and stops the session", async () => {
    commands.start.mockReset();
    commands.stop.mockReset();
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("RTCPeerConnection", TestPeerConnection);
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(getUserMedia);
    commands.start.mockResolvedValue({ _tag: "Success", value: { answer: "answer-sdp" } });
    commands.stop.mockResolvedValue({ _tag: "Success", value: undefined });

    await using screen = await render(
      <CodexRealtimeButton
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        disabled={false}
      />,
    );
    await screen.getByRole("button", { name: "Start live voice" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Mute live voice" }))
      .toBeInTheDocument();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(TestPeerConnection.latest.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp",
    });
    expect(commands.start.mock.calls[0]?.[0].input.offer).toBe("offer-sdp");

    await screen.getByRole("button", { name: "Mute live voice" }).click();
    expect(track.enabled).toBe(false);
    await screen.getByRole("button", { name: "Stop live voice" }).click();
    expect(track.stop).toHaveBeenCalled();
    expect(TestPeerConnection.latest.close).toHaveBeenCalled();
    expect(commands.stop).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: expect.objectContaining({ threadId: ThreadId.make("thread-1") }),
    });
  });

  it("cancels a pending microphone permission request without starting a server call", async () => {
    commands.start.mockReset();
    commands.stop.mockReset();
    const track = { enabled: true, stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | undefined;
    const permission = new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    });
    vi.stubGlobal("RTCPeerConnection", TestPeerConnection);
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);

    await using screen = await render(
      <CodexRealtimeButton
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        disabled={false}
      />,
    );
    await screen.getByRole("button", { name: "Start live voice" }).click();
    await screen.getByRole("button", { name: "Cancel live voice startup" }).click();
    resolvePermission?.(stream);

    await expect
      .element(screen.getByRole("button", { name: "Start live voice" }))
      .toBeInTheDocument();
    expect(track.stop).toHaveBeenCalled();
    expect(commands.start).not.toHaveBeenCalled();
  });
});
