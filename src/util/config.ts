import { z } from "zod";

const ConfigSchema = z.object({
  traccarBaseUrl: z.string().min(1),
  traccarSecure: z.boolean(),
  maptilerApiKey: z.string().min(1),
  traccarApiToken: z.string().min(1),
  historyDays: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const envConfig = {
    traccarBaseUrl: process.env["TRACCAR_BASE_URL"],
    traccarSecure: process.env["TRACCAR_SECURE"] === "true" || process.env["TRACCAR_SECURE"] === "1",
    maptilerApiKey: process.env["MAPTILER_API_KEY"],
    traccarApiToken: process.env["TRACCAR_API_TOKEN"],
    historyDays: process.env["HISTORY_DAYS"] ? parseInt(process.env["HISTORY_DAYS"], 10) : undefined,
  };

  const parsed = ConfigSchema.safeParse(envConfig);
  if (parsed.success) return parsed.data;

  const message = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
  throw new Error(`Configuration error. Missing or invalid environment variables: ${message}`);
}
