# Compaction assessment — implementation record

Approved scope: opt-in TypeScript prototype, Claude Code and Codex adapters,
Haiku and GPT-6 Luna through existing CLI sign-ins, incremental session-local
decision/plan preservation, 60% target, six synthetic scenarios, bounded evaluation.
No production settings, releases, or transcript rewriting.

Tasks:
1. Durable event history and validated, immutable decision checkpoints; test recovery,
   supersession, conflicting input, concurrent updates, cadence, and session isolation.
2. CLI model runners and host adapters; test transcript normalization and restoration.
3. Synthetic evaluation harness, live model smoke tests, and bounded comparison.
4. Evidence report, implementation recommendation, full checks, independent review.

Shared interfaces: host adapters produce normalized events consumed by checkpointing;
checkpointing consumes model-generated entries; evaluation invokes the same runners
and checkpointing code as the prototype. Source references and entry IDs must remain
stable through all three boundaries.

Ruling: Native replacement is a capability probe, not permission to alter live history.
Unsupported integration stays unsupported; sidecar preservation is independently testable.
Ruling: This approved assessment plan is the spec. Keep changes uncommitted until the
coordination approval bundle, rather than making intermediate commits.

Progress:
- Worktree created from origin/main; dependencies installed without lifecycle scripts.
- CLI versions: Claude Code 2.1.300; Codex 0.162.0-alpha.17.2.
- Local catalog advertises gpt-6-luna; account access still requires a smoke test.
- Durable record, adapters, pinned CLI runners, six synthetic fixtures and native probes implemented.
- Haiku: 22/22 original continuation checks and 4/4 repeat checks passed. Luna:
  16/16 checks before a provenance-validation rejection in the large-tool fixture.
- Native auto-60 trigger observed in both disposable hosts at about 61.5% input usage.
- Fresh CLI process restored all five original steps, FTS5 and supersession history.
- Independent GPT-6 Astra review found two P2 recovery bugs. Both reproduced RED:
  missing/null checkpoint structure silently reset state; second evaluation resume hit
  EEXIST. Fixed in one pass; three regression cases GREEN. No re-review/model retry.

Rulings carried to closeout:
- Native replacement is not established; no live transcript rewrites or global activation.
  Cost if wrong: a platform-specific replacement path may need a later design.
- Keep changes uncommitted in this session-owned worktree until the coordination bundle
  is approved. Cost if wrong: shipping needs the separate reviewable approval step.
- Live hook integration, host output limits, process-restart host resume and desktop
  compatibility remain deployment gates. Cost if skipped: a record may not reach the
  next model request even though local rendering works.
- Empty extraction and semantic user agreement remain model-quality limits, not proved
  by structural validation. Cost if ignored: a valid-looking record can omit decisions.
- Codex tool isolation against hostile arbitrary transcripts is not established. Keep
  the prototype limited to opt-in/synthetic use. Cost if ignored: unexpected tool use.
- The per-call token reservation is an estimate; native scripts have separate bounds.
  The observed aggregate stayed within budget, but this is not a hard provider-side
  token cap. Cost if ignored: a future call may exceed its estimated reservation.

Deferred minors: none assigned by the reviewer. The deployment/evaluation limits above
are explicit gates, not silently approved production behavior.

Final verification: scripts/ci-gates.sh PASS (76/76 tests, typecheck including hooks,
build). Canonical cold-start authority and runtime mirrors PASS. Staged secret scan
and whitespace checks PASS. No production config changes, commits, push or PR.
