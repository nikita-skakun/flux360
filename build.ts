import { rm } from "fs/promises";
import path from "path";
import tailwindPlugin from "bun-plugin-tailwind";

const formatFileSize = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

async function main() {
  const outdir = path.join(process.cwd(), "dist");

  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });

  console.log("\n🚀 Starting build process...\n");
  const start = performance.now();

  const result = await Bun.build({
    entrypoints: ["src/index.html"],
    outdir,
    plugins: [tailwindPlugin],
    minify: true,
    splitting: true,
    sourcemap: "none",
    format: "esm",
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    define: {
      "process.env.NODE_ENV": "\"production\"",
    },
  });

  const end = performance.now();

  if (!result.success) {
    console.error("❌ Build failed:");
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  const outputTable = result.outputs.map(output => ({
    File: path.relative(process.cwd(), output.path),
    Type: output.kind,
    Size: formatFileSize(output.size),
  }));

  console.table(outputTable);
  const buildTime = (end - start).toFixed(2);

  console.log(`\n✅ Build completed in ${buildTime}ms\n`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
