Closes #124394

## What Problem This Solves

Fixes an issue where users running two OpenClaw processes that each save a setting before `settings.json` exists would silently lose one of those settings. This affects the very first write to a settings file in both scopes — the global `~/.openclaw/agents/<agent>/settings.json` and the project `.openclaw/settings.json`.

Both processes report success, nothing is written to the logs, and the user simply finds one of their settings missing (for example, a theme change made in one session disappears because another session saved a default model at the same moment). Because there is no error surfaced anywhere, the loss is invisible until the user notices the setting reverted.

## Why This Change Was Made

`FileSettingsStorage.withLock` only acquired the file lock when `settings.json` already existed, and it performed its read *before* acquiring that lock. On the create path both processes therefore read "no file", both computed a merge from an empty base, and the second writer replaced the first.

The merge callback below it (`persistScopedSettings`) is already written as a locked read-modify-write — lock ordering was the only reason it did not behave as one. This change re-reads the file once the lock is granted on the create path and re-runs the merge callback when the locked contents differ from the unlocked read, so the loser of the create race merges its field on top of the winner's file instead of clobbering it.

Scope is deliberately narrow: the already-exists path is untouched (it locks before reading and was always correct), and the callback is only re-invoked when the file genuinely changed underneath, so the common uncontended first write still does exactly one read, one merge, and one write.

## User Impact

Concurrent first writes to a settings file now both land. A setting saved by one process is no longer silently discarded by another process saving a different setting at the same time, so users keep the preferences they set.

## Evidence

Two regression tests were added to `src/agents/sessions/settings-manager.test.ts`:

- `merges against the locked file when another process creates it first` — drives the exact race by creating the file inside the callback (between the unlocked read and lock acquisition) and asserts both settings survive.
- `writes normally when no competing process creates the file` — pins the uncontended path so the fix does not change ordinary first-write behavior.

## Real-behavior proof

Two genuinely separate OS processes racing the very first write to a new `settings.json`, with a clock-synchronized start so both enter the read-modify-write window together. Each process writes a different field and reports what it wrote; the harness then prints the file and checks whether both fields survived.

```console
### BEFORE THE FIX
agent dir: /tmp/openclaw-settings-race-Ndp2iA
no settings.json yet:
drwx------  2 user user   60 Aug 16 08:14 .
drwxrwxrwt 24 root root 4096 Aug 16 08:14 ..
pid 4145 wrote defaultModel=anthropic/claude-opus-4
pid 4140 wrote theme=dracula
--- resulting settings.json ---
{
  "theme": "dracula"
}
--- verdict ---
FAIL: a setting was silently lost (model=0 theme=1)

### AFTER THE FIX
agent dir: /tmp/openclaw-settings-race-itnZL3
no settings.json yet:
drwx------  2 user user   60 Aug 16 08:14 .
drwxrwxrwt 24 root root 4096 Aug 16 08:14 ..
pid 4226 wrote theme=dracula
pid 4227 wrote defaultModel=anthropic/claude-opus-4
--- resulting settings.json ---
{
  "theme": "dracula",
  "defaultModel": "anthropic/claude-opus-4"
}
--- verdict ---
PASS: both settings survived the first-write race
```

Repeated runs: **before the fix, 5/5 runs lost a setting** (4 lost the theme, 1 lost the model) while both processes reported success. **After the fix, 10/10 runs keep both fields.**

## Reviewer notes

On the suggestion to preserve the public callback's single-call contract: this is a real external contract, and the review was right to raise it. `FileSettingsStorage`, `InMemorySettingsStorage`, and the `SettingsStorage` type are re-exported from `src/agents/sessions/extension-sdk.ts`, which the extension loader virtualizes as `openclaw/plugin-sdk/agent-sessions` (`src/agents/sessions/extensions/loader.ts`). Third-party extensions can therefore implement or call these types, so the change is written to keep that surface intact.

Concretely:

- **No exported symbol is added, removed, or renamed.** `grep '^export'` on `settings-manager.ts` produces the same symbol list before and after this change; only line numbers move. `SettingsMutator` and `LockedUpdateSettingsStorage` are deliberately module-private (not exported) so the SDK surface and the unused-export gate both stay clean.
- **`withLock` keeps its exact previous behaviour and signature.** A custom `SettingsStorage` implemented by an extension continues to work unchanged, because `withLockedUpdate` is opt-in and detected via `supportsLockedUpdate`; anything that does not advertise it takes the original path.
- **The mutator is still invoked exactly once** on both paths — no retry loop and no double invocation, so callbacks with side effects behave as before.

Extension-surface tests were run to confirm nothing regressed there: `src/agents/sessions/extensions/loader.test.ts` and `loader.bun-virtual-modules.test.ts` (the virtual-module test that asserts `openclaw/plugin-sdk/agent-sessions` resolves) both pass.

The temporary directories created by the new tests are removed in `afterEach`.

**Test fails on the unfixed code** (fix stashed, test kept):

```
 × merges against the locked file when another process creates it first
   AssertionError: expected [ undefined ] to deeply equal [ undefined, …(1) ]
 Tests  2 failed | 12 passed (14)
```

**Test passes with the fix:**

```
✓ src/agents/sessions/settings-manager.test.ts (7 tests)
Tests  14 passed (14)
```

Wider lane, no regressions:

```
pnpm exec vitest run src/agents/sessions/
Test Files  99 passed | 1 skipped (100)
     Tests  1152 passed | 5 skipped (1157)
```

Lint, format, and typecheck are clean on the touched files (`oxlint`: 0 warnings / 0 errors, `oxfmt --check`: correct format, `tsc --noEmit`: no diagnostics for these paths).

Verification of the underlying defect before fixing, using the real `FileSettingsStorage` against a temp dir — process B's write is gone and process A reports success:

```
file: {"a":1}          <- {"b":2} written by the other process was lost
observed reads: [ undefined ]
```

## AI Assistance

This change was AI-assisted. The defect was reproduced against the real storage class, the fix was written and reviewed by a human-directed agent session, and the failing-then-passing test evidence above was produced by actually running the suite locally.

## Re-verified against current main

Re-checked after upstream moved to `cae9ecab`, since this branch was opened against an older base.

The defect still reproduces on today's `main` — two real OS processes, clock-synchronised, both creating `settings.json` for the first time:

```
# on upstream/main @ cae9ecab (unfixed)
FAIL: a setting was silently lost (model=0 theme=1)
FAIL: a setting was silently lost (model=0 theme=1)
FAIL: a setting was silently lost (model=0 theme=1)
```

With this change applied, the same harness passes every run:

```
PASS: both settings survived the first-write race   (5/5 runs)
{ "defaultModel": "anthropic/claude-opus-4", "theme": "dracula" }
```

Gates re-run on the rebased tree:

- `vitest run src/agents/sessions/settings-manager.test.ts` — 20 passed
- `vitest run .../extensions/loader.test.ts .../loader.bun-virtual-modules.test.ts` — 4 passed
- `oxlint` — 0 warnings / 0 errors, `oxfmt --check` — correct format
- `tsgo -p tsconfig.core.json` — exit 0
