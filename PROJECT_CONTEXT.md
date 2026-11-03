---
name: jev-compaction-plus
purpose: Claude Code plugin that compacts a full session in under a second by having Jev move old tool results to a drawer file instead of summarizing.
keywords: [jev, compaction, compact, claude code plugin, drawer, context window, typesafe, preservation, precompact]
search: [docs/]
---

# Project Context: jev-compaction-plus

## Purpose

A Claude Code plugin. On `/compact` (or auto-compact at 60% context), Jev decides for each
old tool result whether it is still needed. Kept results stay word for word; dropped ones
move to `.jev-drawer/`, and the session keeps a one-line pointer Claude can read back.
Your messages, Claude's replies, the first message and the newest 6 messages are never touched.

## Status

- Fork of `tamaratran/fast-jev-compaction`, maintained by Agreor on its own since 2026-10-06.
  No upstream PRs and no automated upstream watching; reassess upstream by hand.
- Shipped: drawer mode, previews for Jev, tiny results always kept, split-reply fix,
  TypeSafe or OpenRouter key.
- `docs/assessment/` holds an opt-in compaction-preservation prototype (Claude Haiku 5.5 or
  GPT-6 Luna compactors). It is an assessment tool, not an enabled replacement for either host's compactor.
- Last change: 2026-10-26 (merge bot sync, #15).

## Where things are

- `src/`: the compactor (`compact.ts`, `request.ts`, `messages.ts`, `state.ts`).
- `hooks/`: Claude Code function hooks (`fast-jev.ts`, `hooks.json`).
- `docs/assessment/`: preservation prototype plan, report and evidence.
- README: results, settings and limitations.

## Do Not Do

- Do not treat it as local: conversation text, tool inputs and result previews go to
  TypeSafe or OpenRouter, depending on the key.
- Do not assume a compaction survives a session resume; it does not.
