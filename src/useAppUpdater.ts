import { useCallback, useEffect, useRef, useState } from "react";
import { checkAppUpdate, installAppUpdate, setAutoUpdateEnabled } from "./api";
import type { GlobalNotificationLevel } from "./notifications";
import type { AppUpdateEvent, AppUpdateInfo, BootstrapResponse } from "./types";

type Notify = (message: string, level?: GlobalNotificationLevel) => void;

export interface AppUpdaterController {
  supported: boolean;
  currentVersion: string;
  autoUpdateEnabled: boolean;
  availableUpdate?: AppUpdateInfo;
  checking: boolean;
  installing: boolean;
  preferenceSaving: boolean;
  progressPercent?: number;
  error?: string;
  checkForUpdate: (manual?: boolean) => Promise<AppUpdateInfo | undefined>;
  installUpdate: () => Promise<void>;
  changeAutoUpdateEnabled: (enabled: boolean) => Promise<void>;
}

export function displayAppVersion(version: string): string {
  const normalized = version.trim();
  if (!normalized) return "未知版本";
  return normalized.toLowerCase().startsWith("v") ? normalized : `v${normalized}`;
}

export function updateDownloadPercent(downloaded: number, contentLength: number | null): number | undefined {
  if (!Number.isFinite(downloaded) || downloaded < 0 || !contentLength || !Number.isFinite(contentLength) || contentLength <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((downloaded / contentLength) * 100)));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function useAppUpdater(
  session: BootstrapResponse | undefined,
  notify: Notify,
): AppUpdaterController {
  const supported = Boolean(session?.appUpdateSupported);
  const currentVersion = session?.appVersion || "";
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState(Boolean(session?.autoUpdateEnabled));
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo>();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [progressPercent, setProgressPercent] = useState<number>();
  const [error, setError] = useState<string>();
  const operationRef = useRef<"check" | "install" | undefined>(undefined);
  const preferenceSavingRef = useRef(false);
  const autoCheckStartedRef = useRef(false);

  useEffect(() => {
    if (session) setAutoUpdateEnabledState(session.autoUpdateEnabled);
  }, [session, session?.autoUpdateEnabled]);

  const checkForUpdate = useCallback(async (manual = true) => {
    if (!supported || operationRef.current) return availableUpdate;
    operationRef.current = "check";
    setChecking(true);
    setError(undefined);
    try {
      const update = await checkAppUpdate();
      setAvailableUpdate(update);
      if (update) {
        notify(`发现 Cadilume ${displayAppVersion(update.version)}，可在设置中安装。`, "info");
      } else if (manual) {
        notify(`Cadilume ${displayAppVersion(currentVersion)} 已是最新版本。`, "success");
      }
      return update;
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      if (manual) notify(`检查更新失败：${message}`, "error");
      return undefined;
    } finally {
      operationRef.current = undefined;
      setChecking(false);
    }
  }, [availableUpdate, currentVersion, notify, supported]);

  useEffect(() => {
    if (!supported || !autoUpdateEnabled || autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    void checkForUpdate(false);
  }, [autoUpdateEnabled, checkForUpdate, supported]);

  const installUpdate = useCallback(async () => {
    if (!supported || !availableUpdate || operationRef.current) return;
    operationRef.current = "install";
    setInstalling(true);
    setProgressPercent(undefined);
    setError(undefined);
    try {
      await installAppUpdate((event: AppUpdateEvent) => {
        if (event.event === "progress") {
          setProgressPercent(updateDownloadPercent(event.downloaded, event.contentLength));
        } else if (event.event === "downloaded") {
          setProgressPercent(100);
        }
      });
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      notify(`安装更新失败：${message}`, "error");
    } finally {
      operationRef.current = undefined;
      setInstalling(false);
    }
  }, [availableUpdate, notify, supported]);

  const changeAutoUpdateEnabled = useCallback(async (enabled: boolean) => {
    if (!supported || preferenceSavingRef.current) return;
    const previous = autoUpdateEnabled;
    preferenceSavingRef.current = true;
    setPreferenceSaving(true);
    setAutoUpdateEnabledState(enabled);
    try {
      const saved = await setAutoUpdateEnabled(enabled);
      setAutoUpdateEnabledState(saved);
      notify(saved ? "已开启自动检查更新。" : "已关闭自动检查更新。", "success");
    } catch (reason) {
      setAutoUpdateEnabledState(previous);
      notify(`无法保存更新设置：${errorMessage(reason)}`, "error");
    } finally {
      preferenceSavingRef.current = false;
      setPreferenceSaving(false);
    }
  }, [autoUpdateEnabled, notify, supported]);

  return {
    supported,
    currentVersion,
    autoUpdateEnabled,
    availableUpdate,
    checking,
    installing,
    preferenceSaving,
    progressPercent,
    error,
    checkForUpdate,
    installUpdate,
    changeAutoUpdateEnabled,
  };
}
