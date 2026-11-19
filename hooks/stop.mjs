#!/usr/bin/env node
// Stop hook: if this session edited files, run the project's checks and say
// whether it is closing on a red build.
//
// Guards, in order: the kill switch, the child marker (a check must never
// trigger this hook again), stop_hook_active, and "did anything change at all".
import { detectChecks, loadConfig, editedFiles } from "../lib/detect.mjs";
import { runCheck, formatReport } from "../lib/run.mjs";

if (process.env.TESTGATE === "0") process.exit(0);
if (process.env.TESTGATE_CHILD === "1") process.exit(0);

let input = {};
try {
  input = JSON.parse((await readStdin()) || "{}") || {};
} catch {
  process.exit(0);
}
if (input.stop_hook_active) process.exit(0);

const cwd = input.cwd || process.cwd();
const config = loadConfig(cwd) || {};
const minEdits = config.minEdits === undefined ? 1 : config.minEdits;

const edited = editedFiles(input.transcript_path).filter(
  (f) => !(config.skip || []).some((re) => new RegExp(re, "i").test(f))
);
if (edited.length < minEdits) process.exit(0);

const checks = config.commands
  ? config.commands.map((c, i) => ({ name: typeof c === "string" ? `check ${i + 1}` : c.name, command: typeof c === "string" ? c : c.command }))
  : detectChecks(cwd);

if (!checks.length) {
  // Nothing declared, nothing to run. Staying quiet beats inventing a command.
  process.exit(0);
}

const results = [];
for (const c of checks) {
  const r = runCheck(c, { cwd, timeoutMs: config.timeoutMs || 180_000 });
  results.push(r);
  // One failure is enough to report; no point spending minutes on the rest.
  if (!r.ok) break;
}

const report = formatReport(results, { edited: edited.length });
const failing = results.some((r) => !r.ok);

if (failing) {
  // "block" sends the reason back to Claude so it can act on it in this session.
  process.stdout.write(JSON.stringify({ decision: "block", reason: report }));
} else if (process.env.TESTGATE_QUIET !== "1") {
  process.stderr.write(report + "\n");
}
process.exit(0);

function readStdin() {
  return new Promise((res) => {
    let d = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 10_000).unref?.();
  });
}
