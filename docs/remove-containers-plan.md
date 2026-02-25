# Remove Docker Containers: Run Agent SDK In-Process

## Context

NanoClaw runs the Claude Agent SDK inside Docker containers for security isolation. For our fork (Mim), this adds significant overhead with limited benefit:

- **Container cold starts** add 15-45 seconds to first response
- **Container rebuilds** (`./container/build.sh`) take 2+ minutes and are required for any agent-runner code change
- **Docker Desktop dependency** on an aging Mac (Monterey, Intel)
- **Complexity** — IPC via filesystem, output marker parsing, mount construction, orphan cleanup
- **The self-restart problem** — Mim can't restart its own host process from inside Docker

The agent already runs with `bypassPermissions` inside the container, so the security boundary provides limited practical protection for a single-user setup.

**Goal:** Remove Docker containers entirely. Run the Claude Agent SDK directly in the host Node.js process.

## Architecture: Before and After

### Current (Container)

```
Host Process
  └─ GroupQueue.enqueue()
       └─ runContainerAgent()
            └─ spawn("docker run ...")
                 └─ [Container]
                      ├─ agent-runner/index.ts → query()
                      ├─ ipc-mcp-stdio.ts (MCP subprocess)
                      └─ writes IPC files → /data/ipc/
                           └─ Host polls and processes
```

### Proposed (In-Process)

```
Host Process
  └─ GroupQueue.enqueue()
       └─ runAgent()
            └─ query() from @anthropic-ai/claude-code
                 ├─ MCP tools registered in-process
                 ├─ Progress streaming via callback
                 └─ Direct function calls for IPC actions
```

## What Changes

### Files Deleted

| File | Reason |
|------|--------|
| `src/container-runner.ts` (658 lines) | Replaced by in-process agent runner |
| `src/container-runtime.ts` (77 lines) | No Docker to detect or clean up |
| `container/Dockerfile` | No container image |
| `container/build.sh` | No container build |
| `container/agent-runner/package.json` | Dependencies move to host |
| `container/agent-runner/tsconfig.json` | No separate compilation |

### Files Created

| File | Purpose |
|------|--------|
| `src/agent-runner.ts` | In-process SDK query loop. Replaces both `container-runner.ts` and `container/agent-runner/src/index.ts`. Same `runAgent()` signature (ContainerInput → ContainerOutput). |
| `src/mcp-tools.ts` | MCP tool server (in-process). Replaces `container/agent-runner/src/ipc-mcp-stdio.ts`. Tools call host functions directly instead of writing IPC files. |

### Files Modified

| File | Change | Effort |
|------|--------|--------|
| `src/index.ts` | Import `runAgent` from new module instead of `runContainerAgent` from container-runner. ~5 lines. | Trivial |
| `src/group-queue.ts` | Replace `process: ChildProcess` with `abortController: AbortController`. Replace `containerName` with `taskId`. Keep concurrency, queueing, IPC. ~30% of file. | Small |
| `src/task-scheduler.ts` | Same import swap as index.ts. | Trivial |
| `src/config.ts` | Remove `CONTAINER_IMAGE`, `CONTAINER_MAX_OUTPUT_SIZE`. Rename `MAX_CONCURRENT_CONTAINERS` → `MAX_CONCURRENT_AGENTS`. Keep `IDLE_TIMEOUT`, `CONTAINER_TIMEOUT` (rename to `AGENT_TIMEOUT`). | Trivial |
| `package.json` | Add `@anthropic-ai/claude-code` as host dependency. | Trivial |

### Files Unchanged

| File | Why |
|------|-----|
| `src/channels/*.ts` | Channels are completely decoupled from agent execution |
| `src/ipc.ts` | Can keep file-based IPC polling as-is (MCP tools still write files), OR simplify to direct calls later |
| `src/db.ts` | No container dependency |
| `src/router.ts` | No container dependency |
| All test files | Update imports, tests should pass with minimal changes |

## Migration Detail

### 1. New `src/agent-runner.ts`

This file absorbs logic from two sources:

**From `container/agent-runner/src/index.ts`:**
- SDK `query()` call with options (model, cwd, allowedTools, hooks, mcpServers)
- Session ID tracking and resume
- Progress event emission (text blocks, tool_use formatting)
- Message stream for follow-up messages (IPC input → async iterable)
- Pre-compact hook (transcript archival)
- Pre-tool-use hook (bash secrets sanitization)

**From `src/container-runner.ts`:**
- `ContainerInput` / `ContainerOutput` interfaces (keep as-is for compatibility)
- Timeout management (idle + hard timeout)
- `writeTasksSnapshot()` and `writeGroupsSnapshot()` helpers
- `readSecrets()` for API keys

