import { useEffect, useRef, useState } from "react";
import { createPin, openPlexLogin, pollPin } from "./api";

export type PlexLoginStatus = "idle" | "waiting" | "completing";

interface PlexLoginState {
  status: PlexLoginStatus;
  busy: boolean;
  buttonLabel: string;
  error?: string;
  start: () => Promise<void>;
}

export function usePlexLogin(
  clientIdentifier: string,
  onAuthenticated: () => void | Promise<void>,
): PlexLoginState {
  const [status, setStatus] = useState<PlexLoginStatus>("idle");
  const [error, setError] = useState<string>();
  const cancelled = useRef(false);
  const inProgress = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const start = async () => {
    if (inProgress.current) return;

    inProgress.current = true;
    cancelled.current = false;
    setError(undefined);
    setStatus("waiting");

    try {
      const pin = await createPin();
      if (cancelled.current) return;

      await openPlexLogin(clientIdentifier, pin.code);
      const deadline = Date.now() + Math.max(60, pin.expiresIn || 300) * 1000;

      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (cancelled.current) return;

        const current = await pollPin(pin.id);
        if (cancelled.current) return;

        if (current.authenticated) {
          setStatus("completing");
          await onAuthenticated();
          return;
        }
      }

      if (cancelled.current) return;
      throw new Error("登录码已过期，请重新开始。");
    } catch (reason) {
      if (cancelled.current) return;
      inProgress.current = false;
      setStatus("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const busy = status !== "idle";
  const buttonLabel = status === "completing"
    ? "正在完成登录"
    : status === "waiting"
      ? "等待浏览器确认"
      : "使用 Plex 账号登录";

  return { status, busy, buttonLabel, error, start };
}
