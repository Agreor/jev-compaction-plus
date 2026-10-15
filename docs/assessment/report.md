# Compaction assessment — 2026-10-15

**Recommendation: keep native compaction and advance Haiku-backed preservation as an
opt-in prototype. Do not replace native compaction or enable this globally yet.**

The evidence supports session-local decision preservation mechanics. It does not show
that an external compactor beats native compaction on representative long projects.
The quality and efficiency gates for a production replacement remain unmet.

## Findings

| Candidate | Preservation evidence | Result |
|---|---|---|
| Haiku `claude-haiku-5-5` | Six synthetic discussions, three checkpoints each; repeat of long refinement | 22/22 original continuation checks and 4/4 repeat checks passed |
| Luna `gpt-6-luna` | Four discussions completed | 16/16 continuation checks passed; stopped on a validation failure in scenario five |
| Native Codex, Luna working model | Three real explicit compactions in one synthetic thread | Four facts preserved; compaction events verified; 3.68–4.34 seconds per compact |
| Native Claude through print mode | `/compact` returns success at the transport layer but says it is unavailable | Unsupported in this environment; the resulting quiz is not native-compaction evidence |

Luna's rejected update referenced an existing decision entry (`durable-004`) as an
original-message source. The contract requires event IDs such as `u5` or `tool4`.
The validator rejected it, retained the preceding checkpoint, and preserved the new
conversation as uncovered evidence. This is an operational validation failure, not
proof that Luna forgot the underlying fact. No model-quality retry was attempted.

On the **same first four fixtures**, checkpointing alone consumed:

| Compactor | Calls | Reported input + output tokens | Total elapsed | Median call |
|---|---:|---:|---:|---:|
| Haiku | 12 | 43,212 | 79.36 s | 6.56 s |
| Luna | 12 | 158,836 | 59.55 s | 4.99 s |

These are token counts, including cached input, not a price comparison. They exclude
working-model continuation from this matched checkpoint-only table; all calls,
continuation usage, and timings are retained in the evidence. Luna's CLI startup is
roughly 12.5k input tokens even for an empty extraction, versus Haiku's roughly 1.4k.
Luna produced smaller records, while Haiku produced more verbose records.

The large-tool-output case also exposes a prototype cost: original evidence supporting
existing entries is resent at later checkpoints, including the long tool log. The
next design should keep original evidence durable while avoiding repeated transmission
of unchanged large tool outputs. Changing that policy needs a separate comparison.

## What was implemented

The opt-in CLI provides checkpoint, render, status and threshold commands, plus host
hook adapters. It stores original events, immutable entry revisions, source references,
supersession links, and an atomic latest checkpoint. It serializes updates, flags
uncovered events after extraction failure, and keeps session state separate. Records
include proposals, rejections, questions, constraints, plan steps, progress and next
actions, not only a prose summary.

Local tests cover reopening, supersession, interruption, concurrency, short-session
nonactivation, transcript normalization/reconciliation, provenance validation and hook
restoration. Tool outputs are not user agreement; mixed Claude message blocks are split.
The subprocess runner uses sign-ins, disables custom plugin/hook activation, rejects
recursive calls, and checks observed output for unexpected tool use.

## Host capability assessment

| Capability | Claude Code 2.1.300 | Codex 0.162.0-alpha.17.2 |
|---|---|---|
| Earlier native threshold | Documented per-model auto-compact window; CLI flag available | Token limit and `total` scope documented |
| Preservation around compaction/resume | Documented hooks; local adapter tests pass | Documented hooks; local adapter tests pass |
| External transcript replacement | Existing plugin uses early-access function hooks; persistence limitation remains | No supported replacement method established by this assessment |
| Explicit native compaction automation | Print-mode slash command unavailable | App-server compaction events verified |
| Durable prototype record | Local persistence/recovery tests pass | Local persistence/recovery tests pass |
| Live plugin injection, process-restart resume, desktop integration | Not established | Not established |

The existing Jev plugin targets 60% but is disabled locally. It preserves conversation
text and filters tool outputs, so it provides little compression for refinement-heavy
chat. Its existing tests remain passing. A live Jev comparison was excluded by the
subscription-only/no-direct-API-billing constraint.

