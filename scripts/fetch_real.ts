import fs from "fs/promises";
import path from "path";
import traccarClient from "../src/api/traccarClient";

async function main() {
  const baseUrl = process.env.TRACCAR_BASE_URL || "http://localhost:8082/api";
  const username = process.env.TRACCAR_USER;
  const password = process.env.TRACCAR_PASS;
  const token = process.env.TRACCAR_TOKEN;
  const deviceId = process.env.TRACCAR_DEVICE_ID || "1";
  const from = process.env.TRACCAR_FROM || new Date(Date.now() - 60 * 60 * 1000 * 6).toISOString(); // default 1 hour ago
  const to = process.env.TRACCAR_TO || new Date().toISOString();

  const opts: any = { baseUrl };
  if (token) opts.auth = { type: "token", token };
  else if (username && password) opts.auth = { type: "basic", username, password };

  console.log(`Using baseUrl=${baseUrl}`);
  console.log(`DeviceId=${deviceId}, from=${from}, to=${to}`);

  const positions = await traccarClient.fetchPositions(opts, deviceId as any, new Date(from), new Date(to));

  console.log(`Fetched ${positions.length} positions`);
  const outDir = path.join(process.cwd(), "dev-data");
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (e) {
    // ignore
  }
  const outFile = path.join(outDir, "positions.json");
  await fs.writeFile(outFile, JSON.stringify(positions, null, 2), "utf8");
  console.log(`Wrote positions to ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
