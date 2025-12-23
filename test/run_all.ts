#!/usr/bin/env bun

(async () => {
  const fs = await import("fs/promises");
  const path = await import("path");

  const dir = path.resolve(process.cwd(), "test");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    console.error("Could not read test directory:", e);
    process.exit(2);
  }

  const testFiles = entries.filter((f) => f.endsWith(".test.ts")).sort();
  const VERBOSE = process.env.VERBOSE === "1" || process.argv.includes("--verbose");

  if (testFiles.length === 0) {
    console.error("No tests found in test/ (looking for *.test.ts)");
    process.exit(1);
  }

  let failCount = 0;
  for (const file of testFiles) {
    const full = `./test/${file}`;
    process.stdout.write(`Running ${file}... `);
    const p = Bun.spawn({ cmd: ["bun", full], stdout: "pipe", stderr: "pipe" });
    const outPromise = new Response(p.stdout).text();
    const errPromise = new Response(p.stderr).text();
    const [out, err, code] = await Promise.all([outPromise, errPromise, p.exited]);

    const combined = `${out}\n${err}`.trim();
    const passMatch = combined.split(/\r?\n/).find((line) => /^\[PASS\]/.test(line));

    if (code === 0) {
      // Print the PASS line if available, otherwise print a concise success
      if (passMatch) {
        console.log(passMatch);
      } else {
        console.log(`[PASS] ${file}`);
      }
      if (VERBOSE && combined) {
        console.log(`--- output (${file}) ---`);
        console.log(combined);
        console.log(`--- end ${file} ---\n`);
      }
    } else {
      failCount++;
      console.error(`[FAIL] ${file} (exit ${code})`);
      if (combined) {
        console.error(`--- output (${file}) ---`);
        console.error(combined);
        console.error(`--- end ${file} ---\n`);
      }
    }
  }

  if (failCount === 0) {
    console.log(`\nAll ${testFiles.length} tests passed.`);
    process.exit(0);
  } else {
    console.error(`\n${failCount} test(s) failed.`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(2);
});