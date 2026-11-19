import type { DesktopBridge, DesktopTunnelerState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

type TunnelerBridge = Pick<DesktopBridge, "getTunnelerState" | "startTunneler" | "stopTunneler">;

export function useDesktopTunneler(bridge: TunnelerBridge | null) {
  const [state, setState] = useState<DesktopTunnelerState | null>(null);
  const [stopping, setStopping] = useState(false);
  const revision = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The desktop owns the child, which can exit or change its address while Settings is open.
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const refresh = async () => {
      const version = revision.current;
      try {
        const next = await bridge.getTunnelerState();
        if (mounted && version === revision.current) {
          setState((previous) =>
            previous?.running === next.running &&
            previous.origin === next.origin &&
            previous.error === next.error
              ? previous
              : next,
          );
        }
      } catch {
        if (mounted && version === revision.current) {
          setState({ running: false, origin: null, error: "Could not read Tunneler status." });
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      mounted = false;
      revision.current++;
      window.clearInterval(timer);
    };
  }, [bridge]);

  async function setRunning(enabled: boolean) {
    if (!bridge) return;
    const version = ++revision.current;
    setStopping(!enabled);
    if (enabled) setState({ running: true, origin: null, error: null });
    try {
      const next = enabled ? await bridge.startTunneler() : await bridge.stopTunneler();
      if (version === revision.current) setState(next);
    } catch (error) {
      if (version === revision.current) {
        setState((previous) => ({
          running: !enabled && (previous?.running ?? false),
          origin: null,
          error: error instanceof Error ? error.message : "Could not change Tunneler state.",
        }));
      }
    } finally {
      if (version === revision.current) {
        revision.current++;
        setStopping(false);
      }
    }
  }

  return { state, stopping, setRunning };
}
