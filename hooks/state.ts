// What the module keeps between hooks. Per process: a reload (a changed
// setting) starts it over, which costs a mkdir, a lookup and the counters.
import type { PolicySettings } from './fold'
import type { Fragment } from './instructions'
import type { JevKey } from './key'
import type { HarnessSettings } from './settings'
import type { Trust } from './tool-gate'

export type Counts = { judged: number; failed: number; floor: number; toolJudged: number; attached: number; foldJudged: number }

export const runtime: {
  settings?: HarnessSettings
  policy?: PolicySettings
  counts: Counts
  /** What the fold removed in this process: results and characters. */
  folded: { results: number; savedChars: number }
  key?: JevKey | null
  trust?: { trust: Trust; why: string }
  fragments?: { list: Fragment[]; hash: string; dir: string; problems: string[] }
  /** Per session, fragments attached here that the conversation may not show yet. */
  pending: Map<string, Set<string>>
} = { counts: { judged: 0, failed: 0, floor: 0, toolJudged: 0, attached: 0, foldJudged: 0 }, folded: { results: 0, savedChars: 0 }, pending: new Map() }

// Folders already made private in this process.
export const madeDirs = new Set<string>()

// Tool targets already judged in this process: one Jev call per target and session.
export const toolVerdicts = new Map<string, { risk: number; choice: string }>()

let sequence = 0

export function newId(now: number): string {
  return `${Math.floor(now).toString(36)}${(sequence++ % 1296).toString(36).padStart(2, '0')}`
}

export function startRuntime(settings: HarnessSettings, policy: PolicySettings): void {
  runtime.settings = settings
  runtime.policy = policy
  runtime.key = undefined
  runtime.trust = undefined
  runtime.fragments = undefined
  runtime.counts = { judged: 0, failed: 0, floor: 0, toolJudged: 0, attached: 0, foldJudged: 0 }
  runtime.folded = { results: 0, savedChars: 0 }
}

export function settingsOf(): HarnessSettings {
  if (runtime.settings === undefined) throw new Error('context-harness: settings read before register')

  return runtime.settings
}
