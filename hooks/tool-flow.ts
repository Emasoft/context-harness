// Jev's judgment of a tool call the floor let through.
import type { Args, EngineInterface, EventResult, Next } from 'claude-code'
import { errorOf, judge, keyFor, trustFor } from './jev-call'
import { scrub } from './scrub'
import { newId, runtime, settingsOf, toolVerdicts } from './state'
import { showStatus } from './status'
import { writeRecord } from './storage'
import { TOOL_POINT, TOOL_QUESTION, normalizePath, riskOf, targetOfCommand, targetOfPath } from './tool-gate'

export type ToolFacts = { tool: string; command?: string; candidates: readonly string[]; home: string; cwd: string; t0: number }

/**
 * Only in an external session, with a path or command shown in place of the
 * file's contents. Shadow runs the tool first and judges afterwards; active
 * judges first.
 */
export async function judgeTool(
  $: EngineInterface,
  e: Args<'tool.call'>,
  next: Next<'tool.call'>,
  facts: ToolFacts,
): Promise<EventResult<'tool.call'>> {
  const settings = settingsOf()
  const mode = settings.toolJev
  if (mode === 'off') return next(e)
  const trust = await trustFor($)
  if (trust.trust !== 'external') return next(e)
  const key = await keyFor($)
  const first = facts.candidates[0]
  const shown =
    facts.command !== undefined
      ? targetOfCommand(facts.command, facts.home, facts.cwd)
      : first === undefined
        ? undefined
        : targetOfPath(normalizePath(first, facts.home, facts.cwd), facts.home, facts.cwd)
  if (key === undefined || shown === undefined) return next(e)

  const sessionId = await $.session.id()
  const sent = { tool: facts.tool, target: scrub(shown, facts.home) }
  const cacheKey = `${sessionId}\n${sent.tool}\n${sent.target}`
  const hookMs = (await $.clock.now()) - facts.t0
  const base = { id: newId(facts.t0), ts: new Date(facts.t0).toISOString(), sessionId, joinKey: e.tool_use_id, point: TOOL_POINT, mode }

  const verdictOf = async (): Promise<{ risk: number; choice: string } | undefined> => {
    const known = toolVerdicts.get(cacheKey)
    if (known !== undefined) return known
    const result = await judge($, { sessionId, point: 'tool-jev', cap: settings.toolCap }, key.key, sent, { data: TOOL_QUESTION }, settings.timeoutMs)
    const answer = result.ok ? result.answers.data : undefined
    const verdict = answer === undefined ? undefined : { risk: riskOf(answer.probabilities), choice: String(answer.value) }
    if (verdict !== undefined) {
      toolVerdicts.set(cacheKey, verdict)
      runtime.counts.toolJudged++
    }
    await writeRecord($, {
      ...base,
      heuristic: false,
      sent,
      jev: verdict?.risk,
      usage: result.ok ? result.usage : undefined,
      error: errorOf(result),
      jevMs: result.ms,
      // Active holds the call while Jev answers; shadow judges after it ran.
      hookMs: mode === 'active' ? hookMs + result.ms : hookMs,
      decision: verdict === undefined ? 'allow' : verdict.risk >= settings.toolThreshold ? (mode === 'active' ? 'deny' : 'would-deny') : 'allow',
      facts: { tool: facts.tool, kind: 'jev', class: verdict?.choice ?? '-', trust: trust.trust, why: trust.why },
    })
    showStatus($)

    return verdict
  }

  if (mode === 'shadow') {
    const result = await next(e)
    void verdictOf().catch(() => undefined)

    return result
  }
  const verdict = await verdictOf()
  if (verdict !== undefined && verdict.risk >= settings.toolThreshold) {
    return {
      deny:
        `context-harness: Jev judged ${sent.target} as ${verdict.choice} data (${verdict.risk.toFixed(2)}), and this session is ` +
        `served by a provider other than Anthropic (${trust.why}). Do it from a first-party session instead.`,
    }
  }

  return next(e)
}
