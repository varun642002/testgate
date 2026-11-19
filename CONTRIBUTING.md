# Contributing to testgate

## Two rules

1. **No dependencies.**
2. **Never invent a command.** Only run what the project declares. A command
   that does not exist fails, and that failure tells the user nothing while
   costing them trust in the whole plugin.

## Setup

```bash
git clone https://github.com/varun642002/testgate && cd testgate && node test/smoke.mjs
```

There is no build step. Tests create throwaway projects in a temp directory.

## Things to know

- **Recursion is the hazard.** A check is a process that could end a session and
  re-trigger this hook. The child runs with `TESTGATE_CHILD=1` and the hook
  exits on sight of it; `stop_hook_active` is honoured as well. Keep both.
- **Edits come from the transcript**, by scanning `tool_use` blocks. Reads and
  Bash calls are not edits.
- **Order matters.** Type checking first, stop at the first failure. The point
  is a fast, useful signal, not exhaustive coverage at the end of a session.
- **Summarise failures.** Keep the error lines, drop the passing noise.
- **Cleanup is best-effort.** On Windows `rmSync` throws `EPERM` while a child
  still holds a handle; that must never fail the run or hide results.

## Adding an ecosystem

`lib/detect.mjs`. Detect from a file the project actually has, and add a test
for both the hit and the near-miss — a `Makefile` with no `test:` target must
produce nothing.
