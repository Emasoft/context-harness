// Fold relevance, shadow only: at a compaction, ask Jev which earlier tool
// results the current request still needs, and record that beside what the
// fold policy itself did. Compaction rebuilds the prompt cache anyway, so this
// is where such a judgment costs no cache. Nothing here changes the compaction.
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { NOTE_MARKS, foldableResults, makePolicy, type PolicySettings } from './fold'
import type { JevQuestion } from './jev'
import { normalizePath, targetOfCommand, targetOfPath } from './tool-gate'

export const FOLD_POINT = 'fold'

/** What the judgment sees of one result: never its text or its full input. */
export type FoldCandidate = {
  id: string
  tool: string
  /** What Jev is shown: the tool, its target as tool-gate shows targets, and the size. */
  call: string
  chars: number
  turnsAgo: number
  /** Whether the fold policy folds it. */
  ruleFolds: boolean
}

// A prompt the person wrote: not a tool result, an injected <tag> block, a
// /command, or one of this plugin's own notes.
const isPersonsPrompt = (message: SessionMessage): boolean => {
  const text = message.text.trimStart()

  return (
    message.role === 'user' &&
    (message.toolResults ?? []).length === 0 &&
    text !== '' &&
    !text.startsWith('<') &&
    !text.startsWith('/') &&
    !NOTE_MARKS.some(mark => text.startsWith(mark))
  )
}

/** The last prompt the person wrote, or undefined. */
export function currentRequest(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (isPersonsPrompt(messages[i]!)) return messages[i]!.text.trim()

  return undefined
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const
const OTHER_KEYS = ['pattern', 'url', 'query', 'description'] as const

/** How one tool call is shown: never the content, only what it was called on. */
export function describeCall(use: Pick<ToolUseSummary, 'tool' | 'input'> | undefined, home: string, cwd: string): string {
  if (use === undefined) return 'unknown call'
  const input = use.input as Record<string, unknown>
  if (typeof input.command === 'string') return `${use.tool} ${targetOfCommand(input.command, home, cwd)}`
  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string') return `${use.tool} ${targetOfPath(normalizePath(value, home, cwd), home, cwd)}`
  }
  for (const key of OTHER_KEYS) {
    const value = input[key]
    if (typeof value === 'string') return `${use.tool} "${value.slice(0, 120)}"`
  }

  return use.tool
}

/**
 * The results the fold could act on, at least the policy's minimum size, at
 * most `limit`, largest first. Built from the fold's own list, so the rule's
 * verdict here is the fold's.
 */
export function foldCandidates(messages: readonly SessionMessage[], settings: PolicySettings, home: string, cwd: string, limit: number): FoldCandidate[] {
  return foldableResults(messages, makePolicy(settings))
    .filter(result => result.text.length >= settings.minFoldChars)
    .map(result => ({
      id: result.id,
      tool: result.tool,
      call: `${describeCall(result, home, cwd)} (${result.text.split('\n').length} lines)`,
      chars: result.text.length,
      turnsAgo: result.turnsAgo,
      ruleFolds: result.fold,
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit)
}

// Measured with jev-1.14.0 on 10 results of a bug-fix request: results the
// fix needed got 0.38-0.85 for "needed", the others 0.00-0.26.
export function foldQuestion(call: string): JevQuestion {
  return {
    type: 'choice',
    instructions: `Will the agent need the full output of this earlier tool call again to finish the current request? Tool call: ${call}`,
    criteria: { needed: 'The output is still needed for the current request.', done: 'The output is no longer needed for it.' },
  }
}
