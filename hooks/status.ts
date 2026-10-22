// One status line per plugin: the fold's part and the judgment layer's part,
// each worded as it was when they were separate plugins, joined by " | ".
import type { EngineInterface } from 'claude-code'
import type { HarnessSettings } from './settings'
import { usesJev } from './settings'
import { runtime, type Counts } from './state'

/** The fold's part; undefined before the first fold. */
export function foldStatus(folded: { results: number; savedChars: number }): string | undefined {
  return folded.results === 0 ? undefined : `folded ${folded.results} · −${Math.round(folded.savedChars / 1000)}k chars`
}

/** The judgment layer's part; undefined while everything it shows is off. */
export function jevStatus(
  settings: HarnessSettings,
  counts: Counts,
  hasNoKey: boolean,
  fragments: { list: readonly unknown[]; hash: string } | undefined,
): string | undefined {
  const isJev = usesJev(settings)
  if (!isJev && settings.toolGate === 'off') return undefined
  if (isJev && hasNoKey) return 'jev: no key'
  const parts = ['jev']
  if (settings.stopGate !== 'off') parts.push(`stop ${settings.stopGate} ${counts.judged} judged${counts.failed ? `, ${counts.failed} failed` : ''}`)
  if (settings.toolGate !== 'off') parts.push(`tool ${settings.toolGate} ${counts.floor} hits`)
  if (settings.toolJev !== 'off') parts.push(`tool jev ${settings.toolJev} ${counts.toolJudged} judged`)
  if (settings.instructions !== 'off') {
    parts.push(`instr ${settings.instructions} ${fragments ? `${fragments.list.length} #${fragments.hash.slice(0, 6)}` : '-'}, ${counts.attached} attached`)
  }
  if (settings.foldJev !== 'off') parts.push(`fold ${settings.foldJev} ${counts.foldJudged} judged`)

  return parts.join(' · ')
}

export function statusLine(parts: readonly (string | undefined)[]): string | undefined {
  const shown = parts.filter((part): part is string => part !== undefined)

  return shown.length === 0 ? undefined : shown.join(' | ')
}

export function showStatus($: EngineInterface): void {
  const settings = runtime.settings
  const line = statusLine([
    foldStatus(runtime.folded),
    settings === undefined ? undefined : jevStatus(settings, runtime.counts, runtime.key === null, runtime.fragments),
  ])
  if (line !== undefined) $.ui.status(line)
}
