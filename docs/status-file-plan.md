# Status File to Prevent Restart During Active Work

## Context

When we restart Mim via `launchctl kickstart -k`, the new process calls `cleanupOrphans()` which kills all running `nanoclaw-*` Docker containers. If Mim was mid-response, the in-progress work is lost and the user gets no reply. This just happened — we restarted to pick up the `platform` attribute change and killed Mim's active container.

**Goal:** A status file that tracks active work, checked by both `cleanupOrphans()` on startup and by Claude Code sessions / operators before restarting.

## Changes

### 1. New file: `src/status-file.ts`

Simple module that manages `data/mim-status.json` (already gitignored via `data/`).

**Schema:**
```json
{
  "pid": 12345,
  "startedAt": "2026-02-24T10:00:00.000Z",
  "updatedAt": "2026-02-24T10:05:00.000Z",
  "activeTasks": 2,
  "activeGroups": ["main"],
  "containers": ["nanoclaw-main-1708787200000"]
}
```

**Exports:**
- `initStatus()` — write initial status with pid, activeTasks=0
- `writeStatus(activeTasks, activeGroups, containers)` — atomic write (write to .tmp, rename)
- `clearStatus()` — write activeTasks=0
- `readStatus()` — parse and return, or null on error
- `isStale(status)` — check if the PID in the file is still alive via `process.kill(pid, 0)`

### 2. Modify `src/group-queue.ts` — add status change callback

Add a callback mechanism so GroupQueue notifies when `activeCount` changes:

- Add `onActiveCountChange` setter method
- Call the callback after `this.activeCount++` and `this.activeCount--` in:
  - `runForGroup()` (lines 193, 217)
  - `runTask()` (lines 227, 244)

The callback receives the current `activeCount` and `groups` Map, so index.ts can extract active group names and container names for the status file.

### 3. Modify `src/index.ts` — wire status file

- Import and call `initStatus()` after `cleanupOrphans()` in `main()`
- Set the GroupQueue callback to call `writeStatus()` with current state
- Call `clearStatus()` in the shutdown handler before `process.exit(0)`

### 4. Modify `src/container-runtime.ts` — make `cleanupOrphans()` status-aware

Before killing containers, check the status file:
- If previous process is still alive (`!isStale()`) and has `activeTasks > 0` → skip cleanup, log a warning
- If previous process is dead (stale) → proceed with cleanup as normal
- If no status file → proceed with cleanup as normal (safe default)

### 5. Update `CLAUDE.md` — restart safety directive

Add to the "Development" section:

```markdown
## Restart Safety

Before restarting Mim, check the status file:

    cat data/mim-status.json

If `activeTasks` > 0, Mim is processing messages. Wait for tasks to complete before restarting — restarting kills active containers and loses in-progress responses.
```

### 6. Update `groups/main/CLAUDE.md` — agent restart directive

Add a note telling Mim it cannot restart the host service from inside Docker, and to ask the user instead.

## Files Modified

| File | Change |
|------|--------|
| `src/status-file.ts` | New — status file read/write/staleness check |
| `src/group-queue.ts` | Add `onActiveCountChange` callback, call it on activeCount changes |
| `src/index.ts` | Wire status file init, queue callback, shutdown cleanup |
| `src/container-runtime.ts` | Make `cleanupOrphans()` check status before killing |
| `CLAUDE.md` | Add restart safety directive |
| `groups/main/CLAUDE.md` | Add "you can't restart the host" directive |

## Verification

1. `npm run build` — compiles clean
2. `npm test` — existing tests pass
3. Restart Mim, send a message, verify `cat data/mim-status.json` shows `activeTasks: 1` while processing
4. Verify it returns to `activeTasks: 0` when the response completes
5. Test stale detection: kill Mim with `kill -9`, verify next startup cleans up orphans normally
