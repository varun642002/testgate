#!/usr/bin/env node
// testgate CLI — see what it would run, or run it now.
import { detectChecks, loadConfig } from "../lib/detect.mjs";
import { runCheck, formatReport } from "../lib/run.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`testgate — never close a session on a red build

usage:
  testgate detect     show the checks it would run, and why
  testgate run        run them now and report

Exit codes: 0 all passed, 1 something failed, 2 nothing to run.`);
  process.exit(0);
}

const cwd = process.cwd();
const config = loadConfig(cwd) || {};
const checks = config.commands
  ? config.commands.map((c, i) => ({
      name: typeof c === "string" ? `check ${i + 1}` : c.name,
      command: typeof c === "string" ? c : c.command,
      why: ".testgate.json",
    }))
  : detectChecks(cwd);

if (!checks.length) {
  console.log("testgate: no checks found. Add scripts to package.json, or list commands in .testgate.json.");
  process.exit(2);
}

if (cmd === "detect") {
  console.log();
  for (const c of checks) console.log(`  ${c.name.padEnd(14)} ${c.command.padEnd(30)} ${c.why || ""}`);
  console.log();
  process.exit(0);
}

const results = [];
for (const c of checks) {
  process.stderr.write(`  running ${c.name}…\n`);
  const r = runCheck(c, { cwd, timeoutMs: config.timeoutMs });
  results.push(r);
  if (!r.ok) break;
}
console.log("\n" + formatReport(results, { edited: 0 }) + "\n");
process.exit(results.some((r) => !r.ok) ? 1 : 0);
