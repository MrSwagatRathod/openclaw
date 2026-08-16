# fix(apply_patch): refuse ambiguous tolerant hunks instead of silently editing the wrong block

Closes #124392

## What Problem This Solves

`apply_patch` could apply a hunk to the wrong location and report `Success`. Given a file with two blocks holding the same statements at different nesting depths:

```python
def handle_early(payload):
	if payload:
		flush()
		return None


def handle_target(payload):
	for item in payload:
		if item:
			flush()
			return None
```

a deletion-only hunk quoting the *3-tab* pair inside `handle_target()` — written with spaces, which is what a model emits when it re-indents its own quote of the file:

```
*** Begin Patch
*** Update File: handlers.py
@@
-            flush()
-            return None
*** End Patch
```

deleted the statements from `handle_early()` instead, left `handle_target()` intact, and returned `Success. Updated the following files: M handlers.py`.

This is silent data loss. The model has no signal that the edit landed somewhere else, so it proceeds believing the file is in a state it is not in.

## Why This Change Was Made

In `src/agents/apply-patch-update.ts`, `seekSequence` falls back through increasingly tolerant comparisons:

```ts
const normalizers = [
  (value: string) => value,
  (value: string) => value.trimEnd(),
  (value: string) => value.trim(),
  (value: string) => normalizePunctuation(value.trim()),
];
for (const normalize of normalizers) {
  for (let i = searchStart; i <= maxStart; i += 1) {
    if (linesMatch(lines, pattern, i, normalize)) {
      return i;
    }
  }
}
```

The exact pass runs over the whole range first, so exactly quoted hunks were never affected. But once it fails — which *any* indentation drift causes — the `trim()` and `normalizePunctuation(trim())` passes make indentation and punctuation irrelevant and return the **first** hit in file order, with no uniqueness check. A hunk aimed at a nested block therefore matches a shallower lookalike earlier in the file.

The fix counts matches within each tolerant pass and refuses when more than one location matches, rather than guessing. This mirrors the sibling `edit` tool, which already treats exactly this ambiguity as an error (`edit-diff.ts` → `getDuplicateError`: *"The text must be unique. Please provide more context to make it unique."*). `apply_patch` had no counterpart; now it does.

Two deliberate scoping decisions:

- **The exact pass keeps first-match-wins.** An exactly quoted hunk names its target unambiguously, so files with repeated identical blocks stay editable. Requiring uniqueness there would have made those blocks unreachable — a regression, not a fix. There is a test pinning this.
- **`seekSequence` is retained** as a thin wrapper over the new `searchSequence`, so the separate `changeContext` lookup keeps its existing behavior. Only the hunk-location path consumes the new ambiguity signal.

Behavior change, limited to the tolerant passes:

| Situation | Before | After |
| --- | --- | --- |
| exact match (any number) | first match | first match (unchanged) |
| tolerant match, unique | applied | applied (unchanged) |
| tolerant match, 2+ locations | **applied to first, reports success** | refused, file untouched |

## User Impact

A hunk that cannot be placed unambiguously now fails loudly instead of corrupting a different part of the file:

```
Found 2 occurrences of these lines in handlers.py. The lines must be unique.
Please include surrounding context lines to make the hunk unique:
            flush()
            return None
```

The message tells the model exactly how to recover — add surrounding context — which is the same remediation path the `edit` tool already teaches. Patches that were landing correctly are unaffected; the only patches that change outcome are the ones that were previously landing in the wrong place.

## Evidence

Reproduced first against the unmodified code, using the reporter's fixture. Before the fix, case A deleted the body of the **wrong** function while reporting success, and case B (same patch, ambiguity removed) landed correctly — isolating ambiguity as the cause:

```
=== A ambiguous ===        early lost body: true    target lost body: false   <-- wrong block
=== B unique ===                                    target lost body: true    <-- correct block
```

New regression tests in `src/agents/apply-patch-ambiguous-hunk.test.ts` (5 tests) cover: the ambiguous hunk is refused, the error names the count and asks for context, a unique tolerant hunk still applies to the intended nested block, exactly quoted repeated blocks still resolve first-match-wins, and an end-to-end `applyPatch` call leaves the file byte-identical when refused.

