import { serve } from "bun";
import indexHtml from "./index.html";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env["PORT"] || 3000);

interface Config {
  traccarBaseUrl: string;
  traccarSecure: boolean;
  maptilerApiKey: string;
  mockMode: boolean;
}

// Validate mandatory configuration on startup
const configFile = Bun.file("config.json");
if (!(await configFile.exists())) {
  console.error("Error: config.json is missing. Please create it based on config.sample.json.");
  process.exit(1);
}

let config: Config;
try {
  config = await configFile.json();
} catch (e) {
  console.error("Error: config.json is not valid JSON.");
  process.exit(1);
}

const requiredFields: (keyof Config)[] = ["traccarBaseUrl", "maptilerApiKey"];
const isMockMode = process.argv.includes("--mock");
if (isMockMode) {
  console.log("Mock Mode enabled via CLI flag");
}

const missingFields = requiredFields.filter(field => !config[field]);

if (missingFields.length > 0) {
  console.error(`Error: Mandatory configuration fields are missing in config.json: ${missingFields.join(", ")}`);
  process.exit(1);
}

async function verifyTraccarSession(request: Request): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  try {
    let baseUrl = config.traccarBaseUrl.trim();
    let host = baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

    // Check if it already has /api
    const hasApi = host.endsWith("/api") || host.includes("/api/");
    if (hasApi) {
      host = host.replace(/\/api\/?.*$/, "");
    }

    const protocol = config.traccarSecure ? "https" : "http";
    const verificationUrl = `${protocol}://${host}/api/devices?limit=1`;

    const response = await fetch(verificationUrl, {
      headers: {
        "Authorization": authHeader,
        "Accept": "application/json"
      },
    });

    return response.ok;
  } catch (e) {
    return false;
  }
}

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
      if (pathname === "/api/config") {
        return Response.json({
          traccarBaseUrl: config.traccarBaseUrl,
          traccarSecure: config.traccarSecure,
          mockMode: isMockMode,
        });
      }

      if (pathname === "/api/config/maptiler") {
        if (!(await verifyTraccarSession(request))) {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json({
          maptilerApiKey: config.maptilerApiKey,
        });
      }

      return new Response(Bun.file("dist/index.html"));
    },
  });
} else {
  // Development: serve with HMR and static assets
  serve({
    port,
    routes: {
      "/api/config": async () => {
        return Response.json({
          traccarBaseUrl: config.traccarBaseUrl,
          traccarSecure: config.traccarSecure,
          mockMode: isMockMode,
        });
      },
      "/api/config/maptiler": async (request: Request) => {
        if (!(await verifyTraccarSession(request))) {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json({
          maptilerApiKey: config.maptilerApiKey,
        });
      },
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
