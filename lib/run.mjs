// Run a check and summarise the outcome.
import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

// A type check on a large project can take several minutes on a cold cache.
// 180s used to be the default and timed out often enough to be noise; the
// report that follows a timeout then read as a broken build, which it is not.
export const DEFAULT_TIMEOUT_MS = Number(process.env.TESTGATE_TIMEOUT_MS) || 600_000;

/** Keep the lines a human would actually look at. */
export function summariseOutput(text, max = 25) {
  const lines = String(text || "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const interesting = lines.filter((l) =>
    /\b(error|failed|failing|fail|✕|✗|×|FAIL|AssertionError|Expected|Received|panic:|Traceback)\b/i.test(l)
  );
  const picked = (interesting.length ? interesting : lines.filter(Boolean).slice(-max)).slice(0, max);
  return picked.join("\n");
}

/**
 * Run one check. Returns { name, command, ok, code, output, timedOut, ms }.
 * Never throws: a check that cannot run is reported, not escalated.
 */
export function runCheck({ name, command }, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1 << 24,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Keep a plugin's own hooks out of the child, and keep colour codes out
      // of the captured text.
      env: { ...process.env, TESTGATE_CHILD: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      shell: isWin ? undefined : "/bin/sh",
    });
    return { name, command, ok: true, code: 0, output: String(output), timedOut: false, ms: Date.now() - started };
  } catch (e) {
    const timedOut = e.killed === true || e.signal === "SIGTERM" || /ETIMEDOUT/.test(String(e.code));
    const output = `${e.stdout || ""}\n${e.stderr || ""}`.trim() || String(e.message || "");
    return {
      name,
      command,
      ok: false,
      code: typeof e.status === "number" ? e.status : 1,
      output,
      timedOut,
      ms: Date.now() - started,
    };
  }
}

export function formatReport(results, { edited = 0 } = {}) {
  if (!results.length) return "";

  // A timeout is not a red build. It means the check did not finish, so we do
  // not know either way. Saying "FAILING" there sends someone hunting for a
  // break that is not there, which is worse than saying nothing.
  const timedOut = results.filter((r) => !r.ok && r.timedOut);
  const failed = results.filter((r) => !r.ok && !r.timedOut);
  const passed = results.filter((r) => r.ok).map((r) => r.name);

  if (!failed.length && !timedOut.length) {
    return `testgate: ${passed.join(", ")} passed after ${edited} edited file(s). Closing on a green build.`;
  }

  const lines = [];
  if (failed.length) {
    lines.push(`testgate: this session is closing on a FAILING build (${edited} file(s) edited).`, "");
    for (const r of failed) {
      lines.push(`  ${r.name} — exit code ${r.code}   (${r.command})`);
      const body = summariseOutput(r.output, 12);
      if (body) lines.push(body.split("\n").map((l) => `      ${l}`).join("\n"));
      lines.push("");
    }
  } else {
    lines.push(
      `testgate: could not finish checking (${edited} file(s) edited). This is not a failure.`,
      ""
    );
  }

  for (const r of timedOut) {
    // Math.round would print "0s" for a sub-second limit.
    const secs = Math.max(1, Math.round(r.ms / 1000));
    lines.push(`  ${r.name} — did not finish within ${secs}s, so its result is unknown   (${r.command})`);
    lines.push(`      Raise timeoutMs in .testgate.json, or set TESTGATE_TIMEOUT_MS, to give it longer.`);
    lines.push("");
  }

  if (passed.length) lines.push(`  passed: ${passed.join(", ")}`, "");

  if (failed.length) {
    lines.push(
      "Either fix it now or say plainly that the build is red and what is broken,",
      "so it is not discovered next session."
    );
  } else {
    lines.push("Nothing is known to be broken. Run the check above by hand if it matters.");
  }
  return lines.join("\n");
}