Codex reported an effective Luna context window of 258,400 tokens; 60% is **155,040**.
Use the working model's effective window. Do not use the compactor's context size or
copy that number to other models. In disposable native sessions, both hosts triggered automatically with thresholds
set to 60%: Codex at 155,040 of 258,400 tokens and Claude at 120,000 of a launch-limited
200,000-token window. Observed input before compaction was 158,998 (61.53%) in Codex
and 123,071 (61.54%) in Claude, consistent with checking at request boundaries. These
are native-trigger mechanics tests, not live preservation-hook integration tests. No production settings were changed.

## Evidence validity and limits

Six predefined synthetic scenarios cover long plan refinement, decision reversal,
proposals versus agreement, exact constraints, a large untrusted tool result, and
interruption/resume. The same Luna working model answered every sidecar continuation
and full-original-context reference. Gold answers never entered model prompts.
Full-original-context results are **references**, not simulated native baselines.

One scoring bug rejected `PostgreSQL (local)` against `PostgreSQL`. A tested rule now
accepts that unambiguous suffix while rejecting cloud qualifiers and wrong databases.
All arms' stored outputs were rescored without rerunning them. Original scores and the
amendment are retained. The resumed run completed Luna's previously skipped scenarios
until its actual validation failure; no failure was hidden by a retry.

The first Codex native probe waited for a deprecated notification and timed out, despite
a real compaction event. The corrected probe recognizes `contextCompaction` items.
The first Claude probe mistakenly treated successful transport as successful compaction;
that evidence is invalidated. The corrected code requires a new transcript boundary.

The native Codex API reports zero input/output billing tokens for compaction updates,
with a separate nonzero context-size value. Those zero fields are not token savings.
A complete native-vs-sidecar cost comparison, including representative 60% native baselines,
has not been established. Trigger mechanics alone do not establish efficiency. Synthetic passing results cannot prove that every decision
will survive an arbitrary long session. No production recommendation relies on such
a claim.

The aggregate run used 80 conservatively counted CLI/model operations and 1,311,726
known reported tokens, below the agreed 100-call/two-million-reported-token ceilings.
This includes native probes and two failed setup attempts with unknown usage; the known
token total does not treat unknown native Codex compaction usage as zero. The Claude
auto probe uses cumulative model-usage counters, which include its compaction work.
All probes completed within one hour.

## Next implementation decision

Keep the shared preservation core and separate host adapters. Before enabling them:

1. Run live, isolated hook injection and process-restart/resume tests in each host,
   including restoration of a plan larger than the host's default hook-output limit.
2. Replay representative sanitized long refinement sessions against native-at-60%
   and native-plus-preservation, with actual decision inventories and equal continuation
   tasks. Count checkpointing, native compaction, restoration, recovery and retries.
3. Reduce unchanged large-evidence retransmission and assess whether event-based
   checkpointing beats the prototype's five-turn/8k cadence. Test improved Luna provenance
   handling as a new candidate rather than repairing evaluation failures in place.
4. Enable only a session/profile opt-in after zero marked-decision losses and a measured
   15% efficiency improvement with no more than 10% regression in the other metric.
   If quality improves but cost rises, present that tradeoff explicitly.

Tracked evidence: [manifest](evidence/manifest.json), [all call metadata](evidence/results.json),
[scenario scores](evidence/outcomes.json), [synthetic model outputs](evidence/model-outputs.json),
[aggregate/native summary](evidence/summary.json), and [scoring amendment](evidence/scoring-amendment.json).
Raw host traces and session archives remain private in the local state directory.

Primary host references: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude auto-compaction](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window),
[Claude hooks](https://code.claude.com/docs/en/hooks).

## Review disposition

Independent GPT-6 Astra review found two P2 recovery defects: a malformed checkpoint
could be presented as an empty record, and a second evaluation resume failed with
`EEXIST`. Both were reproduced with failing regression tests and fixed in one pass.
Missing entries and null pointers now fail visibly; ordinary resume is separate from
explicit `--resume --rescore`, and the original score snapshot is never overwritten.
Three regression cases passed after the fixes. No additional model evaluation was
needed and no second reviewer was used to claim approval.

Live hook compatibility, actual host output limits, process-restart host restoration,
desktop behavior and hostile-input isolation remain unestablished. A schema-valid empty
extraction can still omit a decision: completeness is evaluated behaviorally, not
inferred from the structural provenance validator. The evaluator's token reservation
is an estimate; a single call can exceed that estimate. The measured aggregate is
within the agreed ceiling, but future production use needs a hard budget boundary.
See the implementation record for all closeout rulings and their consequences.
