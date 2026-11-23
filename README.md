<div align="center">

# 🚦 testgate

### Never close a session on a red build

*You edited eleven files and stopped. Were the tests still passing? testgate checks, while you can still act on it.*

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://claude.com/claude-code)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-32-success.svg)](test/smoke.mjs)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## 😖 The problem

The session ends. Everything looked fine. Tomorrow you open the project and the
type check has been broken since yesterday afternoon, and now you have to work
out which of eleven changes did it.

## ✨ What it does

A `Stop` hook. When a session that **edited files** ends, it runs your project's
own checks and reports:

```text
testgate: this session is closing on a FAILING build (7 file(s) edited).

  typecheck — exit code 2   (npm run typecheck)
      src/auth/verifyRequest.ts(45,43): error TS2339: Property 'projectId'
      does not exist on type '{}'.

  passed: lint

Either fix it now or say plainly that the build is red and what is broken,
so it is not discovered next session.
```

That report goes back to Claude **in the same session**, so it can fix the
break instead of leaving it for you. A green build prints one quiet line.

## 🚀 Install

```bash
claude plugin marketplace add varun642002/testgate
```

```bash
claude plugin install testgate@testgate
```

See what it would run in your project, before trusting it:

```bash
npx github:varun642002/testgate detect
```

```text
  typecheck      npm run typecheck              declared in package.json
  test           npm run test                   declared in package.json
  lint           npm run lint                   declared in package.json
```

## 🔍 What it runs

It uses **what your project already declares** — it never invents a command.

| Ecosystem | Detected from |
|---|---|
| 📦 Node | `package.json` scripts: `typecheck`/`type-check`/`tsc`, then `test`, then `lint` |
| 🔷 TypeScript | `npx tsc --noEmit` when `tsconfig.json` exists and no script does |
| 🐍 Python | `pyproject.toml` → `pytest`, `ruff`, `mypy` |
| 🦀 Rust | `Cargo.toml` → `cargo test` |
| 🐹 Go | `go.mod` → `go test ./...` |
| 💎 Ruby | `Gemfile` + `spec/` → `bundle exec rake` |
| 🔨 Make | a `test:` target → `make test` |

The package manager follows your lockfile (`pnpm-lock.yaml` → `pnpm test`).
**Type checking runs first** — it is the most signal per second — and it stops
at the first failure rather than spending minutes on the rest.

> [!NOTE]
> **It will not guess.** A project whose only tests are `test:cash` and
> `test:optouts` gets no test command, because running one that does not exist
> produces a failure that means nothing. List them in `.testgate.json`.

## 🔧 Configuration

`.testgate.json` in your project root:

```json
{
  "commands": ["npm run typecheck", "npm run test:cash", "npm run test:optouts"],
  "timeoutMs": 600000,
  "minEdits": 1,
  "skip": ["^docs/", "\\.md$"]
}
```

| Key | Meaning |
|---|---|
| `commands` | Run these instead of detecting. Strings, or `{name, command}` |
| `timeoutMs` | Per-check timeout (default 600000) |
| `minEdits` | Edited files needed before anything runs (default 1) |
| `skip` | Paths that don't count as edits — docs, changelogs |

| Variable | Effect |
|---|---|
| `TESTGATE=0` | Disable entirely |
| `TESTGATE_QUIET=1` | Say nothing when the build is green |
| `TESTGATE_TIMEOUT_MS` | Per-check timeout, overriding the default |

## ⏱️ A timeout is not a red build

A check that runs out of time proved nothing, so testgate says so and lets the
session close. It only blocks on a real non-zero exit. Reporting a timeout as a
failure sends you looking for a break that may not exist — which is worse than
saying nothing, and was the reason the default went from 180s to 600s.

Checks are also deduplicated by **what they resolve to**, not by the command
you would type. A `"lint": "tsc --noEmit"` script next to a `tsconfig.json`
used to run the same compiler twice under two names, doubling the wait for no
extra coverage. Now it runs once.
## ⚠️ Worth knowing

> [!IMPORTANT]
> **It can make ending a session slower.** Your checks run at `Stop`, so a
> three-minute test suite is three minutes. Narrow `commands` to the fast ones
> if that bites — a type check alone catches most of it.

> [!NOTE]
> **It will not recurse.** A check is itself a process that could end a session,
> so the child runs with `TESTGATE_CHILD=1` and the hook exits immediately when
> it sees it. `stop_hook_active` is honoured too.

**Nothing runs if nothing changed.** A session that only read files, answered a
question or ran commands ends exactly as before.

## 🧭 Notes for anyone forking this

- **Edited files come from the transcript**, by scanning `tool_use` blocks for
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Reads and Bash calls do not count.
- **Failures are summarised, not dumped.** The report keeps lines matching
  error/fail/assertion patterns, falling back to the tail. A wall of passing
  test names teaches Claude nothing.
- **Windows cleanup can fail.** `rmSync` on a temp directory throws `EPERM`
  while a child process still holds a handle — which surfaced from the timeout
  test. Cleanup is best-effort so it cannot hide the results.
- **A missing binary must not throw.** `runCheck` reports it as a failed check.

## 🤝 Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). No dependencies, please.

- [ ] Run only the checks that cover the files actually touched
- [ ] Cache a green result so an unchanged tree is not re-run
- [ ] More ecosystems: Gradle, Maven, dotnet, Elixir
- [ ] A `PreCompact` variant, for sessions that never formally stop

## 📄 License

[MIT](LICENSE)
