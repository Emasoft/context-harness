import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, turnsAgoOf } from '../hooks/fold'
import { currentRequest, foldCandidates } from '../hooks/fold-judge'
import { attachedNames, decideFragments, fragmentBlock, fragmentsHash, isFragment, keywordHit, parseFragment, pinnedSection, type Fragment } from '../hooks/instructions'
import { HOME, KEY_ENV, drain, records, settle, setup as kitSetup, type On, type Setup } from './kit'

const DIR = `${HOME}/.agents/fragments`

const PROSE = `---\nwhen: The person asks for prose meant for human readers.\nkeywords: 보고서, report\n---\nWrite plainly; no filler.\n`
const DEPLOY = `---\nwhen: The work involves deploying or releasing.\n---\nCheck the rollback plan first.\n`
const ALWAYS = `---\npin: true\n---\nAnswer in the person's language.\n`

test('a fragment file needs frontmatter, a body, and a condition unless pinned', () => {
  const prose = parseFragment('prose.md', PROSE)
  expect(isFragment(prose)).toBe(true)
  if (isFragment(prose)) {
    expect(prose).toEqual({ name: 'prose', when: 'The person asks for prose meant for human readers.', keywords: ['보고서', 'report'], pin: false, body: 'Write plainly; no filler.' })
  }
  expect(isFragment(parseFragment('always.md', ALWAYS))).toBe(true)
  expect(parseFragment('x.md', 'no frontmatter')).toEqual({ file: 'x.md', reason: 'no frontmatter' })
  expect(parseFragment('x.md', '---\nwhen: a\n---\n')).toEqual({ file: 'x.md', reason: 'empty body' })
  expect(parseFragment('x.md', '---\nkeywords: a\n---\nbody')).toEqual({ file: 'x.md', reason: 'no when: (or pin: true)' })
  expect(parseFragment('x.md', `---\nwhen: a\n---\n${'y'.repeat(5000)}`)).toEqual({ file: 'x.md', reason: 'body over 4096 characters' })
  expect(parseFragment('bad name.md', PROSE)).toEqual({ file: 'bad name.md', reason: 'name must be letters, digits, - or _' })
})

test('keywords match whole words in Latin text and substrings otherwise', () => {
  expect(keywordHit('Write the weekly report', ['report'])).toBe(true)
  expect(keywordHit('Fix the reporter module', ['report'])).toBe(false)
  expect(keywordHit('주간 보고서로 정리해줘', ['보고서'])).toBe(true)
  expect(keywordHit('Fix the bug', [])).toBe(false)
})

test('a keyword hit attaches without Jev; otherwise the threshold decides; no answer, no attach', () => {
  const fragments = [PROSE, DEPLOY].map((text, i) => parseFragment(`f${i}.md`, text)).filter(isFragment)
  const decisions = decideFragments(fragments, new Map([['f0', true], ['f1', false]]), new Map([['f1', 0.95]]), 0.9)
  expect(decisions.map(d => [d.name, d.attach])).toEqual([['f0', true], ['f1', true]])
  expect(decideFragments(fragments, new Map(), new Map([['f1', 0.78]]), 0.9).map(d => d.attach)).toEqual([false, false])
})

test('pinned fragments form one stable section; the hash follows any change', () => {
  const list = [ALWAYS, PROSE].map((text, i) => parseFragment(`p${i}.md`, text)).filter(isFragment)
  expect(pinnedSection(list)).toBe(fragmentBlock(list[0]!))
  expect(pinnedSection(list.slice(1))).toBe(undefined)
  expect(fragmentsHash(list)).toBe(fragmentsHash(list))
  expect(fragmentsHash(list)).not.toBe(fragmentsHash([list[0]!, { ...list[1]!, body: 'changed' } as Fragment]))
})

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string, isError = false): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] })
const BIG = 'x\n'.repeat(1500)

