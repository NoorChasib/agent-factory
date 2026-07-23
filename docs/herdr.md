# Herdr worker custody

Worker-process custody uses one dedicated Herdr session named `agent-factory`. The subsystem
owns the scoped command builder, durable pane/process identity, restart re-association, and
deterministic recovery classifications; operations composition supplies installed paths and CLI
routing.

## Session boundary

Every Herdr operation is parsed through a strict discriminated union containing the literal
session name `agent-factory`. The guarded adapter rejects another session name before it can call
the injected command adapter. Ensure, list, create, attach, takeover, kill, and their tests all
cross that guard. There is no unscoped pass-through and no operation that enumerates or stops all
Herdr sessions.

One outer worker receives one pane whose stable label is its execution ID. The guarded adapter
uses the installed Herdr command grammar with `--session agent-factory` as a global scope:
snapshot to ensure the session, split/rename/run to launch a pane, process-info to observe its
shell, agent attach for attended access, and pane close for an explicit kill. Worker command
arguments are passed as an argument vector; environment entries and terminal input use Herdr's
dedicated pane options rather than a shell interpolation. The adapter itself never logs or
persists the worker command, environment, or terminal input.

Herdr owns the launched worker process. The controller does not kill panes when its own process
closes, and startup recovery performs only ensure/list/identity reads. Attaching and detaching
are Herdr client activity and do not change worker liveness.

## Process-tree identity

`HerdrSessionManager` receives an injected `ProcessTreeAdapter`. Herdr reports the stable pane
shell PID but does not report its OS start time. After launch the manager requires that PID to be
present in an OS inspection, obtains the start time from that inspection, then stores the
complete tree in `process_metadata.runtimeMetadata`. Tracking the pane shell as the stable root
also captures the outer worker as its descendant. The existing first-class columns retain:

- pane ID;
- root process ID;
- root process start time;
- controller host identity; and
- execution/attempt association.

No ledger migration is needed. Runtime metadata also records the fixed session name, factory or
operator custody, provider session ID, inspected descendants, attachment/takeover timestamps, and
an explicit kill timestamp. It never stores argv, prompt text, environment values, stderr, or a
checkout path.

On controller restart, the manager reads the durable execution aggregate, lists only panes in
`agent-factory`, and inspects each recorded root PID. A process is considered live only when all
of these match:

1. the recorded pane still exists;
2. its pane name is the execution ID;
3. pane and ledger shell PIDs match; and
4. the OS inspection contains that PID with the recorded start time.

The last check prevents PID reuse from attaching an execution to an unrelated process.

Recovery returns one of three stable classifications:

| Classification | Meaning |
| --- | --- |
| `still-running` | Pane and OS process identity both match; the inspected tree is refreshed. |
| `exited-with-result` | No live identity remains and the latest attempt has a terminal result. |
| `orphaned` | No live identity remains but the execution has no terminal attempt result. |

Recovery never infers success from a missing process and never sends a kill command.

## Attach and takeover

Attach requires the durable pane association and a current pane with the matching execution name.
It records `lastAttachedAt` after the guarded attach operation. Takeover performs the same checks,
uses the separately guarded takeover operation, changes custody to `operator`, and records
`takenOverAt`. Neither flow deletes provider or process identity, so an attended operator can
inspect the exact preserved session.

The recovery renderer emits copyable CLI commands for show, attach, takeover, resume, and
release. Service routing calls these scoped APIs rather than constructing unguarded Herdr
commands.

## Deterministic verification

Tests use `ScriptedCommandAdapter` and `ScriptedProcessTreeAdapter`. They feed strict fixtures
matching Herdr's tagged `pane_info`, `pane_list`, and `pane_process_info` protocol responses and
assert that every request begins with `--session agent-factory`. Other session names are rejected
without consuming a command step, restart recovery does not issue close, and a reused PID with a
different start time is orphaned. No installed Herdr, provider, network, Git, or OS process is
invoked by these tests.
