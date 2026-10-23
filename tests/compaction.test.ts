// The merge: the fold and its judgment in one compaction hook, one storage
// root, one status line, and the gate in front of read_coordinate.
import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, foldTranscript, makePolicy, turnsAgoOf } from '../hooks/fold'
import { cleanupArgs, dirsBetween } from '../hooks/storage'
import { HOME, KEY_ENV, drain, prompt, records, settle, setup } from './kit'

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string, isError = false): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] })

const ROOT = `${HOME}/.local/state/context-harness`
const ARCHIVE = `${ROOT}/archive/sess-1`

// Jev answers every question it is asked, the same way.
const everyQuestion = (body: Record<string, unknown>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(
      Object.keys(body.questions as object).map(name => [name, { type: 'choice', choice: 'done', confidence: 0.9, probabilities: { needed: 0.3, done: 0.7 } }]),
    ),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})

const archivedIds = (writes: readonly { path: string }[]): Set<string> =>
  new Set(writes.filter(w => w.path.startsWith(`${ARCHIVE}/`)).map(w => w.path.slice(ARCHIVE.length + 1, -'.json'.length)))

// Sixty results of growing size whose text and an unshown input field carry a
// marker, an error under keepErrorsUnder, an injected reminder, a /command and
// a result one prompt old.
const MARK = 'CANARY-7f3a'
const BUSY: SessionMessage[] = [prompt('Refactor the parser')]
for (let i = 0; i < 60; i++) {
  BUSY.push(call(`t${i}`, i % 2 ? 'Read' : 'Bash', i % 2 ? { file_path: `/proj/src/f${i}.ts` } : { command: `cat /proj/src/f${i}.ts`, description: MARK }))
  BUSY.push(answer(`t${i}`, `${MARK}\n${'y'.repeat(400 + i * 37)}`))
}
BUSY.push(call('err', 'Bash', { command: 'npm test' }), answer('err', 'E'.repeat(1500), true))
BUSY.push(prompt('<system-reminder>context</system-reminder>'), prompt('/cmd arg'))
BUSY.push(call('late', 'Read', { file_path: '/proj/late.ts' }), answer('late', 'z'.repeat(900)))
BUSY.push(prompt('Now fix the parser test'))

const NON_DEFAULT = { keepRecentTurns: 1, minFoldChars: 500, foldJev: 'shadow' }

test('every fold record states what the fold did, under a policy that is not the default', { options: NON_DEFAULT }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: BUSY } as never)
  await settle(() => records(io.writes, 'fold').length >= 48)
  await drain()

  const archived = archivedIds(io.writes)
  const rows = records(io.writes, 'fold')
  // The 48 largest of the 59 results at or above minFoldChars.
  expect(rows.length).toBe(48)
  for (const row of rows) {
    expect(row.heuristic).toBe(archived.has(String(row.joinKey)))
    // The judgment's own reading of the policy agrees with what was archived.
    expect((row.facts as Record<string, string>).policyFolds).toBe(String(archived.has(String(row.joinKey))))
  }
  const byId = new Map(rows.map(row => [String(row.joinKey), row]))
  // An error under keepErrorsUnder stays; a 900-character result one prompt old folds under keepRecentTurns 1.
  expect(byId.get('err')?.heuristic).toBe(false)
  expect(archived.has('err')).toBe(false)
  expect(byId.get('late')?.heuristic).toBe(true)
  // Every age is the fold's count, the reminder and the /command included.
  const ages = turnsAgoOf(BUSY)
  for (const row of rows) {
    const at = BUSY.findIndex(m => m.toolResults?.[0]?.tool_use_id === row.joinKey)
    expect((row.facts as Record<string, string>).turnsAgo).toBe(String(ages[at]))
  }
  expect((byId.get('err')?.facts as Record<string, string>).turnsAgo).toBe('3')
})

test('canary: no tool output and no unshown input reaches Jev', { options: NON_DEFAULT }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: BUSY } as never)
  await settle(() => records(io.writes, 'fold').length >= 48)

  expect(io.fetches.length).toBe(2)
  for (const fetch of io.fetches) expect(JSON.stringify(fetch.body)).not.toContain(MARK)
  // The request is the person's last prompt, not the reminder or the /command.
  expect(io.fetches[0]?.body.state).toEqual({ current_request: 'Now fix the parser test' })
})

