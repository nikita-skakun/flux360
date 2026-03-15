import { z } from "zod";

const ConfigSchema = z.object({
  traccarBaseUrl: z.url(),
  traccarSecure: z.boolean(),
  maptilerApiKey: z.string().min(1),
  traccarApiToken: z.string().min(1),
  historyDays: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const configFile = Bun.file("config.json");
  if (!(await configFile.exists())) {
    throw new Error("config.json is missing. Please create it based on config.sample.json.");
  }

  try {
    return ConfigSchema.parse(await configFile.json());
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ")
      : "config.json is not valid JSON.";
    throw new Error(`Configuration error: ${message}`);
  }
}
