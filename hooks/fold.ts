import type { SessionMessage, ToolResultSummary, ToolUseSummary } from 'claude-code'

// A folded tool result is one line that starts with this mark and names the
// call id read_coordinate answers for. A later compaction leaves it as it is.
export const FOLD_MARK = '[folded '

// The notes this plugin appends to the conversation start with one of these
// (the second from before it was renamed); they are not the person's prompts.
export const NOTE_MARKS: readonly string[] = ['[context-harness]', '[context-fold]']

/** One completed tool result, as the folding policy sees it. */
export type FoldCandidate = {
  tool: string
  input: Readonly<Record<string, unknown>>
  text: string
  isError: boolean
  /** How many prompts came after this result; 0 is the turn still in view. */
  turnsAgo: number
}

export type FoldPolicy = (candidate: FoldCandidate) => boolean

/** What leaves the window: kept outside it so read_coordinate can return it. */
export type Archived = {
  id: string
  tool: string
  input: Record<string, unknown>
  text: string
  isError: boolean
}

export type FoldOutcome = {
  messages: SessionMessage[]
  archived: Archived[]
  savedChars: number
}

/** The policy's values: the plugin's userConfig fields, set in /config or by set_policy. */
export type PolicySettings = {
  /** Results from this many most recent turns stay verbatim. */
  keepRecentTurns: number
  /** Below this a result saves little and would cost a read_coordinate round trip. */
  minFoldChars: number
  /** An error shorter than this stays: it stops the model repeating the mistake. */
  keepErrorsUnder: number
  /** Tools whose results hold current state or the person's answers. */
  keepTools: readonly string[]
  /** Fold by itself at an idle boundary once the window is this full; 0 is off. */
  foldAtPercent: number
  /** ...and only when folding removes at least this share of the transcript. */
  minSavedPercent: number
  /** The agent's reading of what the person wants; '' is none. Used only while it exists. */
  intentFile: string
  /** The status board the person reads; '' is none. Used only while it exists. */
  phaseFile: string
  /** The folder of dated episode logs; '' is none. Used only while it exists. */
  episodeDir: string
}

export const DEFAULT_SETTINGS: PolicySettings = {
  keepRecentTurns: 2,
  minFoldChars: 1000,
  keepErrorsUnder: 2000,
  keepTools: ['TodoWrite', 'AskUserQuestion', 'ExitPlanMode'],
  foldAtPercent: 60,
  minSavedPercent: 20,
  intentFile: 'INTENT.md',
  phaseFile: 'PHASE.md',
  episodeDir: 'sessions',
}

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof PolicySettings)[]

const asCount = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : fallback

const asTools = (value: unknown, fallback: readonly string[]): readonly string[] => {
  if (typeof value === 'string') return value.split(',').map(tool => tool.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.filter((tool): tool is string => typeof tool === 'string')

  return fallback
}

const asPath = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.trim() : fallback)

/** Settings from plugin options or a tool's input; a missing or invalid field keeps `base`. */
export function settingsFrom(values: Readonly<Record<string, unknown>>, base: PolicySettings = DEFAULT_SETTINGS): PolicySettings {
  return {
    keepRecentTurns: asCount(values.keepRecentTurns, base.keepRecentTurns, 1000),
    minFoldChars: asCount(values.minFoldChars, base.minFoldChars, 10_000_000),
    keepErrorsUnder: asCount(values.keepErrorsUnder, base.keepErrorsUnder, 10_000_000),
    keepTools: asTools(values.keepTools, base.keepTools),
    foldAtPercent: asCount(values.foldAtPercent, base.foldAtPercent, 100),
    minSavedPercent: asCount(values.minSavedPercent, base.minSavedPercent, 100),
    intentFile: asPath(values.intentFile, base.intentFile),
    phaseFile: asPath(values.phaseFile, base.phaseFile),
    episodeDir: asPath(values.episodeDir, base.episodeDir),
  }
}

