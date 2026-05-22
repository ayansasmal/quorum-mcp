# quorum:scan — Conformance Scan Skill

Orchestrates an incremental conformance scan: runs code and security review on changed files, translates findings into deviation records, and surfaces unmatched patterns as project-level DRAFTs.

---

## When to Use

- Before a PR merge to establish a conformance baseline
- On a nightly schedule (via `quorum:schedule`)
- After linking new global catalogs (via `quorum:onboard`)
- When `pending()` surfaces a stale `last_scan_at` warning (> 14 days)

---

## Skill Steps

### 1. Check current state

```
conformance()
```

Record the current score before scanning. If `status: 'UNCERTIFIED'`, confirm with the user before proceeding — the project may need to link global catalogs first (`quorum:onboard`).

### 2. Identify changed files (incremental)

```bash
git diff HEAD~1 --name-only
```

For a full baseline scan, use `git ls-files` to get all tracked files. For nightly incremental, use `git diff HEAD~1 --name-only` to limit scope.

### 3. Run code review on changed files

Invoke `code-review` skill on the changed file list. Collect all findings (anti-patterns, violations, risks).

### 4. Run security review on changed files

Invoke `security-review` skill on the same file list. Collect security-specific findings.

### 5. For each distinct finding pattern

**Group by pattern, not by instance.** One `deviate()` or `remember()` call per distinct pattern across the codebase. Use the `evidence` field for file-specific locations.

For each finding:
```
search(topic, key_concept)
```

- **If match found** in a linked global catalog:
  ```
  deviate(catalog_id, topic, key, description, evidence, source)
  ```
  Where `catalog_id` is from the `search()` result's `catalog_id` field.

- **If no match found** across any linked global catalog:
  Synthesise a meaningful `topic` (e.g. `security`, `reliability`, `auth`) and `key` (kebab-case: e.g. `missing-circuit-breaker`, `sql-injection-risk`), then:
  ```
  remember(topic, key, description, { entity_type: 'Pattern' })
  ```
  This creates a project-level DRAFT for PE/PA review. PE decides if it warrants global promotion.

### 6. Resolve fixed deviations

For OPEN deviations that were **not** surfaced in this scan:
- If the code change genuinely fixes the deviation, confirm it is resolved.
- The deviation status will transition to RESOLVED when re-scanned and not found (tracked via `last_seen_at`).

### 7. Check updated conformance

```
conformance(include_details: true)
```

Report the new score, delta from step 1, and any new open deviations.

### 8. Return scan summary

```json
{
  "deviations_new":       N,
  "deviations_confirmed": N,
  "deviations_resolved":  N,
  "candidates_surfaced":  N,
  "score_before":         X,
  "score_after":          Y
}
```

---

## Important Constraints

- **One call per pattern, not per file.** If SQL injection risk appears in 12 files, that is ONE `deviate()` call with all 12 files in `evidence.files`. Creating 12 separate deviation records inflates the count and distorts the score.
- **Never call `deviate()` for a catalog entry that is not in the project's `globals` list.** The gateway will return `not_linked` — check `search()` results for `catalog_id` before calling `deviate()`.
- **`remember()` for unmatched findings always goes to project DRAFT** — never write directly to a global catalog during a scan. Global promotion is a deliberate PE/PA decision, not an automatic scan output.
- **Source field** should reflect the originating tool: `'code-review'`, `'security-review'`, or `'agent'` for manually identified patterns.

---

## Scheduled Scanning

To set up a nightly scan:

```
schedule("nightly", "quorum:scan")
```

This creates a recurring remote agent that runs an incremental scan (`git diff HEAD~1`) every night and updates deviation `last_seen_at` timestamps. Deviations that disappear from scans are automatically tracked as candidates for resolution.

---

## UNCERTIFIED State

If `conformance()` returns `status: 'UNCERTIFIED'`:

| Reason | Action |
|--------|--------|
| `scan_count = 0` | Run this skill to establish a baseline |
| No linked catalogs | Run `quorum:onboard` to link global catalogs first |
| Catalog < 10 ACTIVE entries | Ask PE/PA to seed the global catalog before scanning |
