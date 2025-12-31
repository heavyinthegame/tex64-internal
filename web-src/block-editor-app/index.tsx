import React from "react";
import { createRoot } from "react-dom/client";
import { BlockEditorApp } from "./App";

type FatalError = Error | string;

const renderFatalOverlay = (error: FatalError) => {
  const container = document.getElementById("root") ?? document.body;
  if (!container) {
    return;
  }
  const message = typeof error === "string" ? error : error.stack || error.message;
  const overlayId = "block-editor-fatal";
  let overlay = document.getElementById(overlayId);
  if (!overlay) {
    overlay = document.createElement("pre");
    overlay.id = overlayId;
    overlay.style.cssText = [
      "position: fixed",
      "inset: 16px",
      "background: #0f172a",
      "color: #f8fafc",
      "padding: 16px",
      "border-radius: 12px",
      "font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      "white-space: pre-wrap",
      "z-index: 9999",
      "overflow: auto",
    ].join(";");
    container.appendChild(overlay);
  }
  overlay.textContent = `Block editor crashed:\n\n${message}`;
};

window.addEventListener("error", (event) => {
  if (event.error) {
    renderFatalOverlay(event.error);
  } else if (event.message) {
    renderFatalOverlay(event.message);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  renderFatalOverlay(event.reason instanceof Error ? event.reason : String(event.reason));
});

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    renderFatalOverlay(error);
  }

  render() {
    if (this.state.error) {
      return null;
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <BlockEditorApp />
    </ErrorBoundary>
  );
}
