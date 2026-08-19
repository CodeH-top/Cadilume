import { useEffect, useRef, useState } from "react";
import { cancelPin, createPin, openPlexLogin, pollPin } from "./api";

export type PlexLoginStatus = "idle" | "waiting" | "completing";

interface PlexLoginState {
  status: PlexLoginStatus;
  busy: boolean;
  buttonLabel: string;
  error?: string;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function usePlexLogin(
  clientIdentifier: string,
  onAuthenticated: () => void | Promise<void>,
): PlexLoginState {
  const [status, setStatus] = useState<PlexLoginStatus>("idle");
  const [error, setError] = useState<string>();
  const inProgress = useRef(false);
  const attemptId = useRef(0);
  const activePinId = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      attemptId.current += 1;
      inProgress.current = false;
      const pinId = activePinId.current;
      activePinId.current = undefined;
      if (pinId !== undefined) void cancelPin(pinId).catch(() => undefined);
    };
  }, []);

  const start = async () => {
    if (inProgress.current) return;

    const currentAttempt = attemptId.current + 1;
    attemptId.current = currentAttempt;
    inProgress.current = true;
    setError(undefined);
    setStatus("waiting");

    try {
      const pin = await createPin();
      if (attemptId.current !== currentAttempt) {
        await cancelPin(pin.id).catch(() => undefined);
        return;
      }
      activePinId.current = pin.id;

      await openPlexLogin(clientIdentifier, pin.code);
      if (attemptId.current !== currentAttempt) {
        await cancelPin(pin.id).catch(() => undefined);
        return;
      }
      const deadline = Date.now() + Math.max(60, pin.expiresIn || 300) * 1000;

      while (attemptId.current === currentAttempt && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (attemptId.current !== currentAttempt) return;

        const current = await pollPin(pin.id);
        if (attemptId.current !== currentAttempt) return;

        if (current.authenticated) {
          activePinId.current = undefined;
          setStatus("completing");
          await onAuthenticated();
          return;
        }
      }

      if (attemptId.current !== currentAttempt) return;
      throw new Error("登录码已过期，请重新开始。");
    } catch (reason) {
      if (attemptId.current !== currentAttempt) return;
      const pinId = activePinId.current;
      activePinId.current = undefined;
      if (pinId !== undefined) void cancelPin(pinId).catch(() => undefined);
      inProgress.current = false;
      setStatus("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancel = async () => {
    if (!inProgress.current) return;
    attemptId.current += 1;
    inProgress.current = false;
    const pinId = activePinId.current;
    activePinId.current = undefined;
    setStatus("idle");
    setError(undefined);
    if (pinId !== undefined) await cancelPin(pinId).catch(() => undefined);
  };

  const busy = status !== "idle";
  const buttonLabel = status === "completing"
    ? "正在完成登录"
    : status === "waiting"
      ? "等待浏览器确认"
      : "使用 Plex 账号登录";

  return { status, busy, buttonLabel, error, start, cancel };
}
