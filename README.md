# context-harness

A Claude Code mod for long sessions. It does two things, and the first needs nothing but the mod:

- **Folds instead of summarizing.** When the conversation compacts, completed tool results become one-line pointers and their originals are kept on disk; the model reads them back with `read_coordinate`. The project's intent and status files, not a summary, carry the work across compactions.
- **Judges where a rule cannot decide.** With a key for Jev, TypeSafe's decision model (a TypeSafe key, or an OpenRouter key that reaches the same model), it adds gates: a turn that ends by announcing work it has not done, tool calls that touch secret files when another provider serves the session, instructions attached only when a request needs them, and a record of which folded results the request still needed. **Every Jev setting is off by default**; installing the mod and having a key sends nothing.

```text
[folded Read · …/src/billing/invoice.ts · 1201 lines — read_coordinate("toolu_01J7igoRSuY8xw8F8skCSEY3")]
```

It joins two plugins that were built apart to test each idea: [context-fold](https://github.com/ysys143/context-fold) and [jev-harness](https://github.com/ysys143/jev-harness). Apart, they could not share what one compaction did, and their order of loading decided whether the second saw it at all.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install context-harness --marketplace ysys143/context-harness
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install context-harness --marketplace ysys143/context-harness`. In the desktop app: + next to the prompt box, Plugins, Add marketplace `ysys143/context-harness`, then Add plugin.

The install may report the settings as not set: until you change them in `/config`, the defaults below apply.

Requires Claude Code 2.1.306 or later. The mod API it uses (function hooks) is marked early access and may change between releases.

### Upgrading from context-fold or jev-harness

Uninstall both first. Installed beside either, folding or sending to Jev happens twice.

- **Folds made by context-fold** stay readable: `read_coordinate` looks in `~/.claude-context-fold/<session>/` after its own archive, for the same session.
- **Settings and the key** do not carry over: set them again under context-harness (`/config`, and `/plugin configure context-harness@context-harness` for the key).
- **jev-harness records** under `~/.local/state/jev-harness/` are not read; their fold verdicts came from a copy of the rule that this release replaces with the fold itself. Delete that folder when you no longer need it.
- **Coming from jev-harness alone**, you now also get folding at compaction, an automatic `/compact` once the window is 60% full (`foldAtPercent`, 0 turns it off), originals kept on disk, and a note after each compaction.
- **Coming from context-fold alone**, you now also get `/jev-report`, `/jev-mark`, a hook on every tool call that passes straight through while the gates are off, and a cleanup of judgment records older than 14 days at each session start.
- **Behaviour that changed:** a fragment already in the conversation is not attached again after a compaction that only folded (jev-harness attached it again); fold judgment records state what the fold did, counting turns as the fold does.

## Folding

1. **At compaction** (`/compact`, the engine's automatic compaction, or step 3), the mod answers in place of the engine's summary. Each tool result the policy picks is written to the archive and replaced by a pointer. Messages it does not change are handed back untouched.
2. **If folding is not enough** (the folded transcript still exceeds 60% of the window), the folded transcript goes on to the engine's own summary.
3. **At an idle boundary**, when a turn has ended with the window at least `foldAtPercent` full, the mod runs `/compact` itself, but only if folding would remove at least `minSavedPercent` of the transcript: each compaction rebuilds the prompt cache once. When the project keeps a status board or an episode log not written since the last compaction, it first asks the agent to consolidate (at most twice).
4. **After every compaction** it appends a note: what was folded, and which canonical files to re-read.
5. **`read_coordinate`** (`mcp__context-harness__read_coordinate`) returns the original, or a range of its lines with `offset` and `limit`.

| Setting | Default | Why |
| --- | --- | --- |
| `keepRecentTurns` | 2 | The work in progress still reads the most recent turns |
| `minFoldChars` | 1000 | In a measured session, 44% of results held 90% of all tool output |
| `keepErrorsUnder` | 2000 | Short errors stop the model repeating the same mistake |
| `keepTools` | `TodoWrite,AskUserQuestion,ExitPlanMode` | Small, and they hold current decisions |
| `foldAtPercent` | 60 | When to fold by itself after a turn; 0 turns it off |
| `minSavedPercent` | 20 | Fold by itself only when it saves at least this share |
| `intentFile` | `INTENT.md` | The agent's reading of what you want; empty turns it off |
| `phaseFile` | `PHASE.md` | The status board; empty turns it off |
| `episodeDir` | `sessions` | The episode log folder; empty turns it off |

`/context-harness:tune-policy` measures your session with the folding code itself (`policy_report`), asks you a few questions, dry-runs the values you chose beside the current ones, and applies them only after you agree (`set_policy`, which writes these nine settings and no other).

## Project state and memory

A compaction summary is never the source of truth; files the project keeps are. The mod uses three, each only while it exists, and never writes them itself: the agent does, and the mod checks and points.

| File | What it holds | Written when |
| --- | --- | --- |
| `INTENT.md` | The agent's reading of what you want: goal, done-when, scope, constraints, open questions, each line citing your own words | You state or change a goal |
| `PHASE.md` | The status board you read: now, next, what needs you, done with evidence, resume notes; with several agents, who owns what | A step ends or blocks, you decide, before a handoff, when the mod asks |
| `sessions/<date>-<slug>.md` | Episodes: what happened, when, and the evidence (paths, commits, folded `read_coordinate` ids) | Each stretch of work, append-only |

- `/context-harness:project-state` keeps `INTENT.md` and `PHASE.md`, alone or across several agent sessions, with the rules that keep one board consistent.
- `/context-harness:consolidate` turns a stretch of work into memory that lasts: the board, an episode, repeated procedures as project skills, lasting principles into `AGENTS.md` once you agree. A deterministic procedure that keeps repeating is proposed as code: see [just-dag-it](https://github.com/ysys143/just-dag-it).

## Judgment layer

| Gate | Hook | What it does | What leaves the machine |
| --- | --- | --- | --- |
| Stop gate (`stopGate`) | `classic.Stop`, after your own Stop hooks | Catches a turn that ends by announcing work it has not done ("이어서 리팩터링하겠습니다", "Next, I will…") | The turn's last paragraph, scrubbed |
| Tool gate floor (`toolGate`) | `tool.call`, every tool, and `read_coordinate` | Finds calls that touch secret files or print secrets; refuses them when another provider serves the session. Refuses writes to this mod's files, its archives and Claude settings | Nothing |
| Tool gate Jev (`toolJev`) | `tool.call`, external sessions only | Classifies each call the floor let through as open, standard, restricted or custom from its path or command; refuses restricted and custom | The tool name and the scrubbed target |
| Conditional instructions (`instructions`) | `prompt.submit`, `prompt.compose` | Attaches an instruction fragment to the prompt that first meets its condition | Your prompt, scrubbed, first 600 characters, and the fragments' conditions (never their bodies) |
| Fold relevance (`foldJev`, shadow only) | `session.compact`, beside the fold | Records which of the largest earlier results your request still needs, beside what the fold did | Your last prompt, scrubbed, and for each result its tool and target: the path, the start of the command, or the search pattern, URL or description it was called with (never its output) |

Each is `off`, `shadow` (record what it would do) or `active` (do it), set separately. Scrubbing removes secret-shaped strings, `NAME=value` secrets, email addresses and your home folder.

### Stop gate

1. Your settings Stop hooks run first; if one blocks, that stands.
2. Not judged: re-entry, plan mode, background or scheduled work, subagents, a last sentence that is a question, and one with a condition ("알려주시면 처리하겠습니다", "once the checks pass…").
3. A rule looks for an announcing ending; Jev is asked a two-way choice, `announce` or `report`.
4. In `shadow` the turn ends at once and the judgment is recorded afterwards. In `active`, `announce` at or above `stopThreshold` (0.7) sends the model back to do the work or say what it needs from you.

### Tool gate

- **Provider trust.** First-party only when every sign agrees: an Anthropic credential, no `HTTPS_PROXY`/`HTTP_PROXY`, no `NODE_EXTRA_CA_CERTS`, no Bedrock/Vertex/Foundry, and an `ANTHROPIC_BASE_URL` that is empty or `https://*.anthropic.com`. A local proxy counts as external unless listed in `trustedProxies`. `providerTrust: external` forces external; nothing forces first-party.
- **Secret files.** `.env` and `.env.*` (not `.example`, `.sample`, `.template`), `*.env`, `~/.ssh` (not `*.pub`), `~/.aws`, `~/.gnupg`, gcloud, `~/.kube/config`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, Codex and Claude credential files, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `*.pem`, `*.p12`, `*.pfx`, `*.kdbx`, `id_rsa` and kin, resolved through `~`, `$HOME`, `..` and symlinks.
- **Shell.** Every argument of a Bash command is checked, including git pathspecs, `--opt=path` and redirects; `env`, `printenv`, `export -p`, `security … -w` and `gh auth token` count too.
- **Folded originals.** In an external session with the gate on, `read_coordinate` judges the call that produced a folded result as that call would have been judged, following a path that still exists to what it leads to; reading the archive folders directly is refused the same way. A secret file folded earlier does not come back either way.
- A guard that breaks in active mode refuses the call. `toolJev` asks once per target and session, never about a path the floor names.

### Conditional instructions

Claude Code already loads instructions by path (`.claude/rules/*.md` with `paths:`, CLAUDE.md in subfolders). These fragments are for conditions a path cannot tell, such as what you are asking for. A fragment is a Markdown file in `fragmentsDir` (default `~/.agents/fragments`, at most 24, each at most 4 KB):

```markdown
---
when: The person asks for prose meant for human readers, such as a report, an email or documentation.
keywords: report, email, 보고서
---
Lead with the conclusion. One idea per paragraph. Cut filler.
```

- **Attached once, kept.** A fragment is appended to the prompt that first meets its condition and stays in the conversation, so the cached prefix stays. Before each prompt, the mod counts the fragments the next request still carries, and those attached to prompts still queued behind a running turn: a compaction that only folded keeps them, one the engine summarized drops them, and only dropped ones may be attached again.
- **A keyword decides without Jev**; otherwise one request asks about every fragment not attached, and `instructionThreshold` (0.95) attaches. `pin: true` puts a fragment in one fixed section at the end of the system prompt.
- Only prompts you write are judged. Write conditions narrowly: a broad prose condition reached 0.92-0.96 on "tell me in one sentence what this file shows".
- `examples/fragments/` has three generic fragments to copy.

### Fold relevance

At a compaction the prompt cache is rebuilt anyway, so judging what to keep costs no cache there. Jev is asked, for up to 48 of the largest results the fold could act on (at least `minFoldChars`), whether your current request still needs it, shown only as its tool, target and size. Each record holds what the fold did with that result and Jev's probability that it is done with. Nothing changes the compaction yet.

## Enabling the judgment layer

In `/config` under context-harness, or in `settings.json`:

```json
{ "pluginConfigs": { "context-harness@context-harness": { "options": { "stopGate": "shadow", "toolGate": "shadow", "toolJev": "shadow", "instructions": "shadow", "foldJev": "shadow" } } } }
```

Everything but the tool gate floor needs a key for Jev. The same Jev is reached two ways, each with its own key:

| Provider | Endpoint | Model | Key, from the first of |
| --- | --- | --- | --- |
| TypeSafe | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | the `apiKey` setting, a `TYPESAFE_API_KEY=` line in a `.env` in the plugin's folder, the `TYPESAFE_API_KEY` environment variable |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | the `openrouterApiKey` setting, an `OPENROUTER_API_KEY=` line in that `.env`, the `OPENROUTER_API_KEY` environment variable |

Both settings are kept in secure storage (`/plugin configure context-harness@context-harness`). The `jevProvider` setting picks the provider: `auto` (the default) uses a TypeSafe key when there is one and an OpenRouter key otherwise; `typesafe` or `openrouter` uses only that provider's key and never falls back to the other. Without the key it needs the status line says `jev: no key` and nothing is sent; `/jev-report` names the provider and where its key came from. A 401 or 402 from OpenRouter means the key or the account (credits, permissions) needs attention, not that Jev is down; a 403 usually means the same, and can also be a guardrail flag or an edge block on that one request. Like any failed call it is recorded as `http <status>`, and three in a row pause that gate for five minutes.

## Records, labels and when to turn a gate on

- `/jev-report`: per gate, records, skips by reason, coverage, failures by kind, latency, tokens, the rule-versus-Jev table with Cohen's kappa, unlabeled disagreements, and, once labeled, precision and recall at several thresholds.
- `/jev-mark <id> y|n`: label a record yourself.

Suggested before switching the Stop gate to `active`: at least 50 positive and 100 negative labels, and a threshold with precision of 0.9 or more on them. Agreement with the rule alone is not evidence: the rule flags about 5% of turn ends, so a gate that always says "no" agrees about 95% of the time.

`scripts/replay.ts` (run with `bun`) replays past transcripts (`$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`) through the Stop rule offline; `--jev N` sends up to N scrubbed paragraphs to Jev, with `TYPESAFE_API_KEY` or else `OPENROUTER_API_KEY` from the environment.

## Data and privacy

Everything the mod keeps is under one folder only you can open; every folder is made 700 before anything is written in it, and made again the same way if it was removed during a session. When that fails, nothing is written and the engine summarizes:

```text
~/.local/state/context-harness/
  archive/<session>/<tool_use_id>.json   folded originals: exactly what the tools returned. Never deleted by the mod.
  records/<session>/<gate>/<id>.json     judgment records: what was sent (scrubbed), the verdicts, timings. Deleted after 14 days.
  records/labels/labels/<id>.json        your labels, kept
  replay/                                replay output
```

Folds from before the rename stay at `~/.claude-context-fold/<session>/`; the mod reads them and never writes or deletes there. Without `HOME`, it folds nothing and lets the engine summarize, rather than write into the project. To remove what it kept:

```sh
rm -rf ~/.local/state/context-harness/archive/<session-id>   # one session's originals
rm -rf ~/.local/state/context-harness ~/.claude-context-fold # everything
```

The mod declares, and uses only for this: the network (Jev, at `api.typesafe.ai` or `openrouter.ai` by the key in use, only with a Jev setting on and a key), processes (`mkdir`, `chmod` and `find` on its own folder), and the environment (`HOME`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, and the proxy and provider variables the trust check reads). One module declares all of them, folding included, so a policy that judges modules by what they declare judges the folding with them.

## Measured

**context-harness 0.0.1** (2026-10-23, Claude Code 2.1.308, Haiku 5.5, a folder with a 301-line log and a 248-line Python file):

- **One compaction, fold and judgment together.** `/compact` folded both files (−32k characters) in the mod's own hook; the two fold records state "folded", the same ids are in the archive, and Jev put the log at 0.82-0.84 and the Python file at 0.47-0.61 done with (two runs). The status line read `folded 2 · −32k chars | jev · tool active 1 hits · instr active 3 #34e698, 1 attached · fold shadow 2 judged`.
- **`read_coordinate`** returned line 5 of the folded log exactly. With `toolGate: active` and `providerTrust: external`, `ls ~/.local/state/context-harness/archive` was refused as folded originals.
- **Fragments.** `prose` was attached once, by its keyword. After the `/compact` that only folded, the next report request did not attach it again, and the messages the next request carried held exactly one `prose` block. jev-harness 0.0.3 attached it again in the same sequence (below).
- **Cleanup.** A 15-day-old judgment record was deleted at the next session start; a 15-day-old archive file beside it was kept.
- **Folding by itself** (`foldAtPercent: 5`, every Jev setting off): after the third turn the mod ran `/compact`, folding two results; the status line read `folded 2 · −32k chars`, as context-fold's did.
- **The engine.** Context a plugin attaches at `prompt.submit` appears in `$.session.messages({ as: 'api' })`: once before a compaction, once after a compaction the hook answered with the messages it got, none after the engine's summary. This is what the fragment count relies on.
- **Tests:** 120 (`claude plugin test`). Eleven defects planted back one at a time each made at least one test fail: the cleanup over the whole folder, a fixed size floor for the judgment, the earlier turn count, folders left readable, a failed `chmod` ignored, archives readable directly, a `/compact` without `HOME`, fragments counted without the conversation, queued prompts not remembered, a failure after the fold undoing it, and a quoted opening tag taken for a block.

**context-fold 0.0.2** (Claude Code 2.1.306, Haiku 5.5):

| Compaction | Folded | Context before | After | Time |
| --- | --- | --- | --- | --- |
| First | 2 results | 137,469 tokens | 36,995 tokens | 30 ms |
| Second | 1 more result | 103,638 tokens | 23,373 tokens | 32 ms |

Asked for row 777 of a folded file, the model called `read_coordinate` with `offset: 777, limit: 1` and answered correctly. With stale `INTENT.md`, `PHASE.md` and `sessions/`, the mod asked for consolidation; the agent ran it, then the mod folded six results in 20 ms (89,108 to 26,223 tokens). With `tune-policy`'s candidate `keepRecentTurns: 1` applied, `/compact` folded the 37 results the dry run named (141,412 to 30,306 tokens).

**jev-harness 0.0.3** (Jev `jev-1.14.0`, 2026-10-22):

| Question | p50 | p95 | Tokens in / out |
| --- | --- | --- | --- |
| noul | 217 ms | 448 ms | 366 / 20 |
| choice (2 options) | 206 ms | 339 ms | 373 / 31 |
| score (4 levels) | 312 ms | 363 ms | 356 / 17 |
| 12 noul questions in one request | 184 ms (n=1) | | 1132 / 210 |

- **Why a choice, not a noul:** on "…Next I will refactor the cache layer." a noul gave 0.45-0.55 and a two-way choice 0.98-0.99 for `announce`; on a report both gave 0.01-0.02.
- **The Stop rule, replayed** over the 3,000 most recent turn ends of the author's transcripts: 1,205 skipped (conditional 898, question 297, empty 10), 91 of the remaining 1,795 (5.1%) flagged. Nudges ("계속", "go") followed 1.3% and none the rule flagged, so labels have to come from `/jev-mark`.
- **The rule against Jev** on 100 of those paragraphs, sent with the author's consent: at 0.7, both 17, rule only 23, Jev only 6, neither 54; kappa 0.35.
- **Stop gate, live:** in shadow, 7 judged turn ends, all reports, the hook holding the turn 0-1 ms. In active, 12 ordinary turns gave no false block; of 3 turns asked to end on an announcement, the one judged (0.99) was sent back, with no loop, and the settings Stop hook still ran every time.
- **Tool gate, live** (`providerTrust: external`): `.env`, a symlink to a `.pem`, `git diff --no-index /dev/null .ENV` and `printenv` refused; `README.md` and `ls` allowed; 2-4 ms per call. Jev classed `./config/secrets.yaml`, `./infra/prod.tfvars`, `./data/customers.csv` and `./research/unpublished_model.py` as restricted or custom at 1.00 and `./README.md` as open at 0.00, in 168-385 ms.
- **Conditional instructions, live:** release 0.99 and attached on "Explain in three steps how you would put version 1.2 live"; prose 0.92 (not attached) and 0.96 (attached) on two one-sentence questions. After a `/compact` that context-fold answered by folding, prose was attached again: the duplicate this release removes.
- **Fold relevance, live:** with "Look for a rounding problem in total()" as the request, Jev put `./invoice.py` at 0.11 done with and `./server.log` at 0.88; loaded after context-fold, jev-harness did not see the compaction at all.

## Limits

- Results fold only at compaction: a mod cannot rewrite a model request turn by turn.
- Claude Code already saves very large Bash outputs to a file; the largest gains come from tools whose output it keeps whole, such as `Read`.
- "Turns" are user messages with text; reminders the engine injects count too, so the recent window can be shorter than the setting.
- Subagent transcripts are not folded. A folded result is readable only from the session that folded it: not after `/clear` or in a fork.
- The mod starts its own folds by running `/compact`, so the command shows in the transcript.
- A plugin loaded before this one that answers compactions itself takes them; this mod then neither folds nor judges them.
- A changed setting reloads the mod, which starts its counters and its count of consolidation requests over.
- In `shadow`, nothing is attached, so what would have been is remembered, and forgotten only when the mod sees a compaction summarized or the conversation cleared; `active` counts the conversation instead.
- Not yet: fold relevance as a decision rather than a record; whether attached fragments make answers better; the Stop gate's accuracy on real announcements.

## Development

```sh
claude --plugin-dir /path/to/context-harness   # a session with the mod loaded
claude plugin test /path/to/context-harness    # tests/*.test.ts
claude plugin validate /path/to/context-harness
```

## Credits

The idea of folding completed tool output into addressed one-line pointers, instead of summarizing, comes from Hwang Dae Jin and Yeni, *The Context Coordinate System and the Principle of Unbroken Memory* (Philosophy That Works, 2026; DOI [10.5281/zenodo.23377916](https://doi.org/10.5281/zenodo.23377916); [repository](https://github.com/philosophythatworks/context-lattice)). This mod is an independent implementation and contains no code from that project. Related work: observation masking in [Lindenbauer et al., 2025](https://arxiv.org/abs/2508.21433), and Anthropic's [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing).

## Versions

Versions stay at 0.0.x while the plugin is young. 0.0.1 is the first release, joining context-fold 0.0.2 and jev-harness 0.0.3.

## License

MIT