const BIG = 'x\n'.repeat(1500)
const RECENT: SessionMessage[] = [prompt('Look at a.ts'), call('a', 'Read', { file_path: '/proj/a.ts' }), answer('a', BIG)]
const OLD: SessionMessage[] = [...RECENT, prompt('next'), prompt('and next')]

test('nothing folded: the engine summarizes, and the judgment records that nothing was folded', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: everyQuestion })
  const result = await $.session.compact({ trigger: 'manual', messages: RECENT } as never)
  expect(JSON.stringify(result)).toContain('summary')
  await settle(() => records(io.writes, 'fold').length > 0)
  expect(records(io.writes, 'fold').map(r => [r.joinKey, r.heuristic])).toEqual([['a', false]])
  expect(archivedIds(io.writes).size).toBe(0)
})

test('a skipped compaction with nothing to fold records nothing and counts nothing', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: everyQuestion, compactBelow: 'skip' })
  expect((await $.session.compact({ trigger: 'manual', messages: RECENT } as never)).skip).toBe('skipped below')
  await drain()
  expect(records(io.writes, 'fold').length).toBe(0)
  expect(io.appended.length).toBe(0)
})

test('folded but still too large, then skipped: nothing recorded and nothing counted', { options: { foldJev: 'shadow' } }, async ($, on) => {
  // The folded transcript still fills the window, so the engine is asked to summarize it, and skips.
  const io = setup(on, { env: KEY_ENV, fetch: everyQuestion, compactBelow: 'skip', window: 10 })
  expect((await $.session.compact({ trigger: 'manual', messages: OLD } as never)).skip).toBe('skipped below')
  await drain()
  expect(records(io.writes, 'fold').length).toBe(0)
  expect(io.statuses.some(text => text.includes('folded'))).toBe(false)
  expect(io.appended.length).toBe(0)
})

test('status: with Jev off it reads exactly as it did; with a gate on, both parts stay', async ($, on) => {
  const io = setup(on)
  const { savedChars } = foldTranscript(OLD, makePolicy(DEFAULT_SETTINGS))
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(io.statuses.at(-1)).toBe(`folded 1 · −${Math.round(savedChars / 1000)}k chars`)
})

test('status keeps the fold part when the judgment layer updates it', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Fixed it.' } as never)
  await settle(() => records(io.writes, 'stop').length > 0)
  const last = io.statuses.at(-1) ?? ''
  expect(last.startsWith('folded 1 · ')).toBe(true)
  expect(last).toContain(' | jev · stop shadow 0 judged, 1 failed')
})

test('after a fold the model is pointed back at what was folded', async ($, on) => {
  const io = setup(on)
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await settle(() => io.appended.length > 0)
  expect(io.appended[0]).toContain('[context-harness] This conversation was just compacted; 1 tool results were folded')
})

const kept = (text: string, input: Record<string, unknown> = { file_path: '/proj/a.ts' }) => JSON.stringify({ id: 'toolu_x', tool: 'Read', input, text, isError: false })

test('read_coordinate reads this plugin archive first, then the one from before the rename', async ($, on) => {
  setup(on, {
    files: {
      [`${ARCHIVE}/toolu_x.json`]: kept('new'),
      [`${HOME}/.claude-context-fold/sess-1/toolu_x.json`]: kept('old'),
      [`${HOME}/.claude-context-fold/sess-1/toolu_y.json`]: kept('legacy only'),
    },
  })
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('\nnew')
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_y' })).result)).toContain('\nlegacy only')
})

const SECRET_KEPT = { files: { [`${ARCHIVE}/toolu_x.json`]: kept('API_KEY=abc', { file_path: '/proj/.env' }) } }

test('read_coordinate, external session with the gate active: a folded secret file stays folded', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on, SECRET_KEPT)
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })
  expect(result.isError).toBe(true)
  expect(String(result.result)).toContain('env file')
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('deny')
})

test('read_coordinate, the gate in shadow: returned, and recorded as it would be refused', { options: { toolGate: 'shadow', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on, SECRET_KEPT)
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('API_KEY=abc')
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('would-deny')
})

test('read_coordinate, first-party session: returned', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on, SECRET_KEPT)
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('API_KEY=abc')
})

