import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyBrandPreset, readInitialBrandPreset } from "./brand";
import { suppressContextMenu } from "./contextMenu";
import { applyThemeMode, readInitialThemeMode } from "./theme";

document.addEventListener("contextmenu", suppressContextMenu);
applyThemeMode(readInitialThemeMode());
applyBrandPreset(readInitialBrandPreset());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
