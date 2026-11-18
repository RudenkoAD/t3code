import { AudioWaveformIcon, MicIcon, MicOffIcon, PhoneOffIcon, XIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../../state/use-atom-command";
import { codexRealtimeEnvironment } from "../../state/codexRealtime";
import { useClientSettings } from "../../hooks/useSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Session = {
  id: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  serverRequested: boolean;
  peer: RTCPeerConnection;
  stream: MediaStream;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not start live voice.";
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const checkGathering = () => {
      if (peer.iceGatheringState === "complete" || peer.signalingState === "closed") {
        peer.removeEventListener("icegatheringstatechange", checkGathering);
        peer.removeEventListener("signalingstatechange", checkGathering);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", checkGathering);
    peer.addEventListener("signalingstatechange", checkGathering);
    checkGathering();
  });
}

type RealtimeFailureCause = Parameters<typeof squashAtomCommandFailure>[0]["cause"];
type StartResult =
  | { readonly _tag: "Failure"; readonly cause: RealtimeFailureCause }
  | { readonly _tag: "Success"; readonly value: { readonly answer?: string | null } };
type StopResult =
  | { readonly _tag: "Failure"; readonly cause: RealtimeFailureCause }
  | { readonly _tag: "Success"; readonly value: void };

async function startVoiceSession(input: {
  generation: number;
  microphoneId: string | null | undefined;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  sessionRef: { current: Session | null };
  audioRef: { current: HTMLAudioElement | null };
  mountedRef: { current: boolean };
  startGenerationRef: { current: number };
  startRemote: (request: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; callId: string; offer: string };
  }) => Promise<StartResult>;
  stopRemote: (request: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; callId: string };
  }) => Promise<StopResult>;
  closeSession: (notifyServer: boolean) => Promise<void>;
  setActive: (active: boolean) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}) {
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let remoteStartRequested = false;
  const sessionId = Array.from(SecureRandom.randomBytesUnsafe(16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection) {
      throw new Error("Live voice requires microphone access and WebRTC. Use HTTPS or localhost.");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: input.microphoneId ? { deviceId: { exact: input.microphoneId } } : true,
    });
    if (
      input.generation !== input.startGenerationRef.current ||
      !input.mountedRef.current ||
      !input.audioRef.current?.isConnected
    ) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    peer = new RTCPeerConnection();
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    peer.createDataChannel("oai-events");
    const session: Session = {
      id: sessionId,
      environmentId: input.environmentId,
      threadId: input.threadId,
      serverRequested: false,
      peer,
      stream,
    };
    input.sessionRef.current = session;
    peer.ontrack = (event) => {
      if (input.audioRef.current) {
        input.audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void input.audioRef.current
          .play()
          .catch(() => input.setError("Could not play Codex audio."));
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer?.connectionState === "failed" || peer?.connectionState === "disconnected") {
        input.setError("Live voice disconnected.");
        void input.closeSession(true);
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    if (input.generation !== input.startGenerationRef.current) return;
    const localOfferSdp = peer.localDescription?.sdp;
    if (!localOfferSdp) throw new Error("Could not create a WebRTC offer.");
    remoteStartRequested = true;
    session.serverRequested = true;
    const result = await input.startRemote({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, callId: sessionId, offer: localOfferSdp },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    if (
      input.sessionRef.current !== session ||
      input.generation !== input.startGenerationRef.current
    ) {
      const stopResult = await input.stopRemote({
        environmentId: input.environmentId,
        input: { threadId: input.threadId, callId: sessionId },
      });
      if (stopResult._tag === "Failure") squashAtomCommandFailure(stopResult);
      return;
    }
    const answer = result.value;
    if (!answer?.answer) throw new Error("Codex did not return a realtime answer.");
    await peer.setRemoteDescription({ type: "answer", sdp: answer.answer });
    if (input.sessionRef.current !== session) return;
    input.setActive(true);
  } catch (cause) {
    if (input.sessionRef.current?.id === sessionId) input.sessionRef.current = null;
    peer?.close();
    stream?.getTracks().forEach((track) => track.stop());
    if (remoteStartRequested) {
      const result = await input.stopRemote({
        environmentId: input.environmentId,
        input: { threadId: input.threadId, callId: sessionId },
      });
      if (result._tag === "Failure") squashAtomCommandFailure(result);
    }
    if (input.generation !== input.startGenerationRef.current || !input.mountedRef.current) return;
    input.setError(errorMessage(cause));
  } finally {
    if (input.generation === input.startGenerationRef.current && input.mountedRef.current)
      input.setBusy(false);
  }
}

interface VoiceButtonProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  disabled: boolean;
}

export const CodexRealtimeButton = memo(function CodexRealtimeButton(props: VoiceButtonProps) {
  const canStart = useAtomValue(codexRealtimeEnvironment.start.permissionAtom(props.environmentId));
  const disabled = props.disabled || !canStart;
  return (
    <VoiceCallControl key={disabled ? "disabled" : "available"} {...props} disabled={disabled} />
  );
});

function VoiceCallControl(props: VoiceButtonProps) {
  const startRemote = useAtomCommand(codexRealtimeEnvironment.start, { reportFailure: false });
  const stopRemote = useAtomCommand(codexRealtimeEnvironment.stop, { reportFailure: false });
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const sessionRef = useRef<Session | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const mountedRef = useRef(true);
  const startGenerationRef = useRef(0);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopLatest = useEffectEvent(async (session: Session) => {
    await stopRemote({
      environmentId: session.environmentId,
      input: { threadId: session.threadId, callId: session.id },
    });
  });

  const closeSession = async (notifyServer: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setActive(false);
    setMuted(false);
    if (!session) return;
    session.peer.onconnectionstatechange = null;
    session.peer.ontrack = null;
    session.peer.close();
    for (const track of session.stream.getTracks()) track.stop();
    if (audioRef.current) audioRef.current.srcObject = null;
    if (notifyServer && session.serverRequested) {
      const result = await stopRemote({
        environmentId: session.environmentId,
        input: { threadId: session.threadId, callId: session.id },
      });
      if (result._tag === "Failure") {
        setError(errorMessage(squashAtomCommandFailure(result)));
      }
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps pending getUserMedia work in sync with the mounted control
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startGenerationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      session.peer.close();
      for (const track of session.stream.getTracks()) track.stop();
      if (audioRef.current) audioRef.current.srcObject = null;
      if (session.serverRequested) void stopLatest(session);
    };
  }, []);

  const start = () => {
    if (busy || active || props.disabled) return;
    const generation = ++startGenerationRef.current;
    setBusy(true);
    setError(null);
    void startVoiceSession({
      generation,
      microphoneId,
      environmentId: props.environmentId,
      threadId: props.threadId,
      sessionRef,
      audioRef,
      mountedRef,
      startGenerationRef,
      startRemote,
      stopRemote,
      closeSession,
      setActive,
      setBusy,
      setError,
    });
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    for (const track of sessionRef.current?.stream.getAudioTracks() ?? [])
      track.enabled = !nextMuted;
    setMuted(nextMuted);
  };

  return (
    <div className="inline-flex items-center gap-1" data-codex-realtime>
      <audio ref={audioRef} autoPlay className="sr-only" aria-hidden="true" />
      {active ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant={muted ? "outline" : "secondary"}
                  aria-label={muted ? "Unmute live voice" : "Mute live voice"}
                  onClick={toggleMute}
                />
              }
            >
              {muted ? <MicOffIcon /> : <MicIcon />}
            </TooltipTrigger>
            <TooltipPopup>{muted ? "Unmute microphone" : "Mute microphone"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="destructive"
                  aria-label="Stop live voice"
                  onClick={() => void closeSession(true)}
                />
              }
            >
              <PhoneOffIcon />
            </TooltipTrigger>
            <TooltipPopup>Stop live voice</TooltipPopup>
          </Tooltip>
        </>
      ) : busy ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label="Cancel live voice startup"
                onClick={() => {
                  startGenerationRef.current += 1;
                  setBusy(false);
                  void closeSession(true);
                }}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Cancel live voice startup</TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={error ? `Live voice error: ${error}` : "Start live voice"}
                disabled={props.disabled}
                onClick={() => void start()}
              />
            }
          >
            <AudioWaveformIcon />
          </TooltipTrigger>
          <TooltipPopup>{error ?? "Start live voice with Codex"}</TooltipPopup>
        </Tooltip>
      )}
      {error ? (
        <span
          className="inline-flex max-w-48 items-center gap-1 text-destructive text-xs"
          role="alert"
        >
          <span className="truncate">{error}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss live voice error"
            onClick={() => setError(null)}
          >
            <XIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
