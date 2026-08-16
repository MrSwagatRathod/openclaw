# fix(gateway): `gateway stop` reports success while the gateway is still running

Closes #119065

## What Problem This Solves

`openclaw gateway stop --json` returns a success result while the gateway is still alive and serving:

```console
$ openclaw gateway stop --json
{"ok":true,"result":"not-loaded"}

$ curl -s localhost:18789/health
{"ok":true,...}
```

The command claims the gateway is not loaded, the caller believes it has stopped, and the process keeps running. Scripts that stop the gateway before an upgrade, a port handover, or a state-directory migration proceed against a live process.

## Why This Change Was Made

When no service manager owns the gateway, `stopGatewayWithoutServiceManager` (`src/cli/daemon-cli/lifecycle.ts`) resolves a PID from two sources:

1. verified listener PIDs on the port (via `lsof` on Unix), and
2. the PID recorded in the gateway lock file.

If both come back empty, the old code treated that as proof the gateway was down and returned `null`, which the caller renders as `not-loaded`.

Finding no PID does not prove the gateway is down. Both sources fail independently while the process is perfectly healthy:

- `lsof` is not installed on minimal container images, so listener discovery returns nothing.
- The gateway lock can be missing or stale — for example after a state-directory change or an unclean previous run — so there is no recorded PID either.

In that state the only reliable signal left is the port itself. This change probes it and refuses to report a stop that did not happen, so an ambiguous result surfaces as an error the operator can act on instead of a silent false success.

The check is added as `assertGatewayPortFreeWhenPidUnknown` in `src/infra/gateway-processes.ts`, next to the existing gateway PID discovery helpers it complements, and reuses the existing `probePortUsage` helper. Placing it there also keeps `lifecycle.ts` under the repo's 700-line `max-lines` lint cap.

Behavior change, limited to the "no PID found" branch:

| Port state | Before | After |
| --- | --- | --- |
| free | `not-loaded` | `not-loaded` (unchanged) |
| busy (listener observed) | `not-loaded` (false success) | error naming the occupied port |
| unknown (probe inconclusive) | `not-loaded` (false success) | error saying the stop could not be confirmed |

Paths that do find a PID are untouched. Both non-free statuses stay fail-closed, since claiming success is the more damaging outcome, but they now carry distinct messages: `busy` means a listener was actually observed, while `unknown` means the probe itself could not answer. Collapsing the two would send operators looking for a listener that may not exist.

## User Impact

`openclaw gateway stop` no longer reports success when it could not stop anything. When the port is still occupied and the process cannot be identified, it fails with:

```
port 18789 is in use but the gateway process could not be identified
(lsof unavailable or the gateway lock is missing/stale);
run "openclaw gateway status --deep" to investigate
```

When the probe cannot determine the port state at all, the message is instead:

```
could not determine whether port 18789 is still in use, so the gateway
cannot be confirmed stopped;
run "openclaw gateway status --deep" to investigate
```

Users on containers without `lsof`, or with a missing/stale lock, get a clear pointer to the diagnostic command instead of a wrong answer. Normal stops on a genuinely free port are unaffected.

## Real-behavior proof

Run end to end against a live gateway, not only in unit tests. The host reproduces the #119065 conditions exactly: no systemd (`Failed to connect to bus: Permission denied`), `lsof` not installed, and a real gateway serving on `http://127.0.0.1:18789/`. The gateway lock was deleted to create the missing/stale-lock condition. The command under test is `openclaw gateway stop --json --force` against the default state dir with no environment overrides.

The before/after runs differ only in whether the built CLI calls the new guard.