```
# with the fix
  Test Files  10 passed (10)
       Tests  168 passed (168)      # all apply-patch suites incl. the new file

# with the fix reverted, tests kept
       Tests  6 failed | 4 passed (10)
   × refuses a tolerant hunk that matches more than one block
   × names the ambiguity and asks for more context, like the edit tool does
   × leaves the file untouched when the patch is refused
```

Wider validation:

- All 158 pre-existing apply_patch tests pass unchanged — no legitimate matching was broken.
- Every test file referencing `apply_patch` across `src/agents`: **38 files, 1764 passed / 2 skipped**.
- `npx oxlint` + `npx oxfmt --check` on touched files → clean.
- `npx tsc -p tsconfig.json --noEmit` → no errors in touched files.
- `node --import tsx scripts/check-src-extension-import-boundary.mts --json` → `[]`.

## Related

PR #124379 (open) touches the `searchStart` computation in this same function for a different defect (an `*** End of File` chunk seeking backward). This change does not modify `searchStart` and should not conflict semantically, though the two will need a trivial textual merge if both land.

## Reviewer notes

Ambiguous `@@` context markers now report their own error instead of being folded into the generic "failed to find context" message. When the tolerant pass finds a marker more than once, the error names the marker and the occurrence count:

```
Found 3 occurrences of context 'def handle(self):' in app/handlers.py.
The context must be unique. Please use a more specific @@ context line.
```

Previously an ambiguous marker surfaced as "Failed to find context", which pointed at the wrong problem: the context was found, just not uniquely. The internal `seekSequence` wrapper that discarded the ambiguity signal was removed, so the ambiguous case can no longer be silently downgraded to "missing".

This PR is now a single commit scoped to apply_patch only. The settings-manager commit that was previously in this branch has been removed; it belongs to #124471.

Note on overlap: this touches the same matching code as open PR #124379 (apply_patch EOF-location repair). If that lands first I will rebase; the two protections are independent and both should be retained.

## AI assistance

This change was AI-assisted. The reproduction, fix, tests, and all validation output above were run and verified against the report in #124392.

## Overlap with #124379 — verified compatible

This PR and #124379 (`apply_patch` end-of-file hunk repair) both touch `computeReplacements` in `src/agents/apply-patch-update.ts`, so the overlap was tested rather than assumed.

#124379 changes one line inside the EOF search:

```diff
-  const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
+  const searchStart = eof ? Math.max(start, maxStart) : start;
```

This PR does not modify that line — it removes the thin `seekSequence` wrapper and makes the ambiguous-match case throw. Merging the two locally is a clean auto-merge (no conflict), and the merged result keeps #124379's `Math.max(start, maxStart)` cursor **and** this PR's ambiguity guard:

```
git merge pr124379
  Auto-merging src/agents/apply-patch-update.ts
  Merge made by the 'ort' strategy.

grep searchStart src/agents/apply-patch-update.ts
  const searchStart = eof ? Math.max(start, maxStart) : start;
```

Both test suites pass together on the merged tree, so whichever lands first, the second still applies cleanly:

```
vitest run apply-patch-ambiguous-hunk.test.ts apply-patch-eof-hunks.test.ts apply-patch.test.ts
  Test Files  6 passed (6)
       Tests  122 passed (122)
```

## Re-verified against current main

Checked after upstream advanced to `cae9ecab`; every file this PR touches is byte-identical between this branch's base and current `main`, so the rebase is clean and the diff is unchanged.

```
vitest run src/agents/apply-patch*.test.ts -> Test Files 10 passed, Tests 172 passed
oxlint  -> Found 0 warnings and 0 errors.
oxfmt --check -> All matched files use the correct format.
tsgo -p tsconfig.core.json -> exit 0
```

No exported symbol is added, removed, or renamed: `grep '^export'` on `apply-patch-update.ts` yields an identical symbol list before and after.
