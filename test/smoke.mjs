#!/usr/bin/env node
// Dependency-free tests. Run: node test/smoke.mjs
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectChecks, loadConfig, editedFiles, normaliseCommand } from "../lib/detect.mjs";
import { runCheck, formatReport, summariseOutput } from "../lib/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "stop.mjs");

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
};
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m || "mismatch"}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};

const root = mkdtempSync(join(tmpdir(), "testgate-test-"));
const proj = (name, files) => {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    const p = join(d, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
  return d;
};

console.log("detection");

check("finds npm scripts, type check first", () => {
  const d = proj("npm", {
    "package.json": JSON.stringify({ scripts: { test: "node t.js", typecheck: "tsc --noEmit", lint: "eslint ." } }),
  });
  const c = detectChecks(d);
  eq(c[0].name, "typecheck", "type check should come first — fastest signal per second");
  ok(c.some((x) => x.name === "test"), "test");
  ok(c.some((x) => x.name === "lint"), "lint");
  ok(c.every((x) => x.command.startsWith("npm run")), "npm runner");
});

check("uses the lockfile's package manager", () => {
  const d = proj("pnpm", {
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "pnpm-lock.yaml": "",
  });
  eq(detectChecks(d)[0].command, "pnpm test", "pnpm");
  const y = proj("yarn", { "package.json": JSON.stringify({ scripts: { test: "x" } }), "yarn.lock": "" });
  eq(detectChecks(y)[0].command, "yarn test", "yarn");
});

check("falls back to tsc when tsconfig exists but no script does", () => {
  const d = proj("tsonly", { "package.json": JSON.stringify({ scripts: {} }), "tsconfig.json": "{}" });
  eq(detectChecks(d)[0].command, "npx tsc --noEmit", "tsc fallback");
});

check("never invents a command for an empty project", () => {
  eq(detectChecks(proj("empty", { "README.md": "hi" })), [], "should find nothing");
});

check("does not guess at a script it cannot see", () => {
  // Real case: a project whose only tests are test:cash / test:optouts. Running
  // a command that does not exist produces a failure that means nothing.
  const d = proj("named", {
    "package.json": JSON.stringify({ scripts: { "test:cash": "x", "test:optouts": "y" } }),
  });
  eq(detectChecks(d).filter((c) => c.name.startsWith("test")), [], "no guessing");
});

check("detects other ecosystems", () => {
  eq(detectChecks(proj("rust", { "Cargo.toml": "" }))[0].command, "cargo test --quiet", "cargo");
  eq(detectChecks(proj("go", { "go.mod": "module x" }))[0].command, "go test ./...", "go");
  const py = detectChecks(proj("py", { "pyproject.toml": "[tool.pytest.ini_options]\n" }));
  ok(py.some((c) => c.name === "pytest"), "pytest");
  const mk = detectChecks(proj("make", { Makefile: "test:\n\techo hi\n" }));
  ok(mk.some((c) => c.name === "make test"), "makefile target");
});

check("ignores a Makefile with no test target", () => {
  eq(detectChecks(proj("make2", { Makefile: "build:\n\techo hi\n" })), [], "no target");
});

console.log("config");

check("reads commands from .testgate.json", () => {
  const d = proj("cfg", { ".testgate.json": JSON.stringify({ commands: ["echo one"], minEdits: 3 }) });
  const c = loadConfig(d);
  eq(c.commands, ["echo one"], "commands");
  eq(c.minEdits, 3, "minEdits");
});

check("a broken config is ignored, not obeyed", () => {
  const d = proj("badcfg", { ".testgate.json": "{not json" });
  eq(loadConfig(d), null, "should be null");
});

console.log("edited files");

const transcript = join(root, "t.jsonl");
writeFileSync(
  transcript,
  [
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/b.ts" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/c.ts" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
    "not json",
  ].join("\n")
);

check("counts distinct edited files, ignoring reads", () => {
  const f = editedFiles(transcript);
  eq(f.sort(), ["src/a.ts", "src/b.ts"], "edited only");
});

check("a missing transcript is empty, not an error", () => {
  eq(editedFiles(join(root, "nope.jsonl")), [], "missing");
  eq(editedFiles(""), [], "blank");
});

console.log("running checks");

check("a passing command reports ok", () => {
  const r = runCheck({ name: "ok", command: "node -e \"process.exit(0)\"" }, { cwd: root });
  ok(r.ok, `should pass, got ${JSON.stringify(r)}`);
  eq(r.code, 0, "code");
});

check("a failing command captures output and code", () => {
  const r = runCheck(
    { name: "bad", command: "node -e \"console.error('AssertionError: nope'); process.exit(3)\"" },
    { cwd: root }
  );
  ok(!r.ok, "should fail");
  eq(r.code, 3, "exit code");
  ok(r.output.includes("AssertionError"), "output captured");
});

check("a timeout is reported as a timeout", () => {
  const r = runCheck({ name: "slow", command: "node -e \"setTimeout(()=>{},5000)\"" }, { cwd: root, timeoutMs: 300 });
  ok(!r.ok, "should fail");
  ok(r.timedOut, `should be marked timed out, got ${JSON.stringify(r)}`);
});

check("a missing command fails cleanly rather than throwing", () => {
  const r = runCheck({ name: "gone", command: "definitely-not-a-real-binary-xyz" }, { cwd: root });
  ok(!r.ok, "should fail");
  ok(typeof r.output === "string", "output present");
});

console.log("reporting");

check("summariseOutput keeps the failure lines", () => {
  const text = ["ok 1", "ok 2", "FAIL src/a.test.ts", "Expected 1 received 2", "ok 3"].join("\n");
  const s = summariseOutput(text);
  ok(s.includes("FAIL src/a.test.ts"), "kept the failure");
  ok(!s.includes("ok 1"), "dropped the noise");
});

check("a green report says so", () => {
  const r = formatReport([{ name: "test", ok: true }], { edited: 2 });
  ok(r.includes("green"), `expected green, got ${r}`);
});

check("a red report names the check, the code and the command", () => {
  const r = formatReport(
    [{ name: "test", ok: false, code: 1, command: "npm test", output: "FAIL a.ts", ms: 100 }],
    { edited: 3 }
  );
  ok(r.includes("FAILING"), "headline");
  ok(r.includes("npm test"), "command");
  ok(r.includes("exit code 1"), "code");
  ok(r.includes("3 file(s) edited"), "edit count");
});

check("an empty result set reports nothing", () => {
  eq(formatReport([]), "", "no checks, no report");
});

console.log("hook");

const runHook = (payload, env = {}) =>
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    // TESTGATE_CHILD is set in every command testgate runs, so when testgate
    // checks its own repo the marker reaches this suite and the hook under
    // test exits at once, failing the blocking tests for a reason that has
    // nothing to do with the hook. Clear it unless a test sets it itself.
    env: { ...process.env, TESTGATE_CHILD: "", ...env },
  });

