import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { Root } from "react-dom/client";

const elem = document.getElementById("root")!;

const hotData = import.meta.hot?.data as { root?: Root } | undefined;
const root: Root = hotData?.root ?? createRoot(elem);
if (hotData) hotData.root = root;

// Material Symbols render as ligature glyphs only once the font is actually loaded.
document.fonts.ready
  .then(() => document.fonts.load('1em "Material Symbols Outlined"'))
  .catch(() => undefined)
  .finally(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  });
