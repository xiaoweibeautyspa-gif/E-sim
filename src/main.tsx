/**
 * Client entry point.
 *
 * Mounts the App into #root. Styles are imported here so Tailwind's generated
 * CSS is part of the initial bundle. Kept deliberately tiny; routing is
 * handled inside App for now.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found in index.html.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
