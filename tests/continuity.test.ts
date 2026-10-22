import { expect, test } from 'claude-code/testing'
import { anchorNote, dueBeforeFold, dueNote, settingsFrom, type AnchorFile } from '../hooks/fold'

const T0 = Date.UTC(2026, 9, 21, 7, 0)
const HOUR = 3_600_000

const FILES: AnchorFile[] = [
  { role: 'intent', path: 'INTENT.md', mtimeMs: T0 - 5 * HOUR },
  { role: 'phase', path: 'PHASE.md', mtimeMs: T0 - HOUR },
  { role: 'episodes', path: 'sessions', mtimeMs: T0 + HOUR },
]

test('the canonical paths are settings; an empty one turns its part off', () => {
  expect(settingsFrom({}).intentFile).toBe('INTENT.md')
  expect(settingsFrom({}).phaseFile).toBe('PHASE.md')
  expect(settingsFrom({}).episodeDir).toBe('sessions')
  expect(settingsFrom({ phaseFile: ' docs/board.md ', episodeDir: '' })).toMatchObject({ phaseFile: 'docs/board.md', episodeDir: '' })
})

test('only the status board and the episode log are due, each when written before the last compaction', () => {
  expect(dueBeforeFold(FILES, T0).map(file => file.path)).toEqual(['PHASE.md'])
  expect(dueBeforeFold(FILES, T0 + 2 * HOUR).map(file => file.path)).toEqual(['PHASE.md', 'sessions'])
  // The intent changes only when the person's does, so it is never due.
  expect(dueBeforeFold(FILES, T0 + 9 * HOUR).some(file => file.role === 'intent')).toBe(false)
})

test('the anchor note points at the canonical files in order and copies nothing from them', () => {
  const text = anchorNote(FILES, 37, [])

  expect(text).toContain('37 tool results were folded')
  expect(text).toContain('- INTENT.md: the person\'s intent, last written 2026-10-21T02:00Z\n- PHASE.md: the status board, last written 2026-10-21T06:00Z')
  expect(text).toContain('Earlier episodes are in sessions/ (newest written 2026-10-21T08:00Z)')
  expect(text).not.toContain('consolidate')
})

test('the anchor note names what was not written since the previous compaction', () => {
  const text = anchorNote(FILES, 0, dueBeforeFold(FILES, T0))

  expect(text.startsWith('[context-harness] This conversation was just compacted.')).toBe(true)
  expect(text).toContain("Not written since the previous compaction (or the session's start): PHASE.md. Run the context-harness:consolidate skill")
})

test('with no canonical files the note only says what was folded', () => {
  expect(anchorNote([], 3, [])).toBe(
    '[context-harness] This conversation was just compacted; 3 tool results were folded into one-line pointers (read_coordinate returns the originals).',
  )
})

test('the deferral note lists each due file and asks for the consolidate skill', () => {
  const text = dueNote(dueBeforeFold(FILES, T0 + 2 * HOUR))

  expect(text).toContain('PHASE.md (the status board, last written 2026-10-21T06:00Z); sessions (the episode log, last written 2026-10-21T08:00Z)')
  expect(text).toContain('Run the context-harness:consolidate skill now')
})

test('policy_report lists the canonical files it found', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  // The engine hands a relative path on resolved against the working directory.
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/PHASE.md') || e.path.endsWith('/sessions') }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: T0, isLink: false } }))
  on('fs.list', () => ({
    value: [
      { name: '2026-10-20-a.md', kind: 'file', size: 10, mtimeMs: T0 - HOUR, isLink: false },
      { name: '2026-10-21-b.md', kind: 'file', size: 10, mtimeMs: T0 + HOUR, isLink: false },
    ],
  }))

  const report = await $.tool.call({ tool: 'mcp__context-harness__policy_report' })
  const { anchors } = JSON.parse(String(report.result)) as { anchors: AnchorFile[] }
  expect(anchors).toEqual([
    { role: 'phase', path: 'PHASE.md', mtimeMs: T0 },
    { role: 'episodes', path: 'sessions', mtimeMs: T0 + HOUR },
  ])
})
