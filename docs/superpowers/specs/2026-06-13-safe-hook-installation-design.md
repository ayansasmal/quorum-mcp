# Safe Hook Inspection and Repair

**Date:** 2026-06-13  
**Status:** Approved for implementation  
**Scope:** `quorum install` and npm postinstall hook setup

## Goal

Before installing Claude Code hooks, Quorum must inspect the existing hook scripts
and `~/.claude/settings.json`. A correct installation is a true no-op. Missing,
stale, or incorrectly wired Quorum-owned entries are repaired automatically
without rebuilding or broadly rewriting unrelated user settings.

## Ownership Boundary

Quorum owns these hook IDs and their bundled scripts:

| Hook ID | Event | Matcher | Script |
|---------|-------|---------|--------|
| `quorum-session-start` | `UserPromptSubmit` | none | `quorum-session-start.sh` |
| `quorum-stop` | `Stop` | none | `quorum-stop.sh` |
| `quorum-pre-commit` | `PreToolUse` | `Bash` | `quorum-pre-commit.sh` |
| `quorum-task-complete` | `PostToolUse` | `TodoWrite` | `quorum-task-complete.sh` |
| `quorum-knowledge-source` | `PostToolUse` | `Write` | `quorum-knowledge-source.sh` |
| `quorum-knowledge-source-edit` | `PostToolUse` | `Edit` | `quorum-knowledge-source.sh` |

The installer may add or replace entries with these exact IDs. It must preserve:

- every non-Quorum hook;
- unknown or legacy Quorum IDs not listed above;
- all settings outside `hooks`;
- event keys Quorum does not manage;
- the relative ordering of preserved entries within each event.

## Inspection

`inspectHooks()` returns a structured report without writing:

- script status: `correct`, `missing`, `stale`, or `not_executable`;
- settings status per managed hook ID: `correct`, `missing`, or `incorrect`;
- overall `needsRepair`;
- lists of scripts and entries requiring repair.

A script is correct only when its bytes match the bundled source and its
executable bits are present. A settings entry is correct only when its event,
matcher, hook type, and command exactly match the expected installed script.

## Settings Safety

The installer parses the existing file before any write. It refuses to modify
the file when:

- JSON parsing fails;
- the root value is not a plain object;
- `hooks` exists but is not a plain object;
- a managed event exists but is not an array.

Refusal leaves scripts and settings unchanged and reports the exact unsafe
structure. This avoids “repairing” a format Quorum does not understand.

When settings repair is required:

1. Read and validate the current file.
2. Build a new object by replacing only managed hook IDs and inserting missing
   managed entries into their expected events.
3. Write the new JSON to a temporary file in the same directory.
4. If the original exists, copy it to `settings.json.bak`.
5. Atomically rename the temporary file over `settings.json`.

No backup or settings write occurs when all managed entries are already correct.

## Script Repair

Only affected scripts are copied:

- missing or stale scripts are copied from the package;
- missing executable bits are restored with mode `0755`;
- correct scripts are untouched.

Bundled source scripts are validated before any destination mutation. A missing
source script is a packaging error and aborts the operation.

## CLI and Postinstall Behavior

Both `quorum install` and npm postinstall use the same inspection and repair
implementation.

Output distinguishes:

- `Hooks already installed and correctly wired`;
- repaired scripts, naming each script;
- repaired settings entries, naming each hook ID;
- backup path when `settings.json` changed.

No separate `--repair-hooks` flag is required. Incorrect or missing managed
entries are repaired automatically.

## Testing

Unit tests cover:

1. correct installation performs no writes;
2. missing script repair;
3. stale script-content repair;
4. executable-mode repair;
5. missing managed entry repair;
6. incorrect command-path repair;
7. incorrect matcher or hook type repair;
8. unrelated settings and hooks remain semantically unchanged;
9. unknown legacy Quorum IDs remain present;
10. malformed JSON and unsafe structures abort without mutation;
11. settings repair creates `settings.json.bak`;
12. settings replacement uses a same-directory temporary file and atomic rename;
13. returned report and CLI output describe the performed work.

## Non-Goals

- Reformatting or preserving whitespace/comments in JSON; `settings.json` is
  parsed JSON and contains no comments.
- Removing legacy Quorum hook IDs.
- Managing hooks belonging to other tools.
- Changing Claude Code's hook schema.
