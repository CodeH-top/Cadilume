import ReactDOM from "react-dom/client";
import App from "./App";
import { applyBrandPreset, readInitialBrandPreset } from "./brand";
import { suppressContextMenu } from "./contextMenu";
import { applyThemeMode, readInitialThemeMode } from "./theme";
import { isDesktopRuntime, nativeAudioHeartbeat } from "./api";

document.addEventListener("contextmenu", suppressContextMenu);
applyThemeMode(readInitialThemeMode());
applyBrandPreset(readInitialBrandPreset());

if (isDesktopRuntime()) {
  // The native engine remains independent while the window is hidden. For a
  // visible renderer, Rust confirms two consecutive stale-heartbeat windows
  // before stopping, avoiding false positives after sleep or transient load.
  setInterval(() => {
    nativeAudioHeartbeat().catch(() => undefined);
  }, 1000);
}

// keepalive-for-react portals are not compatible with React.StrictMode's
// development-only mount/unmount probe. Rendering the app once keeps history
// route entries alive in the same way as the production build.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