const TRANSCRIPT: SessionMessage[] = [
  prompt('Look at the billing code'),
  call('a', 'Read', { file_path: '/proj/src/billing/invoice.ts' }),
  answer('a', BIG),
  call('b', 'Bash', { command: 'ls -R /proj' }),
  answer('b', 'x'.repeat(800)),
  prompt('<system-reminder>not a prompt</system-reminder>'),
  prompt('Now check the tests'),
  call('c', 'Bash', { command: 'npm test' }),
  answer('c', `${BIG}${BIG}`),
  prompt('Fix the rounding bug in invoice totals'),
  call('d', 'Read', { file_path: '/proj/README.md' }),
  answer('d', '[folded Read · ./README.md · 60 lines]'),
  prompt('/compact'),
]

test('fold candidates come from the fold policy itself: its turn count, its size floor, its verdict', () => {
  // A /command is not the request.
  expect(currentRequest(TRANSCRIPT)).toBe('Fix the rounding bug in invoice totals')
  // The fold counts every user text as a turn boundary, injected reminders and /commands included.
  expect(turnsAgoOf(TRANSCRIPT)[2]).toBe(4)
  expect(foldCandidates(TRANSCRIPT, DEFAULT_SETTINGS, HOME, '/proj', 48).map(c => [c.id, c.call, c.turnsAgo, c.ruleFolds])).toEqual([
    ['c', 'Bash npm test (3001 lines)', 2, true],
    ['a', 'Read ./src/billing/invoice.ts (1501 lines)', 4, true],
  ])
  // A lower size floor brings the 800-character result in; a wider recent window keeps c.
  const wider = foldCandidates(TRANSCRIPT, { ...DEFAULT_SETTINGS, minFoldChars: 500, keepRecentTurns: 3 }, HOME, '/proj', 48)
  expect(wider.map(c => [c.id, c.ruleFolds])).toEqual([
    ['c', false],
    ['a', true],
    ['b', true],
  ])
  expect(foldCandidates(TRANSCRIPT, DEFAULT_SETTINGS, HOME, '/proj', 1).map(c => c.id)).toEqual(['c'])
})

test('attached fragments are counted in the messages the next request carries', () => {
  const text = (t: string) => ({ type: 'text', text: t })
  const names = attachedNames([
    { role: 'user', content: [text('Publish it'), text('<instruction name="deploy" source="context-harness">\nx\n</instruction>')] },
    { role: 'user', content: [text('<instruction name="prose" source="jev-harness">\ny\n</instruction>')] },
    { role: 'assistant', content: [text('<instruction name="quoted" source="context-harness">')] },
    { role: 'user', content: [text('<instruction name="other" source="someone-else">')] },
  ])
  expect([...names].sort()).toEqual(['deploy', 'prose'])
  // An opening tag alone, quoted or carried into a summary, is not a block; text before a whole block is fine.
  const quoted = attachedNames([
    { role: 'user', content: [text('Why does <instruction name="release" source="context-harness"> show up?')] },
    { role: 'user', content: [text('prompt.submit hook additional context: <instruction name="deploy" source="context-harness">\nx\n</instruction>')] },
  ])
  expect([...quoted]).toEqual(['deploy'])
})

const choice = (probabilities: Record<string, Record<string, number>>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(
      Object.entries(probabilities).map(([name, p]) => {
        const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]
        return [name, { type: 'choice', choice: top, confidence: 0.9, probabilities: p }]
      }),
    ),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})

// Every test has a key in the environment and a Jev that answers nothing unless told otherwise.
const setup = (on: On, s: Setup = {}) => kitSetup(on, { env: KEY_ENV, fetch: () => choice({}), ...s })

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }

const FILES = { [`${DIR}/prose.md`]: PROSE, [`${DIR}/deploy.md`]: DEPLOY, [`${DIR}/always.md`]: ALWAYS }
const ACTIVE = { options: { instructions: 'active' } }