/**
 * A canonical file or folder the person's project keeps, as found on disk;
 * for the episode folder, `mtimeMs` is its newest file's.
 */
export type AnchorFile = { role: 'intent' | 'phase' | 'episodes'; path: string; mtimeMs: number }

const ROLE_NAMES = { intent: "the person's intent", phase: 'the status board', episodes: 'the episode log' } as const

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z')

/**
 * What must be brought up to date before a fold: the status board and the
 * episode log, each when last written before `sinceMs` (the last compaction,
 * or the session's start). The intent changes only when the person's does.
 */
export function dueBeforeFold(files: readonly AnchorFile[], sinceMs: number): AnchorFile[] {
  return files.filter(file => file.role !== 'intent' && file.mtimeMs < sinceMs)
}

/**
 * The note appended after a compaction: where the canonical files are and
 * when they were last written. It points at them and copies nothing, so they
 * stay the one place each fact is kept.
 */
export function anchorNote(files: readonly AnchorFile[], folded: number, due: readonly AnchorFile[]): string {
  const lines = [
    folded > 0
      ? `[context-harness] This conversation was just compacted; ${folded} tool results were folded into one-line pointers (read_coordinate returns the originals).`
      : '[context-harness] This conversation was just compacted.',
  ]
  const reread = files.filter(file => file.role !== 'episodes')
  if (reread.length > 0) {
    lines.push('Before continuing, re-read the canonical files, in this order:')
    for (const file of reread) lines.push(`- ${file.path}: ${ROLE_NAMES[file.role]}, last written ${stamp(file.mtimeMs)}`)
    lines.push('A summary or a folded line is never the source; these files are.')
  }
  const episodes = files.find(file => file.role === 'episodes')
  if (episodes !== undefined) lines.push(`Earlier episodes are in ${episodes.path}/ (newest written ${stamp(episodes.mtimeMs)}); read them only when you need one.`)
  if (due.length > 0) {
    lines.push(
      `Not written since the previous compaction (or the session's start): ${due.map(file => file.path).join(', ')}. ` +
        'Run the context-harness:consolidate skill when you next can.',
    )
  }

  return lines.join('\n')
}

/** The note that defers a fold until the status board and the episode log are current. */
export function dueNote(due: readonly AnchorFile[]): string {
  const items = due.map(file => `${file.path} (${ROLE_NAMES[file.role]}, last written ${stamp(file.mtimeMs)})`)

  return (
    '[context-harness] Before this conversation is folded, consolidate what this stretch of work produced. ' +
    `Not written since the last compaction (or, before the first, the session's start): ${items.join('; ')}. ` +
    'Run the context-harness:consolidate skill now; context-harness folds the conversation once they are current.'
  )
}

/**
 * The policy that decides whether one completed tool result leaves the
 * window as a pointer.
 *
 * The pointer keeps the tool, its target and the call id, so the model can
 * still see that the call happened and fetch the original with
 * read_coordinate. What it loses until then is the content itself.
 */
export function makePolicy(settings: PolicySettings): FoldPolicy {
  const keepTools = new Set(settings.keepTools)

  return candidate => {
    if (candidate.turnsAgo < settings.keepRecentTurns) return false
    if (keepTools.has(candidate.tool)) return false
    if (candidate.isError && candidate.text.length < settings.keepErrorsUnder) return false

    return candidate.text.length >= settings.minFoldChars
  }
}

export const shouldFold: FoldPolicy = makePolicy(DEFAULT_SETTINGS)

const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'command', 'description'] as const
// A path keeps its end, where the file's name is; anything else keeps its start.
const PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'notebook_path', 'path'])

const oneLine = (text: string, max: number, keep: 'head' | 'tail'): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat

  return keep === 'tail' ? `…${flat.slice(-(max - 1))}` : `${flat.slice(0, max - 1)}…`
}

