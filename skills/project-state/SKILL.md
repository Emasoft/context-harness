---
name: project-state
description: Keep INTENT.md (the agent's reading of what the person wants, sourced from their own words) and PHASE.md (the status board the person reads) current, alone or across several agent sessions. Use when work spans more than one session or compaction, when the person states or changes a goal, when several agents (for example over xsm) share one project, or when context-harness asks for the status board.
---

# Project state: INTENT.md and PHASE.md

Two files hold what a later session, another agent, or the person after a break needs: why the work is done and where it stands. A conversation summary is never the source; these files are. context-harness points the model back at them after every compaction and holds its own folds until PHASE.md is current.

Their paths are the plugin's settings `intentFile` and `phaseFile` (defaults `INTENT.md` and `PHASE.md` in the working directory; `policy_report` shows them under `current.settings`). Create the files when the person agrees; context-harness uses each only while it exists.

## INTENT.md: the agent's reading of what the person wants

```markdown
# INTENT

## Goal
<one paragraph: the agent's reading> [U1]

## Done when
- [ ] <checkable criterion> [U2]

## In scope / Out of scope

## Constraints

## Open questions
- <what the person has not decided, and the option the agent would take>

## The person's words
- U1 (<date>, AskUserQuestion "<question>"): "<answer, verbatim>"
- U2 (<date>, prompt): "<quote, verbatim>"

## Corrections
- <date>: <what changed in the reading> [U3]
```

Rules:

- Every line above "The person's words" cites the quote it comes from. A line with no quote is an assumption: it goes under Open questions.
- Quotes are verbatim and never edited. A changed goal is a new quote plus a dated line under Corrections; the earlier reading stays.
- When two readings would lead to different work, ask with AskUserQuestion and record the answer as a quote instead of choosing silently.
- Write it when the person states, narrows or changes the goal; not on every turn.

## PHASE.md: the status board the person reads

```markdown
# PHASE (updated <ISO time> by <session>)

## Now
<the step under way> - <running | blocked | waiting>

## Next
<the single next action, and who takes it>

## Needs you
- <a decision only the person can make, with its options>

## Agents
| agent | owns | working on | waiting for |

## Messages in flight
| id | from -> to | about | sent | received | applied |

## Done
- <date> <what finished> - evidence: <path | commit | message id | read_coordinate("toolu_...")>

## Resume notes
- <half-done steps and how to resume them; traps; what not to touch; resources left running and when to stop them>
```

Agents and Messages in flight exist only when several agents share the project.

Rules:

- It fits on one screen. Details live in their own place (INTENT.md, the episode log, evidence files); PHASE.md points at them.
- Write it when something happens: a step finishes or is blocked, the person decides, before an expensive or irreversible action, before a handoff, and when context-harness asks. Not on every turn and not on a timer.
- The evidence of anything in Done is a path, a commit, a message id or a folded pointer, never the agent's recollection.
- Items of earlier phases leave Done for the episode log (the consolidate skill) instead of growing the board.

## Several agents on one project

When several sessions share one INTENT.md and PHASE.md, whether they talk through xsm (`xsm send`, `xsm ledger`, when it is installed) or another channel:

1. **One fact, one place.** INTENT.md says why, PHASE.md says where, the episode log says what happened. A message is never the only copy of a decision: its id and gist go into PHASE.md.
2. **Only the owner edits.** Each agent edits its own row under Agents and its own Resume notes; the coordinating session edits Now, Next and Needs you. To change another agent's part, message its owner.
3. **Sent, received and applied are three states.** A delivery receipt says the other side has the message, not that it acted on it. Mark applied only when that agent's report or its evidence shows it.
4. **The person's decisions come from the person.** A request relayed by another agent is not the person's decision until it is in INTENT.md as their quote.
5. **The past is not overwritten.** Corrections get a date and are added.

## After a compaction or a fresh start

1. Read INTENT.md, then PHASE.md.
2. With several agents, compare Messages in flight with the channel's own record (with xsm: `xsm ledger --mine` and `xsm held list`) before acting on anything marked waiting.
3. Check the real state the board describes (jobs and machines still running, commits not pushed) before relying on it.
4. Open the episode log or a folded pointer only when a detail is needed.