test('cleanup names the records folder alone, and nothing else gets a command', () => {
  expect(cleanupArgs(`${ROOT}/records`)).toEqual([
    ['find', `${ROOT}/records`, '-type', 'f', '-name', '*.json', '-mtime', '+14', '-not', '-path', `${ROOT}/records/labels/*`, '-delete'],
    ['find', `${ROOT}/records`, '-mindepth', '1', '-type', 'd', '-empty', '-delete'],
  ])
  expect(cleanupArgs(ROOT)).toEqual([])
  expect(cleanupArgs(`${ROOT}/archive`)).toEqual([])
  expect(cleanupArgs(`${HOME}/.claude-context-fold`)).toEqual([])
  expect(dirsBetween(ROOT, `${ROOT}/archive/s`)).toEqual([ROOT, `${ROOT}/archive`, `${ROOT}/archive/s`])
  expect(dirsBetween(ROOT, '/tmp/x')).toEqual([])
})

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

test('the session start runs exactly that cleanup', async ($, on) => {
  const io = setup(on, { files: { [`${ROOT}/records/sess-0/stop/a.json`]: '{}', [`${ARCHIVE}/toolu_x.json`]: '{}' } })
  await $.session.start(START)
  expect(io.runs).toEqual(cleanupArgs(`${ROOT}/records`))
})

test('the session start runs no cleanup without a records folder', async ($, on) => {
  const io = setup(on, { files: { [`${ARCHIVE}/toolu_x.json`]: '{}' } })
  await $.session.start(START)
  expect(io.runs).toEqual([])
})

test('folders are made private before the first file is written in them', async ($, on) => {
  const io = setup(on)
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(io.disk.slice(0, 3)).toEqual(['run mkdir', 'run chmod', `write ${ARCHIVE}/a.json`])
  expect(io.runs[1]).toEqual(['chmod', '700', ROOT, `${ROOT}/archive`, ARCHIVE])
})

test('without HOME nothing is written: the engine summarizes instead of folding', async ($, on) => {
  const io = setup(on, { env: { HOME: '' } })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('summary')
  expect(io.writes).toEqual([])
  expect(io.logs.some(line => line.includes('summarizing instead'))).toBe(true)
})

test('set_policy changes the fold policy only, never a gate, a Jev mode or the key', async ($, on) => {
  const io = setup(on)
  const set = await $.tool.call({ tool: 'mcp__context-harness__set_policy', stopGate: 'active', foldJev: 'shadow', toolGate: 'off', apiKey: 'x' })
  expect(set.result).toBe('No policy value was given.')
  expect(io.configured).toEqual([])
})

