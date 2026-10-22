import type { Register } from 'claude-code'
import { DEFAULT_SETTINGS, SETTING_KEYS, dueBeforeFold, dueNote, foldTranscript, makePolicy, reportFor, settingsFrom, sliceLines, transcriptChars, type PolicySettings } from './fold'
import { FOLD_POINT } from './fold-judge'
import { afterCompaction, anchorsOf, judgeFold, note, since, type Continuity } from './fold-flow'
import { askConditions, attachedNow, forgetAttached, fragmentsDirOf, loadFragments, pendingOf, recordFragments, rememberWouldAttach, wouldAttach } from './fragment-flow'
import { INSTRUCTIONS_POINT, decideFragments, fragmentBlock, keywordHit, pinnedSection } from './instructions'
import { probabilityOf, type JevResult } from './jev'
import { errorOf, judge, keyFor, trustFor } from './jev-call'
import { pointReport, type ShadowRecord } from './report'
import { scrub } from './scrub'
import { harnessSettingsFrom, usesJev } from './settings'
import { newId, runtime, startRuntime } from './state'
import { showStatus } from './status'
import { STOP_MESSAGE, STOP_POINT, STOP_QUESTION, announcesByRule, lastParagraph, stopSkipReason } from './stop-gate'
import { cleanupRecords, homeOf, legacyArchiveRoot, readArchived, readRecords, stateRoot, writeArchive, writeLabel, writeRecord } from './storage'
import { judgeTool } from './tool-flow'
import {
  TOOL_POINT,
  archivedReason,
  callPaths,
  canWrite,
  denyMessage,
  isUnder,
  normalizePath,
  pathCandidates,
  pathFieldValues,
  restrictedReason,
  secretDumpReason,
  selfProtectReason,
  type FloorVerdict,
} from './tool-gate'

// Folded and still above this share of the window: the engine summarizes the
// folded transcript too.
const SUMMARIZE_ABOVE_SHARE = 0.6
const CHARS_PER_TOKEN = 4
const READ_LIMIT = 400
// How many idle boundaries a fold waits for the status board and the episode
// log to be brought up to date before it goes ahead anyway.
const MAX_DEFERRALS = 2

const SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    keepRecentTurns: { type: 'number', description: 'Results from this many most recent turns are never folded' },
    minFoldChars: { type: 'number', description: 'Fold only results of at least this many characters' },
    keepErrorsUnder: { type: 'number', description: 'Keep error results shorter than this many characters' },
    keepTools: { type: 'array', items: { type: 'string' }, description: 'Tools whose results are never folded' },
    foldAtPercent: { type: 'number', description: 'Fold by itself once the context window is this full; 0 is off' },
    minSavedPercent: { type: 'number', description: 'Fold by itself only when it removes at least this share' },
    intentFile: { type: 'string', description: "The agent's reading of the person's intent; empty is none" },
    phaseFile: { type: 'string', description: 'The status board the person reads; empty is none' },
    episodeDir: { type: 'string', description: 'The folder of dated episode logs; empty is none' },
  },
}

