import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installBrowserMock } from "./lib/tauri-mock";

installBrowserMock();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
