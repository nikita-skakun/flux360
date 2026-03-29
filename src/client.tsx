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
// Wait for @font-face rules to be loaded first (from index.css imports), then request fonts.
// Falls back to rendering anyway if fonts fail (e.g. offline).
Promise.resolve(document.fonts.ready)
  .then(() =>
    Promise.allSettled([
      document.fonts.load('1em "Material Symbols Outlined"'),
    ])
  )
  .finally(render);