test('the agent may not write into the archives, this one or the one before the rename', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Write', file_path: `${ARCHIVE}/toolu_x.json`, content: '{}' })).deny).toContain('context-harness files')
  expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${HOME}/.claude-context-fold/sess-1/toolu_x.json` })).deny).toContain('context-harness files')
})

const EXTERNAL_ACTIVE = { options: { toolGate: 'active', providerTrust: 'external' } }

test('external session: the archives cannot be read past read_coordinate either', EXTERNAL_ACTIVE, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: `${ARCHIVE}/toolu_x.json` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Bash', command: `grep -r API_KEY ${HOME}/.claude-context-fold` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.ts' })).deny).toBe(undefined)
})

test('first-party session: the archives can be read', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: `${ARCHIVE}/toolu_x.json` })).deny).toBe(undefined)
})

test('read_coordinate judges a folded path by what it leads to as well', EXTERNAL_ACTIVE, async ($, on) => {
  setup(on, {
    files: { [`${ARCHIVE}/toolu_x.json`]: kept('aws_secret_access_key = x', { file_path: '/proj/creds' }) },
    realPaths: { '/proj/creds': `${HOME}/.aws/credentials` },
  })
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })
  expect(result.isError).toBe(true)
  expect(String(result.result)).toContain('cloud credentials')
})

test('a folder that cannot be made private gets nothing written: the engine summarizes', async ($, on) => {
  const io = setup(on, { failRun: 'chmod' })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('summary')
  expect(io.writes).toEqual([])
})

test('without HOME the idle boundary starts no /compact', async ($, on) => {
  const io = setup(on, { env: { HOME: '' }, messages: OLD, percent: 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await drain()
  expect(io.commands).toEqual([])
})

test('with HOME the idle boundary does start one', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.commands.length > 0)
  expect(io.commands).toEqual(['compact'])
})

test('without HOME the session still starts its judgment layer', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: { HOME: '' } })
  await $.session.start(START)
  expect(io.statuses).toContain('jev: no key')
  expect(io.logs.filter(line => line.includes('did not start') || line.includes('old records'))).toEqual([])
})

test('a failure after the fold keeps the fold', { options: { episodeDir: '/proj/sessions' } }, async ($, on) => {
  // The episode folder exists but cannot be listed.
  const io = setup(on, { files: { '/proj/sessions/2026-10-22.md': 'x' }, failList: '/proj/sessions' })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('[folded Read')
  expect(io.logs.some(line => line.includes('after the compaction'))).toBe(true)
})

test('an archive that could not be written still leaves the note that follows a compaction', { options: { phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, { failWrite: '/archive/', files: { '/proj/PHASE.md': 'now' } })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await settle(() => io.appended.length > 0)
  expect(io.appended[0]).toContain('[context-harness] This conversation was just compacted.')
})

// compact.log: one line per session.compact dispatch, whatever the hook did with it.
const LOG = `${ROOT}/compact.log`
const logLines = (writes: readonly { path: string; text: string }[]): Record<string, unknown>[] =>
  ([...writes].reverse().find(w => w.path === LOG)?.text ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)

test('compact.log: nothing to fold is logged as handed to the engine summary', async ($, on) => {
  const io = setup(on)
  await $.session.compact({ trigger: 'manual', messages: RECENT } as never)
  const [line] = logLines(io.writes)
  expect(logLines(io.writes).length).toBe(1)
  expect(line).toMatchObject({ session: 'sess-1', trigger: 'manual', outcome: 'summarized-nothing-to-fold', messages: 3, folded: 0, savedChars: 0 })
  expect(line?.estTokensBefore).toBeGreaterThan(0)
})

test('compact.log: a fold that stands is logged with what it folded', async ($, on) => {
  const io = setup(on)
  const { savedChars } = foldTranscript(OLD, makePolicy(DEFAULT_SETTINGS))
  await $.session.compact({ trigger: 'auto', messages: OLD } as never)
  expect(logLines(io.writes)).toEqual([
    expect.objectContaining({ trigger: 'auto', outcome: 'folded', folded: 1, savedChars, messages: OLD.length }),
  ])
})

test('compact.log: a fold still too large is logged as folded then summarized', async ($, on) => {
  const io = setup(on, { window: 10 })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(logLines(io.writes)[0]).toMatchObject({ outcome: 'folded-then-summarized', folded: 1 })
})

test('compact.log: a skip beneath is logged with its reason and no fold counted', async ($, on) => {
  const io = setup(on, { compactBelow: 'skip', window: 10 })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(logLines(io.writes)[0]).toMatchObject({ outcome: 'engine-skipped', skip: 'skipped below', folded: 0, savedChars: 0 })
})

test('compact.log: a subagent and a precompute are logged as passed through', async ($, on) => {
  const io = setup(on)
  await $.session.compact({ trigger: 'auto', agentId: 'ag-1', messages: OLD } as never)
  await $.session.compact({ trigger: 'precompute', messages: OLD } as never)
  expect(logLines(io.writes).map(line => [line.outcome, line.agentId])).toEqual([
    ['passed-subagent', 'ag-1'],
    ['passed-precompute', undefined],
  ])
  expect(archivedIds(io.writes).size).toBe(0)
})

test('compact.log: a hook that throws is logged as failed, and the engine summarizes', async ($, on) => {
  const io = setup(on, { usageFails: true })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('summary')
  await settle(() => logLines(io.writes).length > 0)
  expect(logLines(io.writes)[0]).toMatchObject({ session: 'sess-1', outcome: 'hook-failed', messages: OLD.length })
})

test('compact.log: a log that cannot be written leaves the fold as it is', async ($, on) => {
  const io = setup(on, { failWrite: 'compact.log' })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('[folded Read')
  expect(io.logs.some(line => line.includes('could not write compact.log'))).toBe(true)
})

test('compact.log: keeps the last 1000 lines', async ($, on) => {
  const old = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ outcome: `old-${i}` })).join('\n')
  const io = setup(on, { files: { [LOG]: `${old}\n` } })
  await $.session.compact({ trigger: 'manual', messages: RECENT } as never)
  const lines = logLines(io.writes)
  expect(lines.length).toBe(1000)
  expect(lines[0]?.outcome).toBe('old-1')
  expect(lines.at(-1)?.outcome).toBe('summarized-nothing-to-fold')
})
