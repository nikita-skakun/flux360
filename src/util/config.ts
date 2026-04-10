import { z } from "zod";

const ConfigSchema = z.object({
  traccarBaseUrl: z.string().min(1),
  traccarSecure: z.boolean(),
  maptilerApiKey: z.string().min(1),
  traccarApiToken: z.string().min(1),
  historyDays: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const configFile = Bun.file("config.json");
  if (!await configFile.exists()) throw new Error("config.json is missing.");

  const parsed = ConfigSchema.safeParse(await configFile.json());
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
  throw new Error(`Configuration error: ${message}`);
}
