// Run a check and summarise the outcome.
import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

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
export function runCheck({ name, command }, { cwd = process.cwd(), timeoutMs = 180_000 } = {}) {
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
  const failed = results.filter((r) => !r.ok);
  if (!results.length) return "";

  if (!failed.length) {
    const names = results.map((r) => r.name).join(", ");
    return `testgate: ${names} passed after ${edited} edited file(s). Closing on a green build.`;
  }

  const lines = [
    `testgate: this session is closing on a FAILING build (${edited} file(s) edited).`,
    "",
  ];
  for (const r of failed) {
    const how = r.timedOut ? `timed out after ${Math.round(r.ms / 1000)}s` : `exit code ${r.code}`;
    lines.push(`  ${r.name} — ${how}   (${r.command})`);
    const body = summariseOutput(r.output, 12);
    if (body) lines.push(body.split("\n").map((l) => `      ${l}`).join("\n"));
    lines.push("");
  }
  const passed = results.filter((r) => r.ok).map((r) => r.name);
  if (passed.length) lines.push(`  passed: ${passed.join(", ")}`);
  lines.push(
    "",
    "Either fix it now or say plainly that the build is red and what is broken,",
    "so it is not discovered next session."
  );
  return lines.join("\n");
}
