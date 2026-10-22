// Conditional instructions: the fragment folder, what is attached already,
// Jev's reading of each condition, and the records of what was decided.
import type { EngineInterface } from 'claude-code'
import { INSTRUCTIONS_POINT, MAX_FRAGMENTS, attachedNames, conditionQuestion, fragmentsHash, isFragment, parseFragment, type Fragment } from './instructions'
import { probabilityOf, type JevResult } from './jev'
import { errorOf, judge } from './jev-call'
import { newId, runtime, settingsOf } from './state'
import { homeOf, writeRecord } from './storage'

export async function fragmentsDirOf($: EngineInterface): Promise<string> {
  const dir = settingsOf().fragmentsDir.trim()
  if (dir === '~' || dir.startsWith('~/')) {
    const home = await homeOf($)

    return home === undefined ? '' : `${home}${dir.slice(1)}`
  }

  return dir
}

/** Reads the fragment folder once; a changed set of fragments is announced. */
export async function loadFragments($: EngineInterface): Promise<{ list: Fragment[]; hash: string; dir: string; problems: string[] }> {
  if (runtime.fragments !== undefined) return runtime.fragments
  const dir = await fragmentsDirOf($)
  const list: Fragment[] = []
  const problems: string[] = []
  if (dir !== '' && (await $.fs.exists(dir))) {
    const files = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
    for (const file of files) {
      if (list.length >= MAX_FRAGMENTS) {
        problems.push(`${file}: over ${MAX_FRAGMENTS} fragments`)
        continue
      }
      const parsed = parseFragment(file, await $.fs.read(`${dir}/${file}`))
      if (isFragment(parsed)) list.push(parsed)
      else problems.push(`${parsed.file}: ${parsed.reason}`)
    }
  }
  const hash = fragmentsHash(list)
  const seen = await $.store.get('fragments-hash')
  if (seen !== undefined && seen !== hash) $.ui.toast(`context-harness: instruction fragments changed (#${hash.slice(0, 6)}, ${list.length} in ${dir})`)
  await $.store.set('fragments-hash', hash)
  runtime.fragments = { list, hash, dir, problems }

  return runtime.fragments
}

/** The fragments the next request still carries: counted in the conversation itself. */
export async function attachedNow($: EngineInterface): Promise<Set<string>> {
  return attachedNames(await $.session.messages({ as: 'api' }))
}

/** What shadow would have attached in this session, until a compaction. */
export async function wouldAttach($: EngineInterface, sessionId: string): Promise<Set<string>> {
  const value = await $.store.get(`would-attach:${sessionId}`)

  return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
}

export async function rememberWouldAttach($: EngineInterface, sessionId: string, names: readonly string[]): Promise<void> {
  await $.store.set(`would-attach:${sessionId}`, names)
}

/**
 * Fragments attached in this process that the conversation may not show yet:
 * a prompt typed while a turn runs is judged before the one queued ahead of
 * it is stored. Each leaves this set once the conversation shows it.
 */
export function pendingOf(sessionId: string): Set<string> {
  let pending = runtime.pending.get(sessionId)
  if (pending === undefined) {
    pending = new Set()
    runtime.pending.set(sessionId, pending)
  }

  return pending
}

/** After a compaction the engine summarized, or a /clear: nothing attached before is there any more. */
export async function forgetAttached($: EngineInterface, sessionId: string): Promise<void> {
  runtime.pending.delete(sessionId)
  if (settingsOf().instructions === 'shadow') await rememberWouldAttach($, sessionId, [])
}

/** What a fragment decision is recorded as, one record per fragment. */
export async function recordFragments(
  $: EngineInterface,
  base: { sessionId: string; joinKey?: string; mode: 'shadow' | 'active'; t0: number; hookMs: number },
  decisions: readonly { name: string; rule: boolean; jev?: number; attach: boolean }[],
  sent: Record<string, unknown> | null,
  result: JevResult | undefined,
): Promise<void> {
  for (const decision of decisions) {
    await writeRecord($, {
      id: newId(base.t0),
      ts: new Date(base.t0).toISOString(),
      sessionId: base.sessionId,
      joinKey: base.joinKey,
      point: INSTRUCTIONS_POINT,
      mode: base.mode,
      heuristic: decision.rule,
      sent,
      jev: decision.jev,
      usage: result?.ok ? result.usage : undefined,
      error: errorOf(result),
      jevMs: result?.ms,
      hookMs: base.hookMs,
      decision: decision.attach ? (base.mode === 'active' ? 'attach' : 'would-attach') : 'skip',
      facts: { fragment: decision.name },
    })
  }
}

/** Jev's probability that each candidate's condition holds for the prompt, keyed by fragment name. */
export async function askConditions(
  $: EngineInterface,
  sessionId: string,
  key: string,
  sent: Record<string, unknown>,
  candidates: readonly Fragment[],
): Promise<{ result?: JevResult; probabilities: Map<string, number> }> {
  const probabilities = new Map<string, number>()
  if (candidates.length === 0) return { probabilities }
  const settings = settingsOf()
  const questions = Object.fromEntries(candidates.map(fragment => [fragment.name, conditionQuestion(fragment.when)]))
  const result = await judge($, { sessionId, point: INSTRUCTIONS_POINT, cap: settings.instructionCap }, key, sent, questions, settings.timeoutMs)
  if (result.ok) {
    for (const fragment of candidates) {
      const answer = result.answers[fragment.name]
      const p = answer === undefined ? undefined : probabilityOf(answer, 'applies')
      if (p !== undefined) probabilities.set(fragment.name, p)
    }
  }

  return { result, probabilities }
}