```console
### BEFORE THE FIX (guard removed from the built CLI)
$ command -v lsof || echo 'lsof: not installed'
lsof: not installed

$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\n' http://127.0.0.1:18789/
gateway HTTP 200

# a missing/stale gateway lock is the #119065 condition
$ rm -f $LOCKDIR/gateway.*.lock

$ openclaw gateway stop --json --force
{
  "action": "stop",
  "ok": true,
  "result": "not-loaded",
  "message": "Gateway service disabled.",
  "service": {
    "label": "systemd user",
    "loaded": false,
    "loadedText": "enabled",
    "notLoadedText": "disabled"
  }
}

# is the gateway actually stopped?
$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\n' http://127.0.0.1:18789/
gateway HTTP 200

### AFTER THE FIX
$ command -v lsof || echo 'lsof: not installed'
lsof: not installed

$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\n' http://127.0.0.1:18789/
gateway HTTP 200

# a missing/stale gateway lock is the #119065 condition
$ rm -f $LOCKDIR/gateway.*.lock

$ openclaw gateway stop --json --force
{
  "action": "stop",
  "ok": false,
  "error": "Gateway stop failed: Error: port 18789 is in use but the gateway process could not be identified (lsof unavailable or the gateway lock is missing/stale); run \"openclaw gateway status --deep\" to investigate"
}

# is the gateway actually stopped?
$ curl -s -o /dev/null -w 'gateway HTTP %{http_code}\n' http://127.0.0.1:18789/
gateway HTTP 200

### CONTROL: with the lock intact, the fixed build still stops the gateway
$ curl -s -o /dev/null -w "gateway HTTP %{http_code}\n" http://127.0.0.1:18789/
gateway HTTP 200

$ ls ~/.openclaw/tmp/openclaw-*/gateway.*.lock
/home/user/.openclaw/tmp/openclaw-1001/gateway.94e6aae2.lock
/home/user/.openclaw/tmp/openclaw-1001/gateway.state.lock

$ openclaw gateway stop --json --force
{
  "action": "stop",
  "ok": true,
  "result": "stopped",
  "message": "Gateway stop signal sent to unmanaged process on port 18789: 6181.",
  "service": {
    "label": "systemd user",
    "loaded": false,
    "loadedText": "enabled",
    "notLoadedText": "disabled"
  }
}

$ curl -s -m 5 ... (after stop)
gateway HTTP 000
connection refused (gateway really stopped)
```

The control run at the end matters as much as the failure cases: with the lock intact the fixed build still stops the gateway, reports `"ok": true, "result": "stopped"`, and the port stops answering. The fix does not turn working stops into false failures.

## Evidence

New regression tests, both verified to fail without the fix:

- `src/cli/daemon-cli/lifecycle.test.ts` — the unmanaged stop path fails instead of returning `not-loaded` when the port is busy, and the existing "not running" test now asserts the port is confirmed free first.
- `src/infra/gateway-processes.test.ts` — `assertGatewayPortFreeWhenPidUnknown` resolves for a free port, rejects against a real listening socket, and reports `busy` and `unknown` with their own distinct messages.

```
# with the fix
✓ src/cli/daemon-cli/lifecycle.test.ts (44 tests)
✓ src/infra/gateway-processes.test.ts (10 tests)
✓ src/infra/ports-probe.test.ts
  Test Files  3 passed (3)
       Tests  55 passed (55)

# with the fix reverted, tests kept
  Tests  2 failed | 42 passed (44)
   × fails instead of reporting a stopped gateway when the port is busy but no pid is identifiable
   × skips unmanaged signaling for pids that are not live gateway processes
```

Wider validation:

- `npx vitest run src/cli/daemon-cli/` → 42 files passed, 670 passed / 4 skipped
- `npx oxlint src/cli/daemon-cli/ src/infra/` → 0 warnings, 0 errors
- `npx oxfmt --check` on all touched files → clean
- `npx tsc -p tsconfig.json --noEmit` → no errors in touched files
- `node --import tsx scripts/check-src-extension-import-boundary.mts --json` → `[]`

Note: `src/infra/restart-stale-pids.test.ts` has 6 failures, confirmed pre-existing by stashing this change and re-running on a clean tree. They are unrelated to this PR and not addressed here.

## AI assistance

This change was AI-assisted. The diagnosis, fix, tests, and validation output above were reviewed against the reported reproduction in #119065.
