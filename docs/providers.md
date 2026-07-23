# Provider runners and circuits

Direct Claude Code and Codex runners do not take ownership of mirror, worktree, or Herdr
creation. The orchestration caller supplies a strictly validated prepared checkout containing
the absolute checkout path, target identity, default branch, and configured workflow entry
point. Process composition prepares that checkout without broadening the runner interface or
moving target policy into the factory.

## Command adapter seam

Both runners issue one `CommandRequest` through an injected `CommandAdapter`. The request fixes:

- an executable and argv array, with no shell interpolation;
- the prepared checkout as `cwd`;
- text stdin containing the target workflow entry point and factory execution identity;
- captured JSON-lines stdout and captured stderr; and
- a newly built environment map.

`BunCommandAdapter` is the production local-process adapter. Tests use
`ScriptedCommandAdapter`, which only records requests and returns fault-scripted results. No test
invokes an installed `claude`, `codex`, shell, or network process.

The worker environment is constructed from an explicit allowlist. Only `HOME`, basic locale and
terminal values, `PATH`, `TMPDIR`, and selected XDG configuration/cache paths may be copied from
the controller. The runner adds noninteractive Git/GitHub controls plus the short-lived
repository installation token as `GH_TOKEN` and `GITHUB_TOKEN`. It never copies arbitrary
controller variables, GitHub App IDs, private-key paths, PEM contents, or unrelated secrets.

The token comes from the `tokenForProject` broker interface immediately before each
launch or resume. Workers never receive the App JWT or credential used to mint it.

## Claude implementation sessions

Claude runtime configuration is read once through the central controller configuration parser:

```text
AGENT_FACTORY_CLAUDE_MODEL=claude-fable-5
AGENT_FACTORY_CLAUDE_EFFORT=high
```

Effort accepts `low`, `medium`, `high`, or `max`. Model values are bounded, single safe argv
values. Invalid values fail configuration rather than reaching a process command.

The factory asks an injected ID source for a UUID before it requests a token or calls the command
adapter. The initial command includes that UUID, the captured model, and the captured effort.
Structured stdout must contain exactly one Claude initialization record whose session ID, model,
and effort all match. Any difference is `claude-initialization-mismatch`; no fallback model is
configured or accepted.

Resume uses `--resume` with the recorded session ID and repeats the recorded model and effort.
The runner also checks the recorded execution, project, workflow, issue, and pull request before
starting a command. A new environment configuration that selects different runtime values affects
only later executions; resume continues with the recorded values and verifies structured
initialization against them.

Claude Code retains ownership of its OAuth behavior. This module has no OAuth refresh loop and
no paid-credit or fallback setting.

## Codex feedback sessions

The Codex runner launches one direct `codex exec --json` outer session for an identified pull
request. Runtime model and effort are captured with that session. Exactly one structured
`thread.started` event is required.

The thread ID is retained as soon as a valid start event is present. Therefore a malformed or
missing later worker result still becomes a failed handoff with the Codex thread available for
recovery. Resume names the recorded thread and repeats the recorded model and effort; changes to
the current launch runtime do not affect it. Changes to the project, workflow, issue, or pull
request are refused before command execution.

Unknown nested provider events are ignored. The factory records only the one outer Codex
session. Target-workflow audit or review children do not create executions, attempts, provider
sessions, or consume feedback slots.

## Structured result and independent verification

Provider output is untrusted JSON Lines. Known records are parsed with bounded Zod contracts:

- Claude initialization;
- Codex thread start;
- a classified provider failure; and
- `agent_factory.worker_result`, whose `result` is the strict version-1 `WorkerResult`.

Malformed known records, non-JSON lines, duplicate results, or missing results fail closed. The
captured session and prepared checkout remain available.

Before accepting a valid `WorkerResult`, the runner invokes an injected verification hook.
`ObservedWorkerOutcomeVerifier` compares the claim with a fresh controller-shaped GitHub
observation. Execution, target, provider session, issue, PR, branch, base branch, and head must
match. A completed result must identify an observed PR. A pushed head without an authoritative
observation is not accepted.

## Durable attempts and recovery

`ProviderExecutionRecorder` is the controller-side persistence wrapper. It depends on only seven
narrow ledger repository operations:

1. read existing execution recovery;
2. find the existing Codex session for a project/PR;
3. start an attempt;
4. register the initial provider session;
5. mark an exact session resumed;
6. save process metadata; and
7. finish the attempt.

`SqliteLedger` satisfies this interface without a migration. Failed initialization, malformed
results, provider limits, verification failures, and process failures retain session/process
metadata. Runtime metadata deliberately excludes argv, prompts, tokens, stderr, and absolute
checkout paths.

An initial run is refused once any provider session exists for that execution. Codex sessions
are additionally looked up by project and pull-request number across earlier executions. A later
feedback requeue therefore resumes the original PR thread even though the controller records a
new feedback execution. The new execution's process metadata records that same thread ID. This
makes exact resume mandatory and prevents a second Codex outer thread from being created for the
PR.

The execution row must already exist before this recorder starts an attempt. The controller
remains the sole production ledger owner/writer; runners never open SQLite themselves.

## Independent circuits and recovery

Classified account, usage-limit, authentication, availability, rate-limit, server, timeout,
transport, and invalid-response failures produce a `ProviderCircuitSignal` for exactly one of
`claude`, `codex`, `github`, or `reviewer`. Target-specific not-found and validation failures do
not open a global circuit.

The signal converts to the controller `set-provider-circuit` command. Controller commit persists
it in `provider_circuits`, and the planner blocks only the affected lane:
Claude blocks implementation, while Codex or reviewer blocks feedback. GitHub blocks both lanes.
Existing active executions and their worktrees/sessions are not released by a circuit signal.

An open circuit permits resume only through `ProviderCircuitRecovery`. Its injected probe must
return the same provider plus both `verified: true` and `recovered: true`; only then does the
module return a close-circuit command. Failed, mismatched, unverified, or unhealthy probes leave
the circuit open.

Herdr ownership and sanitized recovery comments layer over these durable results. Operations
composition owns notifications, CLI commands, and explicitly requested live recovery probes.