const green = proj("green", {
  "package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
});
const red = proj("red", {
  "package.json": JSON.stringify({ scripts: { test: "node -e \"console.error('boom'); process.exit(1)\"" } }),
});

check("a red build blocks with a reason", () => {
  const out = runHook({ cwd: red, transcript_path: transcript, session_id: "s" });
  const j = JSON.parse(out);
  eq(j.decision, "block", "should block");
  ok(j.reason.includes("FAILING"), "reason explains");
});

check("a green build does not block", () => {
  const out = runHook({ cwd: green, transcript_path: transcript, session_id: "s" }, { TESTGATE_QUIET: "1" });
  eq(out.trim(), "", "should emit no decision");
});

check("no edits means no run", () => {
  const empty = join(root, "empty.jsonl");
  writeFileSync(empty, JSON.stringify({ message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }));
  eq(runHook({ cwd: red, transcript_path: empty, session_id: "s" }).trim(), "", "should stay quiet");
});

check("stop_hook_active is honoured", () => {
  eq(runHook({ cwd: red, transcript_path: transcript, stop_hook_active: true }).trim(), "", "must not loop");
});

check("the child marker prevents recursion", () => {
  eq(
    runHook({ cwd: red, transcript_path: transcript }, { TESTGATE_CHILD: "1" }).trim(),
    "",
    "a check must not re-trigger the hook"
  );
});

check("TESTGATE=0 disables it", () => {
  eq(runHook({ cwd: red, transcript_path: transcript }, { TESTGATE: "0" }).trim(), "", "kill switch");
});

check("garbage input exits quietly", () => {
  const out = execFileSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", env: process.env });
  eq(out.trim(), "", "should not crash or block");
});

check("a project with no checks stays quiet", () => {
  const none = proj("nochecks", { "README.md": "hi" });
  eq(runHook({ cwd: none, transcript_path: transcript }).trim(), "", "nothing to run");
});

// --- added with the dedupe and timeout changes ---

check("a lint script holding the same command as the tsc fallback runs once", () => {
  // The tsc fallback is added before lint is considered, so it is the one
  // that survives. Which of the two names wins does not matter; running the
  // same compiler twice does.
  const d = proj("dup-lint", {
    "package.json": JSON.stringify({ scripts: { lint: "tsc --noEmit" } }),
    "tsconfig.json": "{}",
  });
  const names = detectChecks(d).map((c) => c.name);
  eq(names, ["tsc"], "tsc --noEmit must not be run twice under two names");
});

check("a lint script doing something else is still its own check", () => {
  const d = proj("real-lint", {
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
    "tsconfig.json": "{}",
  });
  eq(detectChecks(d).map((c) => c.name), ["tsc", "lint"], "a genuine second check survives");
});

check("normaliseCommand sees through npx and spacing", () => {
  eq(normaliseCommand("npx  tsc   --noEmit"), normaliseCommand("tsc --noemit"), "same command");
  ok(normaliseCommand("eslint .") !== normaliseCommand("tsc --noEmit"), "different commands");
});

check("a timeout is not reported as a failing build", () => {
  const r = runCheck({ name: "slow", command: "node -e \"setTimeout(()=>{},5000)\"" }, { cwd: root, timeoutMs: 300 });
  ok(r.timedOut, "precondition: it timed out");
  const report = formatReport([r], { edited: 1 });
  ok(!report.includes("FAILING"), "must not call an unfinished check a failure");
  ok(report.includes("not a failure"), "must say so plainly");
  ok(/unknown/.test(report), "must say the result is unknown");
});

check("a timing-out check does not block the session", () => {
  const slow = proj("slow", {
    "package.json": JSON.stringify({ scripts: { test: "node -e \"setTimeout(()=>{},5000)\"" } }),
    ".testgate.json": JSON.stringify({ timeoutMs: 300 }),
  });
  const out = runHook({ cwd: slow, transcript_path: transcript, session_id: "s" });
  eq(out.trim(), "", "a timeout must not emit a block decision");
});
// Best-effort cleanup. On Windows a child process from the timeout test can
// still hold a handle, and rmSync throws EPERM — which must not fail the run
// or hide the results.
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch {
  /* the OS will clear the temp directory later */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
