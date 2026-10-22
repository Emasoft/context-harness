// Around a compaction: the canonical files the model is pointed back at, and
// the shadow judgment of what was folded.
import type { EngineInterface, SessionMessage } from 'claude-code'
import { anchorNote, dueBeforeFold, type AnchorFile, type PolicySettings } from './fold'
import { FOLD_POINT, currentRequest, foldCandidates, foldQuestion } from './fold-judge'
import { probabilityOf } from './jev'
import { errorOf, judge, keyFor } from './jev-call'
import { scrub } from './scrub'
import { runtime, newId, settingsOf } from './state'
import { showStatus } from './status'
import { homeOf, writeRecord } from './storage'

/** What the module remembers between compactions in this session. */
export type Continuity = {
  // When the canonical files were last required to be current: the last
  // compaction. Unset until the first one, which counts from the session start.
  lastCompactAt?: number
  deferrals: number
  // The turn the compaction itself ends can still read the transcript as it
  // was before it: skip the first idle boundary after one.
  isJustCompacted: boolean
}

/** The project's canonical files that exist now; the episode folder by its newest file. */
export async function anchorsOf($: EngineInterface, settings: PolicySettings): Promise<AnchorFile[]> {
  const found: AnchorFile[] = []
  for (const [role, path] of [['intent', settings.intentFile], ['phase', settings.phaseFile]] as const) {
    if (path === '' || !(await $.fs.exists(path))) continue
    const stat = await $.fs.stat(path)
    if (stat.kind === 'file') found.push({ role, path, mtimeMs: stat.mtimeMs })
  }
  if (settings.episodeDir !== '' && (await $.fs.exists(settings.episodeDir))) {
    const entries = await $.fs.list(settings.episodeDir)
    const newest = entries.filter(entry => entry.kind === 'file').reduce((ms, entry) => Math.max(ms, entry.mtimeMs), 0)
    found.push({ role: 'episodes', path: settings.episodeDir, mtimeMs: newest })
  }

  return found
}

export async function note($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

export async function since($: EngineInterface, state: Continuity): Promise<number> {
  return state.lastCompactAt ?? (await $.session.usage()).startedAt
}

/** After a compaction stands: record it, then point the model at the canonical files. */
export async function afterCompaction($: EngineInterface, settings: PolicySettings, state: Continuity, folded: number): Promise<void> {
  const files = await anchorsOf($, settings)
  const due = dueBeforeFold(files, await since($, state))
  state.lastCompactAt = await $.clock.now()
  state.deferrals = 0
  state.isJustCompacted = true
  if (files.length === 0 && folded === 0) return

  // The compacted conversation is installed once the hook returns.
  $.clock.after(1000, () => {
    void note($, anchorNote(files, folded, due)).catch(() => undefined)
  })
}

/**
 * Shadow judgment of fold relevance over the transcript as it stood before
 * the compaction. `archived` holds the ids this compaction actually folded:
 * each record's rule verdict is what the fold did, not a guess at it.
 */
export async function judgeFold($: EngineInterface, messages: readonly SessionMessage[], archived: ReadonlySet<string>): Promise<void> {
  const settings = settingsOf()
  const policy = runtime.policy
  const key = await keyFor($)
  const request = currentRequest(messages)
  const home = await homeOf($)
  if (key === undefined || request === undefined || policy === undefined || home === undefined) return
  const cwd = await $.session.cwd()
  const sessionId = await $.session.id()
  const candidates = foldCandidates(messages, policy, home, cwd, 48)
  const sent = { current_request: scrub(request, home).slice(0, 400) }
  for (let start = 0; start < candidates.length; start += 24) {
    const batch = candidates.slice(start, start + 24)
    const t0 = await $.clock.now()
    const questions = Object.fromEntries(batch.map((candidate, i) => [`r${i}`, foldQuestion(scrub(candidate.call, home))]))
    const result = await judge($, { sessionId, point: FOLD_POINT, cap: settings.foldCap }, key.key, sent, questions, settings.timeoutMs * 2)
    for (const [i, candidate] of batch.entries()) {
      const answer = result.ok ? result.answers[`r${i}`] : undefined
      const needed = answer === undefined ? undefined : probabilityOf(answer, 'needed')
      if (needed !== undefined) runtime.counts.foldJudged++
      await writeRecord($, {
        id: newId(t0),
        ts: new Date(t0).toISOString(),
        sessionId,
        joinKey: candidate.id,
        point: FOLD_POINT,
        mode: 'shadow',
        // Positive means "fold": what the fold did, and Jev's probability that the output is done with.
        heuristic: archived.has(candidate.id),
        sent: { ...sent, call: scrub(candidate.call, home) },
        jev: needed === undefined ? undefined : 1 - needed,
        usage: result.ok && i === 0 ? result.usage : undefined,
        error: errorOf(result),
        jevMs: result.ms,
        hookMs: 0,
        facts: { tool: candidate.tool, chars: String(candidate.chars), turnsAgo: String(candidate.turnsAgo), policyFolds: String(candidate.ruleFolds) },
      })
    }
  }
  showStatus($)
}