**Key differences from container version:**
- No stdin/stdout marker protocol — direct async callbacks
- No mount construction — pass `cwd` and paths directly to SDK
- `cwd` is the group directory (`groups/{folder}`) instead of `/workspace/group`
- Session storage at `data/sessions/{groupFolder}/.claude/` — set via env or SDK option
- MCP server spawned as in-process stdio server (still a subprocess but local, not containerized)

### 2. New `src/mcp-tools.ts`

Replaces `container/agent-runner/src/ipc-mcp-stdio.ts`. Still an MCP stdio server (the SDK spawns it as a subprocess), but runs on the host instead of inside Docker.

**Tools (unchanged API):**
- `send_message` — write IPC file (or call host function directly)
- `schedule_task`, `pause_task`, `resume_task`, `cancel_task` — task management
- `register_group` — main only
- `get_model`, `list_models`, `set_model` — model switching
- `download_attachment` — media downloads
- `create_emoji` — Discord emoji creation

**Simplification opportunity:** Since we're on the host, tools could call host functions directly instead of writing IPC files. But keeping file-based IPC initially means less refactoring of `src/ipc.ts`. Can optimize later.

### 3. GroupQueue Adaptation

Replace process-based tracking with promise-based:

```typescript
// Before
process: ChildProcess | null;
containerName: string | null;

// After
abortController: AbortController | null;
taskId: string | null;
```

The `sendMessage()`, `closeStdin()`, and `notifyIdle()` methods still write IPC files to `data/ipc/{group}/input/` — the in-process agent reads them the same way the container agent did.

### 4. Path Changes

Container paths → host paths:

| Container Path | Host Path |
|---|---|
| `/workspace/group/` | `groups/{folder}/` |
| `/workspace/project/` | Project root (main group only) |
| `/workspace/ipc/` | `data/ipc/{folder}/` |
| `/workspace/media/` | `data/media/{folder}/` |
| `/home/node/.claude/` | `data/sessions/{folder}/.claude/` |

The agent's `CLAUDE.md` files reference `/workspace/` paths. These need updating to reflect host paths, or we set `cwd` so relative paths still work.

### 5. Security Considerations

**What we lose:**
- Filesystem isolation — agent can access any file the Node.js process can
- Network isolation — agent shares host network
- Resource limits — no cgroup constraints

**What we keep:**
- `allowedTools` — SDK enforces which tools the agent can use
- Bash sanitization hook — strips API keys from shell environment
- MCP tool authorization — non-main groups can't cross-talk
- `readSecrets()` — keys loaded on-demand, not persisted in env

**What we should add:**
- Consider setting `cwd` per group so the agent's working directory is scoped
- Keep the mount allowlist concept as a "directory allowlist" for additional paths

## Implementation Order

1. Add `@anthropic-ai/claude-code` to host `package.json`
2. Create `src/mcp-tools.ts` (port from ipc-mcp-stdio.ts, update paths)
3. Create `src/agent-runner.ts` (port query loop, session management, hooks)
4. Update `src/index.ts` and `src/task-scheduler.ts` imports
5. Adapt `src/group-queue.ts` (process → promise tracking)
6. Update `src/config.ts` (remove/rename container vars)
7. Run tests, fix breakage
8. Delete `src/container-runner.ts`, `src/container-runtime.ts`
9. Delete `container/Dockerfile`, `container/build.sh`, `container/agent-runner/`
10. Move `container/skills/` to `skills/`
11. Update CLAUDE.md, README, docs

## Verification

1. `npm run build` — compiles clean
2. `npm test` — all tests pass
3. Send Mim a message via Telegram — response arrives without Docker running
4. Check progress messages appear (text blocks + tool use)
5. Test session persistence — resume a conversation
6. Test scheduled tasks — cron job fires and produces output
7. Test MCP tools — `send_message`, `schedule_task` work
8. Test concurrency — send messages to multiple groups simultaneously
9. Verify Docker Desktop can be quit with no impact

## Consequences

**Gains:**
- Zero cold start overhead (agent is an async function call)
- No container rebuild step — `npm run build` is all that's needed
- No Docker Desktop dependency
- Simpler debugging — one process, one set of logs
- Mim can restart its own host process (solves the self-restart problem)
- ~600 lines of container plumbing deleted

**Losses:**
- No filesystem sandbox — agent has host-level access
- No per-group filesystem isolation (groups share the Node.js process)
- Harder to enforce resource limits (memory, CPU) per agent

**Neutral:**
- IPC file-based communication can stay or be simplified later
- Session persistence works the same way (just different paths)
- All channel code, progress pipeline, typing indicators — completely unaffected
