import { StrictMode } from "preact/compat";
import { createRoot } from "preact/compat/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
