import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, makePolicy, reportFor, settingsFrom, type FoldCandidate } from '../hooks/fold'

const BIG = 'x'.repeat(5000)
const SMALL = 'y'.repeat(600)

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const call = (id: string, tool: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input: {} }] })
const answer = (id: string, text: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false }],
})

// Three turns: a large Read and a small Grep, then a large Bash, then the turn in view.
const TRANSCRIPT: SessionMessage[] = [
  prompt('one'),
  call('a', 'Read'),
  answer('a', BIG),
  call('b', 'Grep'),
  answer('b', SMALL),
  prompt('two'),
  call('c', 'Bash'),
  answer('c', BIG),
  prompt('three'),
]

test('settings fill missing or invalid values from the base and clamp the rest', () => {
  expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS)

  const set = settingsFrom({ keepRecentTurns: 3.6, minFoldChars: -5, foldAtPercent: 250, keepTools: ' Read , Bash,', minSavedPercent: 'many' })
  expect(set.keepRecentTurns).toBe(4)
  expect(set.minFoldChars).toBe(0)
  expect(set.foldAtPercent).toBe(100)
  expect(set.keepTools).toEqual(['Read', 'Bash'])
  expect(set.minSavedPercent).toBe(DEFAULT_SETTINGS.minSavedPercent)
  expect(settingsFrom({ keepTools: ['Grep'] }).keepTools).toEqual(['Grep'])
})

test('a policy follows its settings', () => {
  const old: FoldCandidate = { tool: 'Read', input: {}, text: BIG, isError: false, turnsAgo: 1 }

  expect(makePolicy(DEFAULT_SETTINGS)(old)).toBe(false)
  expect(makePolicy({ ...DEFAULT_SETTINGS, keepRecentTurns: 1 })(old)).toBe(true)
  expect(makePolicy({ ...DEFAULT_SETTINGS, keepRecentTurns: 1, keepTools: ['Read'] })(old)).toBe(false)
  expect(makePolicy({ ...DEFAULT_SETTINGS, keepRecentTurns: 1, minFoldChars: 6000 })(old)).toBe(false)
})

test('the report measures tools, sizes and recent turns, and what the policy would fold', () => {
  const report = reportFor(TRANSCRIPT, DEFAULT_SETTINGS)

  expect(report.results).toBe(3)
  expect(report.resultChars).toBe(10_600)
  expect(report.byTool.map(row => row.tool)).toEqual(['Read', 'Bash', 'Grep'])
  expect(report.bySize.find(row => row.atLeast === 1000)).toEqual({ atLeast: 1000, resultsPercent: 66.7, charsPercent: 94.3 })
  expect(report.inRecentTurns.find(row => row.turns === 2)?.charsPercent).toBe(47.2)
  // Only the Read is two turns back and large enough.
  expect(report.folds.results).toBe(1)

  expect(reportFor(TRANSCRIPT, { ...DEFAULT_SETTINGS, keepRecentTurns: 1, minFoldChars: 500 }).folds.results).toBe(3)
})

test('policy_report reports the current policy and a dry-run candidate', async ($, on) => {
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('fs.exists', () => ({ value: false }))

  const plain = await $.tool.call({ tool: 'mcp__context-harness__policy_report' })
  const report = JSON.parse(String(plain.result)) as { current: { folds: { results: number } }; candidate?: unknown }
  expect(report.current.folds.results).toBe(1)
  expect(report.candidate).toBe(undefined)

  const dry = await $.tool.call({ tool: 'mcp__context-harness__policy_report', keepRecentTurns: 1, minFoldChars: 500 })
  const both = JSON.parse(String(dry.result)) as { candidate: { folds: { results: number }; settings: { keepRecentTurns: number } } }
  expect(both.candidate.folds.results).toBe(3)
  expect(both.candidate.settings.keepRecentTurns).toBe(1)
})

test('the plugin reads its policy from its options', { options: { keepRecentTurns: 1, minFoldChars: 500 } }, async ($, on) => {
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('fs.exists', () => ({ value: false }))

  const plain = await $.tool.call({ tool: 'mcp__context-harness__policy_report' })
  const report = JSON.parse(String(plain.result)) as { current: { settings: { keepRecentTurns: number }; folds: { results: number } } }
  expect(report.current.settings.keepRecentTurns).toBe(1)
  expect(report.current.folds.results).toBe(3)
})

test('set_policy writes only the given values through the settings menu', async ($, on) => {
  const written: [string, unknown][] = []
  on('config.set', (_, e) => {
    written.push([e.key, e.value])

    return { value: e.value }
  })

  const set = await $.tool.call({ tool: 'mcp__context-harness__set_policy', minFoldChars: 3000, keepTools: ['TodoWrite', 'Read'] })
  expect(written).toEqual([
    ['context-harness.minFoldChars', 3000],
    ['context-harness.keepTools', 'TodoWrite,Read'],
  ])
  expect(set.result).toBe('minFoldChars = 3000\nkeepTools = "TodoWrite,Read"')

  const none = await $.tool.call({ tool: 'mcp__context-harness__set_policy' })
  expect(none.result).toBe('No policy value was given.')
})

test('set_policy reports a refused value', async ($, on) => {
  on('config.set', () => ({ deny: 'locked by policy' }))

  const set = await $.tool.call({ tool: 'mcp__context-harness__set_policy', foldAtPercent: 0 })
  expect(set.result).toBe('foldAtPercent refused: locked by policy')
})
