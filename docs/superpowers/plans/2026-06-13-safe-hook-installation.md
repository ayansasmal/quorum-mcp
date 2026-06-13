# Safe Hook Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Quorum inspect hook scripts and Claude settings before installation, no-op when correct, and automatically repair only missing or incorrect Quorum-owned pieces.

**Architecture:** `src/install/hooks.js` owns inspection, structural validation, selective script repair, managed-ID settings repair, backup, and atomic replacement. `cli.js` and `src/install/postinstall.js` consume the same structured report and only format user-facing output.

**Tech Stack:** Node.js ESM, `node:fs`, Vitest, Commander

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/install/hooks.js` | Inspect and selectively repair scripts and settings |
| `tests/install/hooks.test.js` | Prove no-op, repair, preservation, refusal, backup, and atomic-write behavior |
| `cli.js` | Format interactive `quorum install` hook results |
| `src/install/postinstall.js` | Format npm postinstall hook results |
| `README.md` | Document safe automatic repair |
| `AGENTS.md` / `CLAUDE.md` | Record hook ownership and settings safety constraints |

### Task 1: Core Inspection and Selective Repair

**Files:**
- Modify: `src/install/hooks.js`
- Modify: `tests/install/hooks.test.js`

- [ ] **Step 1: Add failing inspection tests**

Add tests that import `inspectHooks` and assert:

```javascript
const report = inspectHooks({ hooksDir, settingsPath, scriptsSrc })
expect(report.needsRepair).toBe(false)
expect(report.scripts.every(({ status }) => status === 'correct')).toBe(true)
expect(report.settings.every(({ status }) => status === 'correct')).toBe(true)
```

Also create missing, stale-content, and mode-only cases and assert statuses
`missing`, `stale`, and `not_executable`.

- [ ] **Step 2: Verify the inspection tests fail**

Run:

```bash
npx vitest run tests/install/hooks.test.js
```

Expected: FAIL because `inspectHooks` is not exported.

- [ ] **Step 3: Implement script and settings inspection**

Export:

```javascript
export function inspectHooks({ hooksDir, settingsPath, scriptsSrc }) {
  validateBundledScripts(scriptsSrc)
  const settings = readAndValidateSettings(settingsPath)
  const scripts = inspectScripts(hooksDir, scriptsSrc)
  const settingsEntries = inspectSettingsEntries(settings.hooks ?? {}, hooksDir)
  return {
    needsRepair: scripts.some(({ status }) => status !== 'correct')
      || settingsEntries.some(({ status }) => status !== 'correct'),
    scripts,
    settings: settingsEntries,
  }
}
```

Use `readFileSync(src).equals(readFileSync(dest))` for byte equality and
`statSync(dest).mode & 0o111` for executable bits. Validate that settings root
and `hooks` are plain objects and every managed event value is an array.

- [ ] **Step 4: Add failing selective-repair tests**

Cover:

```javascript
const report = installHooks({ hooksDir, settingsPath, scriptsSrc })
expect(report.changed).toBe(false)
expect(writeSpy).not.toHaveBeenCalled()
```

Then assert missing/incorrect managed IDs are repaired while unrelated handlers
and unknown legacy Quorum IDs remain. Assert stale scripts are replaced and
mode-only scripts are chmodded without content replacement.

- [ ] **Step 5: Verify selective-repair tests fail**

Run:

```bash
npx vitest run tests/install/hooks.test.js
```

Expected: FAIL because `installHooks` currently recopies every script and
rewrites settings on every call.

- [ ] **Step 6: Implement selective repair and atomic settings replacement**

Change `installHooks()` to:

```javascript
export function installHooks(opts) {
  const before = inspectHooks(opts)
  const repairedScripts = repairScripts(before.scripts, opts)
  const repairedEntries = before.settings
    .filter(({ status }) => status !== 'correct')
    .map(({ id }) => id)

  let backupPath = null
  if (repairedEntries.length > 0) {
    backupPath = writeSettingsAtomically(opts.settingsPath, buildRepairedSettings(opts))
  }

  return {
    changed: repairedScripts.length > 0 || repairedEntries.length > 0,
    repairedScripts,
    repairedEntries,
    backupPath,
  }
}
```

`writeSettingsAtomically()` must write a temporary sibling path, copy an
existing settings file to `${settingsPath}.bak`, and use `renameSync()` for the
final replacement. Cleanup the temporary path if rename fails.

- [ ] **Step 7: Add refusal and failure-safety tests**

Test malformed JSON, non-object root, non-object `hooks`, and non-array managed
events. Snapshot destination scripts and settings before calling `installHooks`
and assert no mutation after each thrown error.

- [ ] **Step 8: Run the focused suite**

Run:

```bash
npx vitest run tests/install/hooks.test.js
```

Expected: all hook installer tests pass.

- [ ] **Step 9: Update agent guidance and commit**

Update `AGENTS.md` and `CLAUDE.md` with the managed-ID ownership boundary,
structural refusal rules, and atomic backup behavior.

```bash
git add src/install/hooks.js tests/install/hooks.test.js AGENTS.md CLAUDE.md
git commit -m "fix(cli): inspect and safely repair quorum hooks"
```

### Task 2: Installer Reporting

**Files:**
- Modify: `cli.js`
- Modify: `src/install/postinstall.js`
- Create: `tests/install/hook-report.test.js`

- [ ] **Step 1: Add failing report-format tests**

Extract and test:

```javascript
expect(formatHookInstallReport({
  changed: false,
  repairedScripts: [],
  repairedEntries: [],
  backupPath: null,
})).toEqual(['✓ Hooks already installed and correctly wired'])
```

For repairs, assert output names repaired scripts, repaired IDs, and backup path.

- [ ] **Step 2: Verify report tests fail**

Run:

```bash
npx vitest run tests/install/hook-report.test.js
```

Expected: FAIL because `formatHookInstallReport` does not exist.

- [ ] **Step 3: Add shared formatter**

Export `formatHookInstallReport(report)` from `src/install/hooks.js`. Return an
array of output lines so both callers render identical results:

```javascript
if (!report.changed) return ['✓ Hooks already installed and correctly wired']
```

Append lines only for non-empty repaired script/entry lists and non-null backup.

- [ ] **Step 4: Wire both installer callers**

Replace unconditional “Hooks installed” messages with:

```javascript
const report = installHooks({ hooksDir, settingsPath, scriptsSrc })
for (const line of formatHookInstallReport(report)) console.log(line)
```

- [ ] **Step 5: Run focused tests and build**

```bash
npx vitest run tests/install/hooks.test.js tests/install/hook-report.test.js
npm run build:all
```

Expected: tests pass and both bundles build.

- [ ] **Step 6: Update agent guidance and commit**

Record the shared formatter contract in `AGENTS.md` and `CLAUDE.md`.

```bash
git add src/install/hooks.js cli.js src/install/postinstall.js tests/install/hook-report.test.js AGENTS.md CLAUDE.md
git commit -m "feat(cli): report hook inspection and repair results"
```

### Task 3: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document safe installer behavior**

Update README installation guidance to state:

- existing hooks are inspected first;
- correct installations produce no settings write;
- missing/incorrect managed entries repair automatically;
- unrelated settings are preserved;
- changed settings create `settings.json.bak`;
- malformed or unsafe settings abort without mutation.

- [ ] **Step 2: Exercise install against an isolated home**

Run the built CLI with a temporary `HOME`, invoke it twice with
`--skip-mcp --skip-skill`, and compare file mtimes:

```bash
HOME="$(mktemp -d)" node dist/cli.js install --skip-mcp --skip-skill
HOME="$HOME" node dist/cli.js install --skip-mcp --skip-skill
```

Expected: first run reports repairs; second reports already correct and leaves
`settings.json` unchanged.

- [ ] **Step 3: Verify the real installation**

Run:

```bash
node dist/cli.js install --skip-mcp --skip-skill
claude mcp list | grep '^quorum:'
```

Expected: hook inspection succeeds and Quorum reports connected.

- [ ] **Step 4: Run full verification**

```bash
npm test
npm run build:all
git diff --check
```

Expected: all tests pass, bundles build, and no whitespace errors appear.

- [ ] **Step 5: Open changed Markdown**

Open README, AGENTS, and CLAUDE through show-md.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md
git commit -m "docs(cli): document safe automatic hook repair"
```

## Self-Review

- Spec coverage: inspection, exact ownership, no-op, selective repair,
  structural refusal, backup, atomic rename, reporting, and shared callers are
  each assigned to a task.
- Type consistency: `inspectHooks()` and `installHooks()` reports use the same
  `scripts`, `settings`, `repairedScripts`, `repairedEntries`, and `backupPath`
  names throughout.
- Scope: no hook removal, no settings format migration, and no unrelated CLI
  refactor.
