# Opt-in compaction preservation prototype

This is an assessment tool, not an enabled replacement for either host's compactor.
Existing plugin behavior and user settings are unchanged. See [the findings](report.md)
and [implementation record](plan.md).

## Run locally

```sh
npm ci --ignore-scripts
npm run build
npm run assessment -- threshold 258400
npm run assessment -- checkpoint codex example-session /absolute/events.json claude-haiku-5-5 --force
npm run assessment -- status codex example-session
npm run assessment -- render codex example-session
```

`events.json` is an array of `{id, role, text, turn}` objects. IDs must be unique and
stable; roles are `user`, `assistant`, or `tool`; turn numbers are monotonic. Supply
append-only full normalized history. `--force` flushes pending events; otherwise the
cadence is five additional user turns or 8,000 byte-estimated tokens. Token estimates
use UTF-8 bytes divided by four, not a model tokenizer.

Available compactors are pinned to `claude-haiku-5-5` and `gpt-6-luna`. Calls reuse CLI
subscription sign-ins and do not accept API keys. A model unavailable to the account
fails without substitution. Claude reports its resolved model; Codex exec JSON in the
installed version does not, although the native app-server probe confirms Luna access.

State defaults to `~/.local/state/compaction-assessment/<host>-<session-hash>/`.
`--root /absolute/path` overrides that location for experiments. It contains the full
archived conversation (`events.json`), immutable checkpoints, and an atomic latest
pointer. This is private task data, not a project-wide source of instructions. No
automatic cleanup is performed. Remove state only when the session no longer needs
its evidence.

Catch-up processes at most two batches per `Stop` invocation and one per `PreCompact`,
each targeting 8,000 byte-estimated tokens of new events. Event boundaries are
preserved; a single larger event is sent intact. Current (non-superseded) entries are
additional input; their source text and superseded entries are not resent. Claude
compactor calls run at `--effort low`. Each model call has a 140-second timeout.

`Stop` returns `{}` at once and checkpoints in a detached worker, so the host never
waits on the model. A worker failure is silent; its backlog stays UNCOVERED and the
next hook retries it. When `TYPESAFE_API_KEY` is set, Jev filters each batch first:
user messages always go to the compactor, tool results and pure tool calls never do,
and Jev keeps assistant prose it rates at 0.3 or higher (uncalibrated). A batch with
nothing kept advances coverage without a compactor call. If Jev fails, the full
batch goes to the compactor. Assistant prose is sent to Jev. Each validated batch is committed before
the next starts; later hooks continue from that prefix, and PreCompact may still
leave a backlog. Native compaction continues; restoration marks the backlog UNCOVERED.
A rejected structured response is saved privately as `rejected.json` with the rule
that failed and batch coverage. This record may contain conversation data; it stays
in the session state directory, never the host scratchpad.

A failed extraction preserves the previous checkpoint and archived pending events.
The renderer marks those events UNCOVERED. Structural validation checks provenance,
not the semantic completeness of an extraction. The evaluation tests that separately.
A lock serializes checkpoint updates. A process killed while holding the lock can leave
`lock/`; verify no checkpoint process is active before manually removing that directory.
Corrupt/missing checkpoints fail visibly rather than silently returning an empty record.

## Host adapters (experimental, not installed)

`node /absolute/clone/dist/assessment/cli.js hook <claude|codex> <compactor>` reads a
standard host hook JSON envelope on stdin and writes JSON on stdout. Supported events:

- `Stop`: archive new transcript events and checkpoint if due. Subagent envelopes skip.
- `PreCompact`: force a pending checkpoint, without blocking native compaction on failure.
- `SessionStart`: restore the record on `compact` or `resume`, without another model call.

Register these only in a disposable test configuration. Use `SessionStart` matcher
`compact|resume`, `Stop` with no matcher, and `PreCompact` matcher `auto|manual`.
Command hooks need an execution timeout of at least 120 seconds. Codex restoration
handlers must set `additionalContextLimit: 0` to avoid the host truncating larger plans.
Review/trust hooks through the host's normal flow; this prototype never bypasses trust.
The adapters have local envelope/transcript tests; live host injection and desktop
compatibility have **not** been established. No hook config is automatically installed.

Claude and Codex JSONL are normalized separately. Synthetic compaction summaries are
not treated as fresh user approval. Mixed Claude prose/tool-result messages are split
by role. Stable message identity reconciles archived history with compacted transcript
tails; changed or reordered identities fail instead of resetting prior decisions.

CLI compactor subprocesses use a temporary directory, disable custom hooks/plugins,
and refuse recursive compactor invocation. Claude disables its tool set. Codex disables
shell, apps, plugins, multi-agent and browser features and uses a read-only sandbox;
its CLI does **not** expose a verified switch removing every built-in tool definition.
Observed tool activity invalidates a result. This is suitable for the synthetic
assessment, not proof of tool isolation for arbitrary hostile transcripts.

## Targeting 60%

`threshold <effective-window>` computes `floor(window * 0.60)`. Use the working model's
host-reported window, not the compactor's window. The Codex native probe reported
258,400 tokens for Luna, giving a target of 155,040. Codex exposes
`model_auto_compact_token_limit` with scope `total`; Claude exposes a per-model
auto-compact window. Apply values only in test profiles and recompute when switching
models/windows. Automatic triggering occurs at host safe points and can overshoot.
Disposable native probes observed automatic compaction around 61.5% in both hosts,
after a request crossed the configured 60% threshold. This does not establish live
preservation-hook or desktop integration.

## Reproduce the assessment

```sh
npm run assessment:evaluate -- /absolute/empty-output-directory
npm run assessment:native-codex -- /absolute/native-output-directory
npm run assessment:native-claude -- /absolute/native-output-directory
# Optional native trigger probes (large synthetic padding; spend substantial quota):
npm run assessment:native-codex -- /absolute/auto-codex-directory --auto
npm run assessment:native-claude -- /absolute/auto-claude-directory --auto
```

These commands spend subscription quota. Do not run them as routine tests. The
comparison uses synthetic data only: six 15-turn discussions, three checkpoints per
candidate, fixed continuation questions, and a repeat for candidates completing the
evidence floor. Native probes use dedicated synthetic sessions. Codex verifies explicit compaction
events; Claude requires transcript boundaries and reports print-mode unavailability.
The optional --auto probes exercise native automatic triggers. Their histories remain in the hosts' normal session storage.

The evaluation stops at 100 calls or one hour and checks an estimated reservation
against a two-million **reported** token budget before each call,
including its four recorded preflight attempts. The reservation is not a hard
provider-side per-call ceiling, so one call can exceed its estimate. Native probes are separately bounded;
account for them against the remaining aggregate budget before running them. In this
assessment, aggregate calls remained below 100. Native compaction may not report all
billing tokens, so unknown usage is kept unknown rather than counted as a saving.

`--resume` continues a completed/interrupted comparison from saved checkpoints and
outcomes; it never retries a model quality/validation failure. The separate `--resume --rescore` operation applies the recorded scoring
amendment handling the observed harmless `PostgreSQL (local)` qualifier across all arms.
Original scores remain alongside the corrected scores. The run directory keeps the
manifest, raw replies, timings, usage, checkpoints, restored context and per-question
answers; tracked evidence contains only synthetic outputs and summarized metadata.
