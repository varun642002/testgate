// Work out how to check this project, without being told.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Candidate checks, best first. Each is { name, command, why }.
 * Only commands the project actually declares are returned — guessing a command
 * that does not exist produces a failure that means nothing.
 */
export function detectChecks(dir = process.cwd()) {
  const out = [];
  const has = (f) => existsSync(join(dir, f));
  const readJson = (f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };

  const pkg = has("package.json") ? readJson("package.json") : null;
  if (pkg) {
    const scripts = pkg.scripts || {};
    const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm run";
    const run = (s) => (runner === "npm run" ? `npm run ${s}` : `${runner} ${s}`);

    // Two npm scripts can hold the same command, and a script can hold the
    // very command we were about to run directly: `"lint": "tsc --noEmit"`
    // next to a tsconfig.json is common. Running that compiler twice doubles
    // the wall clock for no extra coverage, and on a big project the second
    // run is what hits the timeout. So dedupe on what each check *resolves
    // to*, not on the string we would type.
    const seen = new Set();
    const push = (name, command, why, resolved) => {
      const key = normaliseCommand(resolved ?? command);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      out.push({ name, command, why });
      return true;
    };
    const pushScript = (s, why) => push(s, run(s), why, scripts[s]);

    // Type checking first: it is fast and catches the most per second.
    for (const s of ["typecheck", "type-check", "tsc", "check-types"]) {
      if (scripts[s] && pushScript(s, "declared in package.json")) break;
    }
    if (!out.length && has("tsconfig.json")) {
      push("tsc", "npx tsc --noEmit", "tsconfig.json present", "tsc --noEmit");
    }

    for (const s of ["test", "tests", "test:unit"]) {
      if (scripts[s] && pushScript(s, "declared in package.json")) break;
    }
    for (const s of ["lint"]) {
      if (scripts[s]) pushScript(s, "declared in package.json");
    }
  }

  if (has("pyproject.toml")) {
    const t = (() => {
      try {
        return readFileSync(join(dir, "pyproject.toml"), "utf8");
      } catch {
        return "";
      }
    })();
    if (/\[tool\.pytest/.test(t) || has("tests") || has("test")) {
      out.push({ name: "pytest", command: "python -m pytest -q", why: "pyproject.toml" });
    }
    if (/\[tool\.ruff/.test(t)) out.push({ name: "ruff", command: "python -m ruff check .", why: "pyproject.toml" });
    if (/\[tool\.mypy/.test(t)) out.push({ name: "mypy", command: "python -m mypy .", why: "pyproject.toml" });
  }

  if (has("Cargo.toml")) out.push({ name: "cargo test", command: "cargo test --quiet", why: "Cargo.toml" });
  if (has("go.mod")) out.push({ name: "go test", command: "go test ./...", why: "go.mod" });
  if (has("Gemfile") && (has("spec") || has("test"))) {
    out.push({ name: "rake", command: "bundle exec rake", why: "Gemfile" });
  }
  if (has("Makefile")) {
    try {
      const mk = readFileSync(join(dir, "Makefile"), "utf8");
      if (/^test:/m.test(mk)) out.push({ name: "make test", command: "make test", why: "Makefile target" });
    } catch {
      /* unreadable */
    }
  }

  return out;
}

/**
 * Compare two commands by what they actually run. `npx tsc --noEmit`,
 * `tsc  --noEmit` and `npm run lint` resolved to `tsc --noEmit` are one check.
 * Deliberately shallow: it strips a leading runner and normalises whitespace,
 * and does not try to understand `&&`, `cross-env` or a shell script.
 */
export function normaliseCommand(command) {
  return String(command || "")
    .trim()
    .replace(/^(?:npx|pnpm\s+exec|yarn\s+exec|bunx)\s+(?:--yes\s+|-y\s+)?/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function loadConfig(dir = process.cwd()) {
  for (const name of [".testgate.json", ".testgate"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      return {
        commands: Array.isArray(j.commands) ? j.commands : j.command ? [j.command] : null,
        timeoutMs: Number(j.timeoutMs) || undefined,
        minEdits: j.minEdits === undefined ? 1 : Number(j.minEdits),
        skip: Array.isArray(j.skip) ? j.skip : [],
      };
    } catch (e) {
      process.stderr.write(`testgate: ignoring ${name} — ${e.message}\n`);
      return null;
    }
  }
  return null;
}

/** Was anything actually edited in this transcript? */
export function editedFiles(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const EDIT = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const files = new Set();
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (!line.trim() || !line.includes("tool_use")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_use" && EDIT.has(b.name)) {
        const p = b.input && (b.input.file_path || b.input.notebook_path);
        if (p) files.add(String(p).replace(/\\/g, "/"));
      }
    }
  }
  return [...files];
}
