import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyBrandPreset, readInitialBrandPreset } from "./brand";
import { suppressContextMenu } from "./contextMenu";
import { applyThemeMode, readInitialThemeMode } from "./theme";
import { isDesktopRuntime, nativeAudioHeartbeat, nativeAudioStop } from "./api";

document.addEventListener("contextmenu", suppressContextMenu);
applyThemeMode(readInitialThemeMode());
applyBrandPreset(readInitialBrandPreset());

/** 播放安全保护：任何前端异常、未处理拒绝或主线程疑似卡顿，都立即停掉音频。 */
function stopPlaybackForSafety(reason: string) {
  nativeAudioStop().catch(() => undefined);
  console.error(`[播放保护] ${reason}，已立即停止播放`);
}

window.addEventListener("error", (event) => {
  stopPlaybackForSafety(`页面异常：${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  stopPlaybackForSafety(`未处理的 Promise 异常：${String(event.reason ?? "unknown")}`);
});

if (isDesktopRuntime()) {
  // 1s 心跳给 Rust 看门狗（Rust 端 6s 没收到就自动停播，覆盖 WebView/主线程
  // 彻底卡死的情况）；同时用相邻两次 tick 的间隔检测前端主线程自身卡顿。
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > 3000) {
      stopPlaybackForSafety(`主线程疑似卡顿 ${Math.round(gap)}ms`);
    }
    nativeAudioHeartbeat().catch(() => undefined);
  }, 1000);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
