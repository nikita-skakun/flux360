import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const elem = document.getElementById("root")!;

const render = () => {
  const app = (
    <StrictMode>
      <App />
    </StrictMode>
  );

  if (import.meta.hot) {
    const root = (import.meta.hot.data.root ??= createRoot(elem));
    root.render(app);
  } else {
    createRoot(elem).render(app);
  }
};

// Explicitly load icon fonts before first render so ligatures work immediately.
// Falls back to rendering anyway if fonts fail (e.g. offline).
Promise.all([
  document.fonts.load('1em "Material Symbols Outlined"'),
  document.fonts.load('1em "Material Icons"'),
]).finally(render);
