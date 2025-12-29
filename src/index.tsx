import { serve } from "bun";
import index from "./index.html";

const port = Number(process.env["PORT"] || 3000);
const server = serve({
  routes: {
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,

    console: true,
  },
  port,
});

console.log(`🚀 Server running at ${server.url}`);
