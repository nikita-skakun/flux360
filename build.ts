#!/usr/bin/env bun
import { existsSync } from "fs";
import { parseArgs } from "util";
import { rm } from "fs/promises";
import path from "path";
import plugin from "bun-plugin-tailwind";

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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      outdir: { type: "string" },
      minify: { type: "boolean" },
      sourcemap: { type: "string" },
      target: { type: "string" },
      external: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
🏗️  Bun Build Script

Usage: bun run build.ts [options]

Options:
  --outdir <path>     Output directory (default: "dist")
  --minify            Enable minification (default: true)
  --sourcemap <type>  Sourcemap type: none|linked|inline|external (default: linked)
  --target <target>   Build target: browser|bun|node (default: browser)
  --external <list>   External packages (comma separated)
  --help, -h          Show this help message
    `);
    return;
  }

  const outdir = (values.outdir as string) || path.join(process.cwd(), "dist");

  if (existsSync(outdir)) {
    console.log(`🗑️ Cleaning previous build at ${outdir}`);
    await rm(outdir, { recursive: true, force: true });
  }

  console.log("\n🚀 Starting build process...\n");

  const start = performance.now();

  const entrypoints = [...new Bun.Glob("**.html").scanSync("src")]
    .map(a => path.resolve("src", a))
    .filter(dir => !dir.includes("node_modules"));

  console.log(`📄 Found ${entrypoints.length} HTML ${entrypoints.length === 1 ? "file" : "files"} to process\n`);

  // Type-safe mapping of CLI options to Bun.BuildConfig
  const target = (typeof values.target === "string" && ["browser", "bun", "node"].includes(values.target))
    ? (values.target as "browser" | "bun" | "node")
    : "browser";

  const sourcemap = (typeof values.sourcemap === "string" && ["none", "linked", "inline", "external"].includes(values.sourcemap))
    ? (values.sourcemap as "none" | "linked" | "inline" | "external")
    : "linked";

  const external = typeof values.external === "string"
    ? values.external.split(",").map(s => s.trim())
    : undefined;

  const result = await Bun.build({
    entrypoints,
    outdir,
    plugins: [plugin],
    minify: typeof values.minify === "boolean" ? values.minify : true,
    target,
    sourcemap,
    ...(external ? { external } : {}),
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