test('active: a fragment whose condition holds is appended to that prompt, once', ACTIVE, async ($, on) => {
  const io = setup(on, {
    files: FILES,
    fetch: body => choice(Object.fromEntries(Object.keys(body.questions as object).map(name => [name, name === 'deploy' ? { applies: 0.99, not: 0.01 } : { applies: 0.02, not: 0.98 }]))),
  })
  await $.prompt.submit(typed('Publish the release to npm'))
  expect(io.fetches.length).toBe(1)
  // Neither had a keyword hit, so both are asked about; only deploy applies.
  expect(Object.keys(io.fetches[0]!.body.questions as object).sort()).toEqual(['deploy', 'prose'])
  expect(io.submitted[0]?.context).toEqual(['<instruction name="deploy" source="context-harness">\nCheck the rollback plan first.\n</instruction>'])

  await $.prompt.submit(typed('Publish the next release too'))
  expect(io.submitted[1]?.context).toBe(undefined)
  expect(Object.keys(io.fetches[1]!.body.questions as object)).toEqual(['prose'])
})

test('active: a keyword hit attaches without asking Jev about it', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: () => choice({ deploy: { applies: 0.01, not: 0.99 } }) })
  await $.prompt.submit(typed('주간 보고서로 정리해줘'))
  expect(Object.keys(io.fetches[0]!.body.questions as object)).toEqual(['deploy'])
  expect(io.submitted[0]?.context?.[0]).toContain('name="prose"')
})

const DEPLOY_APPLIES = () => choice({ deploy: { applies: 0.99, not: 0.01 }, prose: { applies: 0.01, not: 0.99 } })

test('after a compaction the engine summarized, a fragment is attached again', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES })
  await $.prompt.submit(typed('Publish the release'))
  expect(io.submitted[0]?.context?.[0]).toContain('name="deploy"')
  // Nothing to fold: the engine summarizes, and the block leaves the conversation.
  await $.session.compact({ trigger: 'manual', messages: [prompt('Publish the release')] } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  await $.prompt.submit(typed('Publish it again'))
  expect(io.submitted[1]?.context?.[0]).toContain('name="deploy"')
})

test('after a compaction that only folded, a fragment still in the conversation is not attached again', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES })
  await $.prompt.submit(typed('Publish the release'))
  const transcript = [prompt('Publish the release'), call('x', 'Read', { file_path: '/proj/big.txt' }), answer('x', BIG), prompt('next'), prompt('and next')]
  const compacted = await $.session.compact({ trigger: 'manual', messages: transcript } as never)
  // The plugin answered the compaction itself: the result became a pointer, the block stayed.
  expect(JSON.stringify(compacted)).toContain('[folded Read')
  // The engine still raises these after a compaction a plugin answered.
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: '' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  await $.prompt.submit(typed('Publish it again'))
  expect(io.submitted[1]?.context).toBe(undefined)
})

test('shadow: the prompt goes on untouched and the judgment is recorded', { options: { instructions: 'shadow' } }, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: () => choice({ deploy: { applies: 0.99, not: 0.01 }, prose: { applies: 0.02, not: 0.98 } }) })
  await $.prompt.submit(typed('Publish the release, see a@b.co'))
  expect(io.submitted[0]?.context).toBe(undefined)
  await settle(() => records(io.writes, 'instructions').length >= 2)
  const byName = Object.fromEntries(records(io.writes, 'instructions').map(r => [(r.facts as Record<string, string>).fragment, r]))
  expect(byName.deploy?.decision).toBe('would-attach')
  expect(byName.prose?.decision).toBe('skip')
  expect(JSON.stringify(byName.deploy?.sent)).not.toContain('a@b.co')
})

test('slash commands and messages from other origins are left alone', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES })
  await $.prompt.submit({ text: 'A task from another plugin', wait: false, origin: { kind: 'plugin', name: 'other' } } as never)
  await $.prompt.submit({ ...typed('/deploy now'), command: { name: 'deploy', args: 'now' } } as never)
  expect(io.fetches.length).toBe(0)
})

