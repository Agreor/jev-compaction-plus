# Claude Code hook

`fast-jev.ts` is the plugin's `session.compact` and `turn.complete` hook (the file keeps the
upstream name). It reads the plugin options, finds the Jev key, picks the endpoint from the key
(TypeSafe, or OpenRouter for `sk-or-` keys), resolves the drawer folder against the session's
directory, runs the library in `../src/` and writes the drawer files before handing the compacted
messages back. Manual or native compaction falls back to Claude Code's built-in summary on errors or insufficient savings. Plugin-triggered attempts leave the conversation unchanged instead. The default minimum reduction is 10%; zero savings is never accepted. All automatic attempts are spaced by five percentage points of context growth, restarting from lower usage when compaction is observed, with a final retry allowed at 100%.

See the main [README](../README.md) for install, settings and limitations.
