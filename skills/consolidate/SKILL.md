---
name: consolidate
description: Turn what a stretch of work produced into lasting memory - bring PHASE.md up to date, add episodes to the dated episode log, promote repeated procedures and decision-changing lessons into project skills, and propose lasting principles for AGENTS.md. Use when context-harness asks before folding, at the end of a unit of work, or before handing off.
---

# Consolidate memory

Memory moves one way, from what happened, to how to do it, to what always holds, and each step points back to the one before it:

```
event (a run, a failure, a decision)
  -> episode    <episodeDir>/<date>-<slug>.md     what happened, when, and the evidence
  -> procedure  .claude/skills/<name>/SKILL.md    when it repeats, or changes the next decision
       -> code  a script, or a DAG the engine runs  when the procedure is deterministic and keeps repeating
  -> principle  AGENTS.md                          when it should always hold, after the person agrees
```

When nothing new was learned, change no file and say so. A consolidation that rewrites what is already there is noise.

## 1. Status board

Bring PHASE.md up to date first, in the form the project-state skill gives: Now, Next, Needs you, Resume notes. Items of earlier phases leave Done for the episode below.

## 2. Episodes

Add an entry for this stretch of work to the episode log folder (the plugin setting `episodeDir`, default `sessions/`), in `<YYYY-MM-DD>-<slug>.md`; append to today's file when there is one.

```markdown
## <ISO time> <what this stretch was>
- Did: <what changed> - evidence: <path | commit | message id | read_coordinate("toolu_...")>
- Found: <a measured fact> - measured: <where and how>
- Decided: <the decision> - source: <INTENT.md quote id | message id>
- Failed: <what failed>, cause: <the cause, or "unknown">
- Corrected: <an earlier statement that turned out wrong> - originally: <date and place>
```

Rules:

- Every fact carries its time and its source. A folded tool result is an evidence address: cite its `read_coordinate("toolu_...")`.
- Append. An earlier entry is never rewritten; a correction is a new line naming what it corrects.
- Write what the next session cannot recover from the code, the git history or the files themselves.

## 3. Procedures into project skills

Promote something to a project skill only when one of these holds, and say which:

- the same procedure was carried out a second time (two episodes describe it), or
- a lesson changes what the next agent should decide: a failure's cause, a trap, a check that would have caught it.

Then:

- Edit the project skill that already covers the area before creating one: list `.claude/skills/` first, and `.agents/skills/` when the project keeps skills for other harnesses there.
- The skill body holds the steps and checkable rules; detail needed only in some cases goes in its `references/`. Each rule says why, citing the episode that taught it.
- Generalize. The skill states the rule, not the incident's names and numbers; those stay in the episode it cites.
- A new skill has a `name` and a `description` saying when to use it.
- Tell the person, one line per skill, what changed and the episode behind it.

A skill is read and carried out by an agent each time. When a procedure needs no judgment at any step, keeps repeating, and its success can be checked by code (a sweep, a benchmark, a regression), propose moving it out of the agent's loop instead: a script that skips finished outputs, or a DAG that runs, retries and reports by itself and calls an agent only on failure. When the just-dag-it skill (`dag-it`) is available, follow it for that decision and the move. Propose it; do not build it without the person's agreement.

## 4. Principles into AGENTS.md

A rule that should hold for every task in the project, not a procedure for one kind of task, belongs in the project's AGENTS.md (or CLAUDE.md). Propose the exact line and its source with AskUserQuestion, and add it only after the person agrees.

## Done when

- PHASE.md and the episode log were written since the last compaction, or nothing new happened and you said so.
- Every skill or principle added or changed was named to the person with its source.