test('pinned fragments become one section at the end of the system prompt, only when active', ACTIVE, async ($, on) => {
  setup(on, { files: FILES })
  const { sections } = await $.prompt.compose(COMPOSE as never)
  expect(sections.map(s => [s.id, s.scope])).toEqual([['base', 'shared'], ['context-harness:pinned', 'session']])
  expect(sections[1]?.text).toContain("Answer in the person's language.")
})

test('a changed fragment set is announced', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES })
  io.store.set('fragments-hash', 'older')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(io.toasts[0]).toContain('instruction fragments changed')
})

test('fold shadow: the judgment rides the fold, and its rule verdict is what the fold did', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { fetch: () => choice({ r0: { needed: 0.9, done: 0.1 }, r1: { needed: 0.2, done: 0.8 } }) })
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  await settle(() => records(io.writes, 'fold').length >= 2)
  expect(io.fetches[0]?.body.state).toEqual({ current_request: 'Fix the rounding bug in invoice totals' })
  const rows = records(io.writes, 'fold').map(r => [r.joinKey, r.heuristic, Number(r.jev).toFixed(1)])
  expect(rows).toEqual([
    ['c', true, '0.1'],
    ['a', true, '0.8'],
  ])
  const archived = io.writes.filter(w => w.path.startsWith(`${HOME}/.local/state/context-harness/archive/sess-1/`)).map(w => w.path.split('/').at(-1))
  expect(archived).toEqual(['a.json', 'c.json'])
})

test('two prompts queued behind a running turn attach a fragment once', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES, isQueued: true })
  await $.prompt.submit(typed('Publish the release'))
  await $.prompt.submit(typed('Publish it to the mirror too'))
  expect(io.submitted[0]?.context?.[0]).toContain('name="deploy"')
  expect(io.submitted[1]?.context).toBe(undefined)
})

test('a record that cannot be written does not stop the fragment', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES, failWrite: '/records/' })
  await $.prompt.submit(typed('Publish the release'))
  expect(io.submitted[0]?.context?.[0]).toContain('name="deploy"')
})

const SHADOW = { options: { instructions: 'shadow' } }
const wouldAttachDeploy = (writes: readonly { path: string; text: string }[]) =>
  records(writes, 'instructions').filter(r => r.decision === 'would-attach' && (r.facts as Record<string, string>).fragment === 'deploy').length

test('shadow: after a compaction that only folded, it would not attach again', SHADOW, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES })
  await $.prompt.submit(typed('Publish the release'))
  await settle(() => wouldAttachDeploy(io.writes) === 1)
  const transcript = [prompt('Publish the release'), call('x', 'Read', { file_path: '/proj/big.txt' }), answer('x', BIG), prompt('next'), prompt('and next')]
  await $.session.compact({ trigger: 'manual', messages: transcript } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: '' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  await $.prompt.submit(typed('Publish it again'))
  await settle(() => records(io.writes, 'instructions').length >= 3)
  await drain()
  expect(wouldAttachDeploy(io.writes)).toBe(1)
})

test('shadow: after a compaction the engine summarized, it would attach again', SHADOW, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES })
  await $.prompt.submit(typed('Publish the release'))
  await settle(() => wouldAttachDeploy(io.writes) === 1)
  await $.session.compact({ trigger: 'manual', messages: [prompt('Publish the release')] } as never)
  await $.prompt.submit(typed('Publish it again'))
  await settle(() => wouldAttachDeploy(io.writes) === 2)
  expect(wouldAttachDeploy(io.writes)).toBe(2)
})

test('a summary this plugin never saw still lets the fragment come back', ACTIVE, async ($, on) => {
  const io = setup(on, { files: FILES, fetch: DEPLOY_APPLIES })
  await $.prompt.submit(typed('Publish the release'))
  await $.prompt.submit(typed('Publish it to the mirror too'))
  expect(io.submitted[1]?.context).toBe(undefined)
  // Another plugin answered a compaction with a summary: the conversation no longer carries the block.
  io.api.length = 0
  await $.prompt.submit(typed('Publish it once more'))
  expect(io.submitted[2]?.context?.[0]).toContain('name="deploy"')
})
