import { serve } from "bun";
import index from "./index.html";

const port = Number(process.env.PORT || 3000);
const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,
    "/api/dev-data/positions": {
      async GET() {
        try {
          const p = `${process.cwd()}/dev-data/positions.json`;
          const f = Bun.file(p);
          const txt = await f.text();
          return new Response(txt, { headers: { "Content-Type": "application/json" } });
        } catch (e) {
          return Response.json({ error: "positions not found" }, { status: 404 });
        }
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
  port,
});

console.log(`🚀 Server running at ${server.url}`);
