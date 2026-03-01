import { serve } from "bun";
import indexHtml from "./index.html";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env["PORT"] || 3000);

if (isProduction) {
  // Production: serve static files from dist with SPA fallback
  serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Try file in dist
      const filePath = `dist${pathname}`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }

      // Try directory index
      const dirPath = `dist${pathname}/index.html`;
      const dirFile = Bun.file(dirPath);
      if (await dirFile.exists()) {
        return new Response(dirFile);
      }

      // SPA fallback
      return new Response(Bun.file("dist/index.html"));
    },
  });
} else {
  // Development: serve with HMR and static assets
  serve({
    port,
    routes: {
      "/assets/**": Bun.file("src/assets"),
      "/*": indexHtml,
    },
    development: {
      hmr: true,
      console: true,
    },
  });
}

console.log(`🚀 Server running at http://localhost:${port}`);