export function pointerFor(id: string, candidate: FoldCandidate): string {
  const key = TARGET_KEYS.find(k => typeof candidate.input[k] === 'string')
  const target = key === undefined ? '' : oneLine(String(candidate.input[key]), 60, PATH_KEYS.has(key) ? 'tail' : 'head')
  const lines = candidate.text.split('\n').length
  const parts = [candidate.tool, target, `${lines} lines`, candidate.isError ? 'error' : '']

  return `${FOLD_MARK}${parts.filter(Boolean).join(' · ')} — read_coordinate("${id}")]`
}

// A turn boundary: a user message with text and no tool results. Reminders
// the engine injects as user text count too, so the recent window can span
// fewer of the person's own prompts than keepRecentTurns says.
const isPrompt = (message: SessionMessage): boolean =>
  message.role === 'user' && (message.toolResults ?? []).length === 0 && message.text.trim() !== ''

const toolUses = (messages: readonly SessionMessage[]): Map<string, ToolUseSummary> => {
  const uses = new Map<string, ToolUseSummary>()
  for (const message of messages) for (const use of message.toolUses) uses.set(use.tool_use_id, use)

  return uses
}

/** For each message, how many prompts come after it. */
export function turnsAgoOf(messages: readonly SessionMessage[]): number[] {
  const turnsAgoAt: number[] = []
  let prompts = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    turnsAgoAt[i] = prompts
    if (isPrompt(messages[i]!)) prompts++
  }

  return turnsAgoAt
}

/** One completed tool result not yet folded, and what the fold would do with it. */
export type FoldableResult = FoldCandidate & {
  id: string
  /** Where it sits: the user message's index and the result's index within it. */
  at: [message: number, result: number]
  pointer: string
  /** The policy picks it and its pointer is shorter than the text. */
  fold: boolean
}

/**
 * Every tool result in the user messages that is not folded yet, with the
 * fold's decision. The fold and its judgment both read this, so they agree on
 * what was eligible and what was folded.
 */
export function foldableResults(messages: readonly SessionMessage[], policy: FoldPolicy): FoldableResult[] {
  const uses = toolUses(messages)
  const turnsAgoAt = turnsAgoOf(messages)
  const found: FoldableResult[] = []

  messages.forEach((message, i) => {
    if (message.role !== 'user') return
    ;(message.toolResults ?? []).forEach((result, j) => {
      if (result.text.startsWith(FOLD_MARK)) return

      const use = uses.get(result.tool_use_id)
      const candidate: FoldCandidate = {
        tool: use?.tool ?? 'unknown',
        input: use?.input ?? {},
        text: result.text,
        isError: result.isError,
        turnsAgo: turnsAgoAt[i] ?? 0,
      }
      const pointer = pointerFor(result.tool_use_id, candidate)
      // A pointer longer than what it replaces saves nothing.
      found.push({ ...candidate, id: result.tool_use_id, at: [i, j], pointer, fold: policy(candidate) && pointer.length < result.text.length })
    })
  })

  return found
}

/**
 * Replaces each tool result the policy picks with a one-line pointer.
 *
 * Messages it does not change keep the engine's handle and stay whole. A user
 * message with a folded result is rebuilt from its text and tool results, so
 * it carries no handle and the engine builds it anew.
 */
export function foldTranscript(messages: readonly SessionMessage[], policy: FoldPolicy): FoldOutcome {
  const chosen = new Map(
    foldableResults(messages, policy)
      .filter(result => result.fold)
      .map(result => [`${result.at[0]}:${result.at[1]}`, result]),
  )

  const archived: Archived[] = []
  let savedChars = 0

  const folded = messages.map((message, i): SessionMessage => {
    const results = message.toolResults ?? []
    let isChanged = false
    const nextResults = results.map((result, j): ToolResultSummary => {
      const pick = chosen.get(`${i}:${j}`)
      if (pick === undefined) return result

      isChanged = true
      savedChars += result.text.length - pick.pointer.length
      archived.push({ id: pick.id, tool: pick.tool, input: { ...pick.input }, text: pick.text, isError: pick.isError })

      return { tool_use_id: result.tool_use_id, text: pick.pointer, isError: result.isError }
    })

    return isChanged ? { role: 'user', text: message.text, toolUses: [], toolResults: nextResults } : message
  })

  return { messages: folded, archived, savedChars }
}