export const register: Register = (on, options) => {
  const policySettings = settingsFrom(options)
  const policy = makePolicy(policySettings)
  const settings = harnessSettingsFrom(options)
  startRuntime(settings, policySettings)
  const isOn = usesJev(settings) || settings.toolGate !== 'off'
  const { counts } = runtime
  let isFoldScheduled = false
  const state: Continuity = { deferrals: 0, isJustCompacted: false }

  on('session.start', async ($, e, next) => {
    // Each half starts on its own, so one that fails leaves the other working.
    try {
      await $.tool.register({
        name: 'read_coordinate',
        description:
          'Return the original text of a tool result that was folded into a line like ' +
          '[folded Read · src/a.ts · 412 lines — read_coordinate("toolu_…")]. ' +
          'Pass that id. offset (1-based line) and limit (lines, default 400) select a part.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id inside read_coordinate("…") of the folded line' },
            offset: { type: 'number', description: 'First line to return, 1-based' },
            limit: { type: 'number', description: 'How many lines to return' },
          },
          required: ['id'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'policy_report',
        description:
          "Measure this session's tool results and what context-harness's fold policy would fold now. " +
          'With no input it reports the current policy; give any policy values to dry-run a candidate beside it. ' +
          'Used by the tune-policy skill.',
        inputSchema: SETTINGS_SCHEMA,
      })
      await $.tool.register({
        name: 'set_policy',
        description:
          "Set context-harness's fold policy values in the person's Claude Code settings, the same as /config. " +
          'Give only the values to change. Call it only after the person agreed to the values.',
        inputSchema: SETTINGS_SCHEMA,
      })
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not register its tools (${String(error)})`)
    }
    try {
      await $.command.register({ name: 'jev-report', description: 'context-harness: what the gates recorded and how Jev agreed with the rules' })
      await $.command.register({ name: 'jev-mark', description: 'context-harness: label a record, /jev-mark <id> y|n', argumentHint: '<id> y|n' })
      if (settings.instructions !== 'off') await loadFragments($)
      if (isOn) {
        await keyFor($)
        showStatus($)
      }
    } catch (error) {
      $.ui.log(`${$.plugin.name}: the judgment layer did not start (${String(error)})`)
    }
    try {
      await cleanupRecords($)
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not drop old records (${String(error)})`)
    }

    return next(e)
  })

  // E1, pinned fragments: one stable section at the end of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (settings.instructions !== 'active') return composed
    const text = pinnedSection((await loadFragments($)).list)
    if (text === undefined) return composed

    return { ...composed, sections: [...composed.sections, { id: 'context-harness:pinned', text, scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))

  // E1, conditional fragments: appended to the prompt that first meets their
  // condition, and again only once the conversation no longer carries them.
  on('prompt.submit', async ($, e, next) => {
    const mode = settings.instructions
    // The person's own prompts only: typed, remote, headless, or a plugin's sent as the person's words.
    const origin = e.origin
    const isPersons =
      origin !== undefined &&
      (origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk' || (origin.kind === 'plugin' && origin.asUser === true))
    if (mode === 'off' || e.command !== undefined || e.isMeta || !isPersons) return next(e)
    const t0 = await $.clock.now()
    const { list } = await loadFragments($)
    const conditional = list.filter(fragment => !fragment.pin)
    if (conditional.length === 0) return next(e)
    const sessionId = await $.session.id()
    // Active counts the blocks the next request carries, and those attached to
    // prompts still queued; shadow, which attaches nothing, remembers.
    const pending = pendingOf(sessionId)
    let done: Set<string>
    if (mode === 'active') {
      const shown = await attachedNow($)
      for (const name of pending) if (shown.has(name)) pending.delete(name)
      done = new Set([...shown, ...pending])
    } else {
      done = await wouldAttach($, sessionId)
    }
    const candidates = conditional.filter(fragment => !done.has(fragment.name))
    if (candidates.length === 0) return next(e)

    const rule = new Map(candidates.map(fragment => [fragment.name, keywordHit(e.text, fragment.keywords)]))
    const key = await keyFor($)
    const sent = key === undefined ? null : { request: scrub(e.text, await homeOf($)).slice(0, 600) }
    // Active asks Jev only where no keyword decided; shadow asks for every candidate, to compare.
    const toAsk = mode === 'active' ? candidates.filter(fragment => rule.get(fragment.name) !== true) : candidates

    const finish = async (asked: { result?: JevResult; probabilities: Map<string, number> }, hookMs: number) => {
      const decisions = decideFragments(candidates, rule, asked.probabilities, settings.instructionThreshold)
      const chosen = decisions.filter(d => d.attach).map(d => d.name)
      if (mode === 'shadow' && chosen.length > 0) await rememberWouldAttach($, sessionId, [...done, ...chosen])
      if (mode === 'active') for (const name of chosen) pending.add(name)
      runtime.counts.attached += chosen.length
      // A record that cannot be written does not stop the fragment.
      void recordFragments($, { sessionId, joinKey: e.turnId, mode, t0, hookMs }, decisions, sent, asked.result).catch(() => undefined)
      showStatus($)

      return chosen
    }

    if (mode === 'shadow') {
      const result = await next(e)
      const hookMs = (await $.clock.now()) - t0
      void (async () => finish(key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map() }, hookMs))().catch(() => undefined)

      return result
    }
    const asked = key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map<string, number>() }
    const chosen = await finish(asked, (await $.clock.now()) - t0)
    const blocks = list.filter(fragment => chosen.includes(fragment.name)).map(fragmentBlock)

    return blocks.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch((_, e, next) => next(e))

  // A cleared conversation carries no fragment. A summarized one is handled
  // where the compaction is answered, below.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id === undefined && settings.instructions !== 'off' && e.source === 'clear') await forgetAttached($, await $.session.id())

    return below
  }).catch((_, e, next) => next(e))

  // The fold, and beside it the shadow judgment of what it folded.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const sessionId = await $.session.id()
    // What follows a compaction that stands. A failure here leaves the
    // compaction as it is: the hook's .catch would otherwise summarize the
    // unfolded transcript.
    const after = async (folded: number, archivedIds: readonly string[], isSummarized: boolean): Promise<void> => {
      try {
        if (isSummarized) await forgetAttached($, sessionId)
        await afterCompaction($, policySettings, state, folded)
      } catch (error) {
        $.ui.log(`${$.plugin.name}: after the compaction (${String(error)})`)
      }
      if (settings.foldJev !== 'off') void judgeFold($, e.messages, new Set(archivedIds)).catch(() => undefined)
    }

    const outcome = foldTranscript(e.messages, policy)
    if (outcome.archived.length === 0) {
      const summarized = await next(e)
      if (summarized.skip === undefined) await after(0, [], true)

      return summarized
    }

    try {
      await writeArchive($, sessionId, outcome.archived)
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not keep folded results, summarizing instead (${String(error)})`)
      const summarized = await next(e)
      if (summarized.skip === undefined) await after(0, [], true)

      return summarized
    }

    const { context } = await $.session.usage()
    const tokensAfter = transcriptChars(outcome.messages) / CHARS_PER_TOKEN
    const isSummarized = tokensAfter > context.window * SUMMARIZE_ABOVE_SHARE
    const compacted = isSummarized ? await next({ ...e, messages: outcome.messages }) : { messages: outcome.messages }
    if (compacted.skip === undefined) {
      runtime.folded.results += outcome.archived.length
      runtime.folded.savedChars += outcome.savedChars
      showStatus($)
      await after(
        outcome.archived.length,
        outcome.archived.map(item => item.id),
        isSummarized,
      )
    }

    return compacted
  }).catch((_, e, next) => next(e))

  // The idle boundary: the turn has ended and the person has not written yet.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || isFoldScheduled || policySettings.foldAtPercent === 0) return done
    if (state.isJustCompacted) {
      state.isJustCompacted = false

      return done
    }

    // Without HOME nothing can be kept, so a fold would only be a summary.
    if ((await homeOf($)) === undefined) return done
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < policySettings.foldAtPercent) return done

    // A fold is worth a compaction (one full prompt-cache miss) only when it
    // removes enough of the transcript.
    const messages = await $.session.messages()
    const before = transcriptChars(messages)
    const { savedChars } = foldTranscript(messages, policy)
    if (before === 0 || (savedChars / before) * 100 < policySettings.minSavedPercent) return done

    // What this stretch of work produced goes to the canonical files before
    // its details leave the window: the agent writes them, this only asks.
    const due = dueBeforeFold(await anchorsOf($, policySettings), await since($, state))
    if (due.length > 0 && state.deferrals < MAX_DEFERRALS) {
      state.deferrals++
      await note($, dueNote(due))

      return done
    }

    isFoldScheduled = true
    $.clock.after(1000, () => {
      // /compact as the person would type it: a compaction this plugin starts
      // with $.session.compact() skips this plugin's own session.compact hook,
      // so it would summarize instead of fold. Queued until the session is idle.
      void $.command
        .run({ command: 'compact' })
        .catch(() => undefined)
        .finally(() => {
          isFoldScheduled = false
        })
    })

    return done
  })

  on('command.run', { command: 'jev-report' }, async $ => {
    const { records, labels } = await readRecords($, 20_000)
    const key = await keyFor($)
    const trust = await trustFor($)
    const fragments = settings.instructions === 'off' ? undefined : await loadFragments($)
    const header = [
      `context-harness: stop ${settings.stopGate}, tool ${settings.toolGate}, tool jev ${settings.toolJev}, instructions ${settings.instructions}, fold ${settings.foldJev}`,
      `key ${key ? `from ${key.source}` : 'none'}, provider ${trust.trust} (${trust.why})`,
      ...(fragments
        ? [`fragments: ${fragments.list.length} in ${fragments.dir} (#${fragments.hash.slice(0, 6)})${fragments.problems.length ? `; skipped: ${fragments.problems.join('; ')}` : ''}`]
        : []),
      `${records.length} records, ${labels.size} labels`,
    ]
    const reports = [
      pointReport(STOP_POINT, records, labels, settings.stopThreshold),
      pointReport(TOOL_POINT, records, labels, settings.toolThreshold),
      pointReport(INSTRUCTIONS_POINT, records, labels, settings.instructionThreshold),
      pointReport(FOLD_POINT, records, labels, 0.5),
    ]

    return { text: [...header, ...reports].join('\n\n') }
  })

  on('command.run', { command: 'jev-mark' }, async ($, e) => {
    const [id, value] = e.args.trim().split(/\s+/)
    if (id === undefined || !/^[a-z0-9]{4,20}$/.test(id) || (value !== 'y' && value !== 'n')) return { text: 'Usage: /jev-mark <id> y|n' }
    await writeLabel($, id, value === 'y', new Date(await $.clock.now()).toISOString())

    return { text: `Labeled ${id} as ${value === 'y' ? 'positive' : 'negative'}.` }
  })

  // E5: a turn that ends by announcing work. Settings Stop hooks run first.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    const mode = settings.stopGate
    if (mode === 'off' || below.block !== undefined) return below

    const t0 = await $.clock.now()
    const paragraph = lastParagraph(e.last_assistant_message)
    const skipped = stopSkipReason({
      stopHookActive: e.stop_hook_active,
      permissionMode: e.permission_mode,
      backgroundTasks: e.background_tasks?.length ?? 0,
      scheduledTasks: e.session_crons?.length ?? 0,
      agentId: e.agent_id,
      paragraph,
    })
    const base = { id: newId(t0), ts: new Date(t0).toISOString(), sessionId: e.session_id, joinKey: e.prompt_id, point: STOP_POINT, mode }
    if (skipped !== undefined) {
      void writeRecord($, { ...base, skipped, sent: null, hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)

      return below
    }

    const heuristic = announcesByRule(paragraph)
    const key = await keyFor($)
    if (key === undefined) {
      void writeRecord($, { ...base, heuristic, sent: null, error: 'no-key', hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)
      showStatus($)

      return below
    }

    const sent = { last_paragraph: scrub(paragraph, await homeOf($)) }
    const run = async (hookMs: number): Promise<number | undefined> => {
      const result = await judge($, { sessionId: e.session_id, point: STOP_POINT, cap: settings.stopCap }, key.key, sent, { stop: STOP_QUESTION }, settings.timeoutMs)
      const probability = result.ok ? probabilityOf(result.answers.stop!, 'announce') : undefined
      const isFlagged = probability !== undefined && probability >= settings.stopThreshold
      if (result.ok) counts.judged++
      else counts.failed++
      await writeRecord($, {
        ...base,
        heuristic,
        sent,
        jev: probability,
        usage: result.ok ? result.usage : undefined,
        error: errorOf(result),
        jevMs: result.ms,
        hookMs,
        decision: isFlagged ? (mode === 'active' ? 'continue' : 'would-continue') : 'stop',
      })
      showStatus($)

      return probability
    }

    if (mode === 'shadow') {
      // Judged after the hook returns: the turn ends without waiting for Jev.
      const hookMs = (await $.clock.now()) - t0
      void run(hookMs).catch(() => undefined)

      return below
    }
    const probability = await run((await $.clock.now()) - t0)

    return probability !== undefined && probability >= settings.stopThreshold ? { ...below, block: STOP_MESSAGE } : below
  }).catch((_, e, next) => next(e))

  // E2: the floor (restricted paths and secret-printing commands, no Jev)
  // and, for what it lets through in an external session, Jev's judgment.
  // Registered before the plugin's own tools, so it sees their calls too.
  on('tool.call', async ($, e, next) => {
    const mode = settings.toolGate
    const jevMode = settings.toolJev
    if (mode === 'off' && jevMode === 'off') return next(e)

    const t0 = await $.clock.now()
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
    const home = (await homeOf($)) ?? '/'
    const cwd = await $.session.cwd()
    const candidates = [...new Set([...pathFieldValues(input), ...(command === undefined ? [] : pathCandidates(command))])].slice(0, 40)
    const protectedRoots = [
      $.plugin.root,
      stateRoot(home),
      legacyArchiveRoot(home),
      ...(settings.instructions === 'off' ? [] : [await fragmentsDirOf($)]),
    ].filter(root => root !== '')
    // Folded originals hold whatever the tools returned, secrets included.
    const archiveRoots = [`${stateRoot(home)}/archive`, legacyArchiveRoot(home)]
    const isWriting = canWrite(tool, command)

    let verdict: FloorVerdict | undefined
    for (const candidate of candidates) {
      const lexical = normalizePath(candidate, home, cwd)
      let real = lexical
      try {
        real = (await $.fs.stat(lexical, { resolve: true })).realPath ?? lexical
      } catch {
        // A path that does not exist yet is judged by its spelling.
      }
      for (const path of new Set([lexical, real])) {
        const self = isWriting ? selfProtectReason(path, protectedRoots) : undefined
        const restricted = restrictedReason(path, home) ?? (isUnder(path, archiveRoots) ? 'folded originals' : undefined)
        // A link names both what was asked for and what it leads to.
        const shown = (path === lexical ? lexical : `${lexical} -> ${real}`).split(home).join('~')
        if (self !== undefined) verdict = { kind: 'self', reason: self, path: shown }
        else if (restricted !== undefined) verdict ??= { kind: 'restricted', reason: restricted, path: shown }
      }
      if (verdict?.kind === 'self') break
    }
    const dump = command === undefined ? undefined : secretDumpReason(command)
    if (verdict === undefined && dump !== undefined) verdict = { kind: 'secret-dump', reason: dump }
    // A call the floor names never goes to Jev, whatever the floor's own mode.
    if (verdict === undefined) return judgeTool($, e, next, { tool, command, candidates, home, cwd, t0 })
    if (mode === 'off') return next(e)

    const trust = await trustFor($)
    const isRefused = verdict.kind === 'self' || trust.trust === 'external'
    counts.floor++
    const record: ShadowRecord = {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId: await $.session.id(),
      joinKey: e.tool_use_id,
      point: TOOL_POINT,
      mode,
      sent: null,
      hookMs: (await $.clock.now()) - t0,
      decision: isRefused ? (mode === 'active' ? 'deny' : 'would-deny') : 'allow',
      facts: { tool, kind: verdict.kind, reason: verdict.reason, trust: trust.trust, why: trust.why },
    }
    void writeRecord($, record).catch(() => undefined)
    showStatus($)
    if (mode === 'active' && isRefused) return { deny: denyMessage(verdict, trust.trust) }

    return next(e)
  }).catch((_, e, next) =>
    // The floor fails closed when active: a guard that broke refuses rather than lets through.
    next.called || settings.toolGate !== 'active' ? next(e) : { deny: 'context-harness: the tool guard failed, so this call was refused.' },
  )

  on('tool.call', { tool: 'mcp__context-harness__read_coordinate' }, async ($, e) => {
    const input = e as unknown as { id?: unknown; offset?: unknown; limit?: unknown }
    const id = typeof input.id === 'string' ? input.id : ''
    const item = await readArchived($, await $.session.id(), id)

    // A plugin tool's result reaches the model as its content: a string here.
    if (item === undefined) return { isError: true, result: `No folded result is kept under "${id}".` }

    // A folded original goes through the gate as the call that made it would have.
    if (settings.toolGate !== 'off') {
      const trust = await trustFor($)
      let reason: string | undefined
      if (trust.trust === 'external') {
        const home = (await homeOf($)) ?? '/'
        const cwd = await $.session.cwd()
        // A path that still exists is judged by what it leads to as well.
        const real: string[] = []
        for (const path of callPaths(item.input, home, cwd)) {
          try {
            const resolved = (await $.fs.stat(path, { resolve: true })).realPath
            if (resolved !== undefined) real.push(resolved)
          } catch {
            // Gone since: judged by its spelling.
          }
        }
        reason = archivedReason(item.input, home, cwd, real)
      }
      if (reason !== undefined) {
        const t0 = await $.clock.now()
        counts.floor++
        void writeRecord($, {
          id: newId(t0),
          ts: new Date(t0).toISOString(),
          sessionId: await $.session.id(),
          joinKey: id,
          point: TOOL_POINT,
          mode: settings.toolGate,
          sent: null,
          hookMs: 0,
          decision: settings.toolGate === 'active' ? 'deny' : 'would-deny',
          facts: { tool: 'read_coordinate', kind: 'archived', reason, trust: trust.trust, why: trust.why },
        }).catch(() => undefined)
        showStatus($)
        if (settings.toolGate === 'active') return { isError: true, result: denyMessage({ kind: 'restricted', reason }, trust.trust) }
      }
    }

    const offset = typeof input.offset === 'number' ? input.offset : 1
    const limit = typeof input.limit === 'number' ? input.limit : READ_LIMIT
    const part = sliceLines(item.text, offset, limit)
    const head = `${item.tool} ${JSON.stringify(item.input)} — lines ${part.from}-${part.to} of ${part.total}`

    return { isReadOnly: true, result: `${head}\n${part.body}` }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not read the folded result.` }))

  on('tool.call', { tool: 'mcp__context-harness__policy_report' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const messages = await $.session.messages()
    const hasCandidate = SETTING_KEYS.some(key => input[key] !== undefined)
    const candidate = settingsFrom(input, policySettings)
    const report = {
      current: { settings: policySettings, ...reportFor(messages, policySettings) },
      ...(hasCandidate ? { candidate: { settings: candidate, folds: reportFor(messages, candidate).folds } } : {}),
      anchors: await anchorsOf($, policySettings),
      defaults: DEFAULT_SETTINGS,
    }

    return { isReadOnly: true, result: JSON.stringify(report, null, 2) }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not measure this session.` }))

  // Only the fold policy's own values: never a gate, a Jev mode or the key.
  on('tool.call', { tool: 'mcp__context-harness__set_policy' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const wanted = settingsFrom(input, policySettings)
    const lines: string[] = []

    for (const key of SETTING_KEYS) {
      if (input[key] === undefined) continue
      const value: PolicySettings[typeof key] = wanted[key]
      const stored = Array.isArray(value) ? value.join(',') : value
      const set = await $.config.set({ key: `${$.plugin.name}.${key}`, value: stored })
      lines.push(set.deny === undefined ? `${key} = ${JSON.stringify(stored)}` : `${key} refused: ${set.deny}`)
    }

    return { result: lines.length === 0 ? 'No policy value was given.' : lines.join('\n') }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not set the policy.` }))
}
