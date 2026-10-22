---
name: tune-policy
description: Tune context-harness's folding policy with the person from measurements of their own session - measure, interview, dry-run a candidate, then apply it. Use when the person wants to change what context-harness folds, or says folding is too aggressive, too weak, or makes the model re-read too often.
---

# Tune the context-harness policy

The policy decides which completed tool results context-harness folds into one-line pointers at compaction. Its values are this plugin's settings, the same rows `/config` shows under context-harness. This skill picks them with the person from what their own session shows, and applies them only after they agree.

| Value | Default | What it changes |
| --- | --- | --- |
| `keepRecentTurns` | 2 | Results from this many most recent turns are never folded |
| `minFoldChars` | 1000 | Smaller results are never folded |
| `keepErrorsUnder` | 2000 | Errors shorter than this are never folded |
| `keepTools` | TodoWrite, AskUserQuestion, ExitPlanMode | These tools' results are never folded |
| `foldAtPercent` | 60 | After a turn, fold by itself once the context window is this full; 0 turns it off |
| `minSavedPercent` | 20 | ...and only when folding removes at least this share of the transcript |
| `intentFile`, `phaseFile`, `episodeDir` | `INTENT.md`, `PHASE.md`, `sessions` | The project's canonical files (the project-state and consolidate skills); change them only when the person names other paths |

The two tools below are `mcp__context-harness__policy_report` and `mcp__context-harness__set_policy`. When they are not listed, load them with ToolSearch.

## 1. Measure

Call `policy_report` with no input. It measures the current session with the folding code itself and returns JSON: `current.settings`, the result count and size, `byTool`, `bySize`, `inRecentTurns`, and `folds`, what the current policy would fold right now.

When `current.results` is under 30, tell the person this session is too short to measure well and ask whether to keep the current values or to run this skill again in a longer working session. Stop here if they choose either.

## 2. Show what was measured

In a few lines, before asking anything:

- which tools hold most of the result characters (`byTool`, top three with their share),
- what share of result characters sits in results of at least 1,000 characters (`bySize`),
- what share sits in the last one and two turns (`inRecentTurns`),
- what the current policy would fold now (`folds.results`, `folds.savedPercent`).

## 3. Ask

One `AskUserQuestion` call with up to four questions. Mark the option that follows from the measurement `(Recommended)` and say why in its description.

- **How far back they go** (`keepRecentTurns`): "How often do you or the model need a result from several turns ago?" Options 1, 2 and 4 turns. When `inRecentTurns` for 1 turn is above 50%, single turns are long and 1 still keeps most work in view.
- **Savings against re-reads** (`minFoldChars`): options 500, 1000 and 3000 characters. Recommend the size whose `bySize.charsPercent` is at least 85% with the fewest results.
- **Folding by itself** (`foldAtPercent`): options 50, 60, 75, and off (0).
- **Tools never folded** (`keepTools`, multiSelect): the current keep list plus the tools in `byTool` whose results the person may want to stay whole.

Leave `keepErrorsUnder` and `minSavedPercent` as they are unless the person asks about them.

## 4. Dry-run

Call `policy_report` with only the changed values. Then write a two-row table in your reply text, current and candidate: results folded now (`folds.results`), characters saved (`folds.savedChars`) and share of the transcript (`folds.savedPercent`). The table goes in the reply before the question of step 5, not only into that question's options. Take every number from the report; compute none yourself.

When the candidate saves less than half of what the current policy saves, say so before asking to apply.

## 5. Apply

Ask once more with `AskUserQuestion`: apply the candidate, adjust it (back to step 3), or keep the current values. On apply, call `set_policy` with only the changed values, then report each line it returns: a value set, or the reason it was refused.

The plugin reloads with the new values. Folding already done stays as it is; the new values apply from the next compaction.

## Rules

- Change the policy only through `set_policy`. Never edit the plugin's files or `settings.json` directly: the plugin's folder is replaced on update, and `set_policy` writes where Claude Code reads the values however the plugin was installed.
- Never call `set_policy` before the person agreed to the exact values.