/** A rough size of a transcript in characters: text, tool inputs and results. */
export function transcriptChars(messages: readonly SessionMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.text.length
    for (const use of message.toolUses) chars += JSON.stringify(use.input).length
    for (const result of message.toolResults ?? []) chars += result.text.length
  }

  return chars
}

/** What policy_report measures in a transcript, and what a policy would fold there now. */
export type PolicyReport = {
  results: number
  resultChars: number
  transcriptChars: number
  /** Tools by the characters their results hold, largest first, at most ten. */
  byTool: { tool: string; results: number; chars: number }[]
  /** For each size, the share of results and of result characters at or above it. */
  bySize: { atLeast: number; resultsPercent: number; charsPercent: number }[]
  /** For each count of recent turns, the share of result characters they hold. */
  inRecentTurns: { turns: number; charsPercent: number }[]
  /** What the policy would fold now. */
  folds: { results: number; savedChars: number; savedPercent: number }
}

const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10)

export function reportFor(messages: readonly SessionMessage[], settings: PolicySettings): PolicyReport {
  const uses = toolUses(messages)
  const turnsAgoAt = turnsAgoOf(messages)
  const rows: { tool: string; chars: number; turnsAgo: number }[] = []
  messages.forEach((message, i) => {
    for (const result of message.toolResults ?? []) {
      rows.push({ tool: uses.get(result.tool_use_id)?.tool ?? 'unknown', chars: result.text.length, turnsAgo: turnsAgoAt[i] ?? 0 })
    }
  })

  const resultChars = rows.reduce((sum, row) => sum + row.chars, 0)
  const tools = new Map<string, { results: number; chars: number }>()
  for (const row of rows) {
    const seen = tools.get(row.tool) ?? { results: 0, chars: 0 }
    tools.set(row.tool, { results: seen.results + 1, chars: seen.chars + row.chars })
  }

  const whole = transcriptChars(messages)
  const outcome = foldTranscript(messages, makePolicy(settings))

  return {
    results: rows.length,
    resultChars,
    transcriptChars: whole,
    byTool: [...tools.entries()]
      .map(([tool, sums]) => ({ tool, ...sums }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 10),
    bySize: [500, 1000, 2000, 5000].map(atLeast => {
      const big = rows.filter(row => row.chars >= atLeast)
      const chars = big.reduce((sum, row) => sum + row.chars, 0)

      return { atLeast, resultsPercent: percent(big.length, rows.length), charsPercent: percent(chars, resultChars) }
    }),
    inRecentTurns: [1, 2, 3, 5].map(turns => ({
      turns,
      charsPercent: percent(rows.filter(row => row.turnsAgo < turns).reduce((sum, row) => sum + row.chars, 0), resultChars),
    })),
    folds: { results: outcome.archived.length, savedChars: outcome.savedChars, savedPercent: percent(outcome.savedChars, whole) },
  }
}

/** Lines `offset` (1-based) through `offset + limit - 1` of an archived text. */
export function sliceLines(text: string, offset: number, limit: number): { body: string; total: number; from: number; to: number } {
  const lines = text.split('\n')
  const from = Math.min(Math.max(1, Math.floor(offset)), Math.max(1, lines.length))
  const to = Math.min(lines.length, from + Math.max(1, Math.floor(limit)) - 1)

  return { body: lines.slice(from - 1, to).join('\n'), total: lines.length, from, to }
}
