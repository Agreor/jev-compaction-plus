# Reviewable shipping bundle

Branch: `agent/codex/20261015-compaction-assessment`, based on `origin/main`.
Worktree remains local and uncommitted. No production compaction settings were changed.

## Result

The approved assessment prototype is implemented. Prefer Haiku-backed preservation for
further opt-in validation; keep native compaction. Native 60% triggering is feasible in
both hosts. See [findings and limits](report.md) and [rulings](plan.md).

## Verification

- `bash scripts/ci-gates.sh`: PASS; 76 tests, TypeScript and hook type checks, build.
- Staged repository secret scan and whitespace check: PASS.
- Canonical cold-start authority/runtime mirrors: PASS.
- Fresh compiled CLI process restored all original plan steps and superseded history.
- Two independent-review P2 findings reproduced RED and fixed GREEN in one pass.
- npm reports 7 pre-existing dependency advisories (3 moderate, 2 high, 2 critical);
  dependency versions were unchanged. No dependency-upgrade scope was added.
- The generic workspace check selector recommended Python checks that do not exist in
  this TypeScript repository; its owner-provided CI script was run instead.

## Proposed commit and PR

Commit message: `Add opt-in decision preservation assessment and host probes`

PR title: `Assess reliable compaction with durable decision checkpoints`

PR body:

Adds an opt-in CLI prototype that preserves source-linked decisions and refined plans across compaction, with immutable checkpoints, recovery checks, and Claude Code/Codex adapters. Includes synthetic Haiku/Luna comparisons and native host probes; no hooks or production settings are enabled.

Validation: scripts/ci-gates.sh passed all 76 tests, type checks and build; staged secret scan passed. Native automatic compaction was observed around 61.5% with thresholds set to 60% in both disposable hosts. Independent review found two recovery defects; failing regression tests reproduced both, and the fixes passed the full suite.

Limits: live preservation-hook injection, desktop compatibility, host process-restart restoration and production quality/efficiency remain unestablished. The per-call token reservation is estimated. Haiku passed 22/22 original checks plus 4/4 repeat checks; Luna stopped on a provenance-validation failure. This assessment does not justify replacing native compaction.

## Exact files

- `.gitignore`
- `README.md`
- `docs/assessment/README.md`
- `docs/assessment/approval.md`
- `docs/assessment/evidence/auto-threshold.json`
- `docs/assessment/evidence/manifest.json`
- `docs/assessment/evidence/model-outputs.json`
- `docs/assessment/evidence/outcomes-before-rescore.json`
- `docs/assessment/evidence/outcomes.json`
- `docs/assessment/evidence/results.json`
- `docs/assessment/evidence/scoring-amendment.json`
- `docs/assessment/evidence/summary.json`
- `docs/assessment/plan.md`
- `docs/assessment/report.md`
- `package.json`
- `src/assessment/adapters.ts`
- `src/assessment/claude-native-probe.ts`
- `src/assessment/cli.ts`
- `src/assessment/evaluate.ts`
- `src/assessment/fixtures.ts`
- `src/assessment/native-probe.ts`
- `src/assessment/record.ts`
- `src/assessment/runner.ts`
- `tests/assessment-adapters.test.ts`
- `tests/assessment-evaluation.test.ts`
- `tests/assessment-hook.test.ts`
- `tests/assessment-native.test.ts`
- `tests/assessment-record.test.ts`
- `tests/assessment-runner.test.ts`

## Shipping boundary

Approval of this bundle covers commit, push, PR and the ship bot under
`SubAgents/docs/coordination.md`. Nothing is committed or queued yet.
