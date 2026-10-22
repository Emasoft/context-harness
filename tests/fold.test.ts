import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { FOLD_MARK, foldTranscript, pointerFor, shouldFold, sliceLines, type FoldCandidate, type FoldPolicy } from '../hooks/fold'

const BIG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')

const prompt = (text: string, handle: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })
const call = (id: string, tool: string, input: Record<string, unknown>, handle: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
  handle,
})
const answer = (id: string, text: string, handle: string, isError = false): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }],
  handle,
})

// Two turns: an old Read, then the turn in view with its own Read.
const TRANSCRIPT: SessionMessage[] = [
  prompt('read the app', 'h0'),
  call('toolu_old', 'Read', { file_path: 'src/app.ts' }, 'h1'),
  answer('toolu_old', BIG, 'h2'),
  prompt('now the config', 'h3'),
  call('toolu_new', 'Read', { file_path: 'src/config.ts' }, 'h4'),
  answer('toolu_new', BIG, 'h5'),
]

// The tests' own policy, so they hold whatever shouldFold becomes.
const foldOlderTurns: FoldPolicy = c => c.turnsAgo >= 1

test('a result from an earlier turn folds to a pointer and is archived', () => {
  const { messages, archived, savedChars } = foldTranscript(TRANSCRIPT, foldOlderTurns)

  const folded = messages[2]!
  expect(folded.handle).toBe(undefined)
  expect(folded.toolResults?.[0]?.text.startsWith(FOLD_MARK)).toBe(true)
  expect(folded.toolResults?.[0]?.text).toContain('Read · src/app.ts · 300 lines')
  expect(folded.toolResults?.[0]?.text).toContain('read_coordinate("toolu_old")')

  expect(archived.map(a => a.id)).toEqual(['toolu_old'])
  expect(archived[0]?.text).toBe(BIG)
  expect(savedChars).toBe(BIG.length - (folded.toolResults?.[0]?.text.length ?? 0))
})

test('the turn in view and every message without a folded result keep their handle', () => {
  const { messages } = foldTranscript(TRANSCRIPT, foldOlderTurns)

  expect(messages.map(m => m.handle)).toEqual(['h0', 'h1', undefined, 'h3', 'h4', 'h5'])
  expect(messages[5]!.toolResults?.[0]?.text).toBe(BIG)
})

test('an already folded result stays as it is and is not archived again', () => {
  const once = foldTranscript(TRANSCRIPT, foldOlderTurns)
  const twice = foldTranscript(once.messages, () => true)

  expect(twice.messages[2]!.toolResults?.[0]?.text).toBe(once.messages[2]!.toolResults?.[0]?.text)
  expect(twice.archived.map(a => a.id)).toEqual(['toolu_new'])
})

test('a result shorter than its pointer is never folded', () => {
  const short = [prompt('go', 'a'), call('toolu_s', 'Bash', { command: 'true' }, 'b'), answer('toolu_s', 'ok', 'c'), prompt('next', 'd')]
  const { messages, archived } = foldTranscript(short, () => true)

  expect(archived.length).toBe(0)
  expect(messages[2]!.handle).toBe('c')
})

test('a policy that folds nothing changes nothing', () => {
  const { messages, archived, savedChars } = foldTranscript(TRANSCRIPT, () => false)

  expect(messages).toEqual(TRANSCRIPT)
  expect(archived.length).toBe(0)
  expect(savedChars).toBe(0)
})

test('a long path keeps its file name in the pointer, a long command its start', () => {
  const base: FoldCandidate = { tool: 'Read', input: {}, text: BIG, isError: false, turnsAgo: 3 }
  const path = `/private/tmp/${'deep/'.repeat(20)}alpha.txt`

  const pointer = pointerFor('toolu_p', { ...base, input: { file_path: path } })
  expect(pointer.startsWith('[folded Read · …deep/')).toBe(true)
  expect(pointer).toContain('/alpha.txt · 300 lines')
  expect(pointerFor('toolu_c', { ...base, tool: 'Bash', input: { command: `cat ${path}` } })).toContain('Bash · cat /private/tmp/deep/')
})

test('the policy folds large results from two or more turns ago', () => {
  const old: FoldCandidate = { tool: 'Bash', input: { command: 'ls' }, text: 'x'.repeat(1000), isError: false, turnsAgo: 2 }

  expect(shouldFold(old)).toBe(true)
  expect(shouldFold({ ...old, turnsAgo: 1 })).toBe(false)
  expect(shouldFold({ ...old, text: 'x'.repeat(999) })).toBe(false)
})

test('the policy keeps state tools and short errors', () => {
  const old: FoldCandidate = { tool: 'Bash', input: {}, text: 'x'.repeat(1500), isError: false, turnsAgo: 5 }

  for (const tool of ['TodoWrite', 'AskUserQuestion', 'ExitPlanMode']) expect(shouldFold({ ...old, tool })).toBe(false)
  expect(shouldFold({ ...old, isError: true })).toBe(false)
  expect(shouldFold({ ...old, isError: true, text: 'x'.repeat(2000) })).toBe(true)
})

test('sliceLines returns the asked lines and clamps out-of-range requests', () => {
  expect(sliceLines(BIG, 2, 3)).toEqual({ body: 'line 2\nline 3\nline 4', total: 300, from: 2, to: 4 })
  expect(sliceLines(BIG, 299, 50)).toEqual({ body: 'line 299\nline 300', total: 300, from: 299, to: 300 })
  expect(sliceLines(BIG, -5, 1).from).toBe(1)
})

test('read_coordinate answers with the archived lines', async ($, on) => {
  const kept = { id: 'toolu_old', tool: 'Read', input: { file_path: 'src/app.ts' }, text: BIG, isError: false }
  on('env.get', () => ({ value: '/home/test' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude-context-fold/sess-1/toolu_old.json' }))
  on('fs.read', () => ({ value: JSON.stringify(kept) }))

  // The engine takes a plugin tool's result only as a string or content blocks.
  const found = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_old', offset: 10, limit: 2 })
  expect(found.result).toBe('Read {"file_path":"src/app.ts"} — lines 10-11 of 300\nline 10\nline 11')

  const missing = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_gone' })
  expect(missing.isError).toBe(true)
  expect(typeof missing.result).toBe('string')
})
