import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { suppressContextMenu } from "./contextMenu";

document.addEventListener("contextmenu", suppressContextMenu);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
