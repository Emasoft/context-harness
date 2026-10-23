import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { STOP_MESSAGE } from '../hooks/stop-gate'
import { HOME, KEY_ENV, OPENROUTER_ENV, records, settle, setup as kitSetup, type On, type Setup } from './kit'

const ANNOUNCE = (p: number): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: { stop: { type: 'choice', choice: p >= 0.5 ? 'announce' : 'report', confidence: 0.98, probabilities: { announce: p, report: 1 - p } } },
    usage: { input_tokens: 373, output_tokens: 31 },
  }),
})

const DATA = (choice: string, probabilities: Record<string, number>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ model: 'jev-1.14.0', answers: { data: { type: 'choice', choice, confidence: 0.9, probabilities } }, usage: { input_tokens: 300, output_tokens: 30 } }),
})
const RESTRICTED = DATA('restricted', { open: 0.01, standard: 0.04, restricted: 0.9, custom: 0.05 })
const STANDARD = DATA('standard', { open: 0.1, standard: 0.85, restricted: 0.03, custom: 0.02 })

// Jev says "announce" unless a test answers otherwise.
const setup = (on: On, s: Setup = {}) => kitSetup(on, { fetch: () => ANNOUNCE(0.99), ...s })

const STOP = { stop_hook_active: false, last_assistant_message: '파서를 고쳤습니다.\n\n문의는 a@b.co 로 받습니다. 이어서 캐시를 리팩터링하겠습니다.' }

test('off by default: a key alone sends nothing', async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  const result = await $.classic.Stop(STOP)
  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })

  expect(result.block).toBe(undefined)
  expect(io.fetches.length).toBe(0)
  expect(io.writes.length).toBe(0)
})

test('shadow: the turn ends at once and the judgment is recorded afterwards, scrubbed', { options: { stopGate: 'shadow' } }, async ($, on) => {
  let release: (r: HttpResponse) => void = () => undefined
  const io = setup(on, { env: KEY_ENV, isTimerStopped: true, fetch: () => new Promise<HttpResponse>(resolve => (release = resolve)) })

  const started = Date.now()
  const result = await $.classic.Stop(STOP)
  expect(Date.now() - started < 1000).toBe(true)
  expect(result.block).toBe(undefined)
  expect(io.writes.length).toBe(0)

  // The judgment runs after the hook returned; answer it once it has asked.
  await settle(() => io.fetches.length > 0)
  release(ANNOUNCE(0.99))
  await settle(() => records(io.writes, 'stop').length > 0)
  const [record] = records(io.writes, 'stop')
  expect(record?.decision).toBe('would-continue')
  expect(record?.heuristic).toBe(true)
  expect(record?.jev).toBe(0.99)
  expect(JSON.stringify(record?.sent)).not.toContain('a@b.co')
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer tk-env')
})

test('active: an announcing turn is sent back to work; a report ends', { options: { stopGate: 'active' } }, async ($, on) => {
  let p = 0.99
  setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE(p) })
  expect((await $.classic.Stop(STOP)).block).toBe(STOP_MESSAGE)
  p = 0.01
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
})

test('active: a Jev call that does not answer in time changes nothing', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => new Promise<HttpResponse>(() => undefined) })
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('timeout')
})

test('a block from the settings Stop hooks beneath wins, and Jev is not asked', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, stopBelow: { block: 'budget guard' } })
  expect((await $.classic.Stop(STOP)).block).toBe('budget guard')
  expect(io.fetches.length).toBe(0)
})

test('plan mode, background work and re-entry are not judged', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop({ ...STOP, stop_hook_active: true })
  await $.classic.Stop({ ...STOP, permission_mode: 'plan' })
  await $.classic.Stop({ ...STOP, background_tasks: [{ id: 't', type: 'bash', status: 'running', description: 'x' }] as never })
  await settle(() => records(io.writes, 'stop').length >= 3)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'stop').map(r => r.skipped)).toEqual(['stop-hook-active', 'plan-mode', 'background-tasks'])
})

test('without a key nothing is sent and the status says so', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('no-key')
  expect(io.statuses).toContain('jev: no key')
})

test('the sensitive setting outranks the plugin .env, which outranks the environment', { options: { stopGate: 'active', apiKey: 'tk-config' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer tk-config')
})

// The body OpenRouter returned on 2026-10-23, with the probability the test needs.
const OPENROUTER_ANNOUNCE = (p: number): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'typesafe/jev-1.14-20261014',
    answers: { stop: { type: 'choice', choice: p >= 0.5 ? 'announce' : 'report', probabilities: { announce: p, report: 1 - p }, confidence: 0.98 } },
    usage: { input_tokens: 358, output_tokens: 31, cost: 0.000015036 },
    id: 'gen-dec-1792735010-KGzgwzUcDEhNKPkR7Hiq',
    provider: 'TypeSafe',
  }),
})

test('OpenRouter: with only its key, Jev is asked at its decisions endpoint with its model id', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: OPENROUTER_ENV, fetch: () => OPENROUTER_ANNOUNCE(0.99) })
  expect((await $.classic.Stop(STOP)).block).toBe(STOP_MESSAGE)
  expect(io.fetches.length).toBe(1)
  const [sent] = io.fetches
  expect(sent?.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(sent?.headers.authorization).toBe('Bearer or-env')
  expect(sent?.headers['content-type']).toBe('application/json')
  expect(sent?.body.model).toBe('~typesafe/jev-latest')
  expect(Object.keys(sent?.body.questions as object)).toEqual(['stop'])
  expect(JSON.stringify(sent?.body.state)).not.toContain('a@b.co')
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(records(io.writes, 'stop')[0]?.jev).toBe(0.99)
})

test('OpenRouter: the sensitive setting outranks the plugin .env, which outranks the environment', { options: { stopGate: 'active', openrouterApiKey: 'or-config' } }, async ($, on) => {
  const io = setup(on, { env: OPENROUTER_ENV, dotenv: 'OPENROUTER_API_KEY=or-dotenv\n', fetch: () => OPENROUTER_ANNOUNCE(0.99) })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer or-config')
})

test('OpenRouter: without the setting, the plugin .env line outranks the environment', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: OPENROUTER_ENV, dotenv: 'OPENROUTER_API_KEY=or-dotenv\n', fetch: () => OPENROUTER_ANNOUNCE(0.99) })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer or-dotenv')
})

test('auto: with both keys TypeSafe is asked, as before OpenRouter was added', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: { ...KEY_ENV, ...OPENROUTER_ENV } })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer tk-env')
  expect(io.fetches[0]?.body.model).toBe('jev-latest')
})

test('jevProvider openrouter: with both keys OpenRouter is asked', { options: { stopGate: 'active', jevProvider: 'openrouter' } }, async ($, on) => {
  const io = setup(on, { env: { ...KEY_ENV, ...OPENROUTER_ENV }, fetch: () => OPENROUTER_ANNOUNCE(0.99) })
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer or-env')
})

test('jevProvider openrouter with only a TypeSafe key sends nothing and says no key', { options: { stopGate: 'shadow', jevProvider: 'openrouter' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('no-key')
  expect(io.statuses).toContain('jev: no key')
})

test('OpenRouter: a 403 (a key or account state) ends the turn and is recorded as http 403', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: OPENROUTER_ENV, fetch: () => ({ status: 403, ok: false, headers: {}, text: '{"error":{"code":403,"message":"forbidden"}}' }) })
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(records(io.writes, 'stop')[0]?.error).toBe('http 403')
})

test('the call cap and the circuit stop sending', { options: { stopGate: 'active', stopCap: 1 } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.classic.Stop(STOP)
  await $.classic.Stop(STOP)
  expect(io.fetches.length).toBe(1)
  await settle(() => records(io.writes, 'stop').length >= 2)
  expect(records(io.writes, 'stop')[1]?.error).toBe('cap')
})

test('three failed calls open the circuit', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  for (let i = 0; i < 4; i++) await $.classic.Stop(STOP)
  expect(io.fetches.length).toBe(3)
})

test('tool gate, external provider: secret files and secret-printing commands are refused', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Read', file_path: '~/.oh-my-zsh/custom/apikey.env' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Bash', command: 'git diff --no-index /dev/null .ENV' })).deny).toContain('env file')
  expect((await $.tool.call({ tool: 'Bash', command: 'printenv | sort' })).deny).toContain('printenv')
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls -la' })).deny).toBe(undefined)
  expect(io.fetches.length).toBe(0)
})

test('tool gate follows symlinks to what they name', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on, { realPaths: { '/proj/notes.txt': `${HOME}/.ssh/id_rsa` } })
  const denied = (await $.tool.call({ tool: 'Read', file_path: 'notes.txt' })).deny
  expect(denied).toContain('ssh')
  expect(denied).toContain('/proj/notes.txt -> ~/.ssh/id_rsa')
})

test('tool gate, first-party session: secret files pass and are recorded', { options: { toolGate: 'active' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toBe(undefined)
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('allow')
})

test('tool gate shadow only records what it would refuse', { options: { toolGate: 'shadow', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toBe(undefined)
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('would-deny')
})

test('the agent may not rewrite the plugin or the Claude settings, even first-party', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude-3/settings.json`, content: '{}' })).deny).toContain('claude settings')
  expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${HOME}/.local/state/context-harness/a.json` })).deny).toContain('context-harness files')
})

test('an active tool guard that breaks refuses the call', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on, { cwdFails: true })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/a.txt' })).deny).toContain('guard failed')
})

test('a shadow tool guard that breaks lets the call through', { options: { toolGate: 'shadow' } }, async ($, on) => {
  setup(on, { cwdFails: true })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/a.txt' })).deny).toBe(undefined)
})

test('/jev-mark writes a label and /jev-report reads records and labels', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  const root = `${HOME}/.local/state/context-harness/records`
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  const id = String(records(io.writes, 'stop')[0]?.id)

  expect((await $.command.run({ command: 'jev-mark', args: `${id} y` } as never)).text).toContain('positive')
  expect(io.writes.some(w => w.path === `${root}/labels/labels/${id}.json`)).toBe(true)
  const report = (await $.command.run({ command: 'jev-report', args: '' } as never)).text ?? ''
  expect(report).toContain('1 records, 1 labels')
  expect(report).toContain('labels 1 (positive 1, negative 0)')
  expect((await $.command.run({ command: 'jev-mark', args: 'bad' } as never)).text).toContain('Usage')
})

const EXTERNAL_JEV = { toolJev: 'shadow', providerTrust: 'external' }

test('tool jev, shadow: the tool runs first, then the path is judged and recorded', { options: EXTERNAL_JEV }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => STANDARD })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.py' })).deny).toBe(undefined)
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(io.order).toEqual(['tool', 'jev'])
  expect(io.fetches[0]?.body.state).toEqual({ tool: 'Read', target: './src/app.py' })
  const [record] = records(io.writes, 'tool')
  expect(record?.decision).toBe('allow')
  expect((record?.facts as Record<string, string>).class).toBe('standard')
})

test('tool jev sends nothing in a first-party session', { options: { toolJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.py' })
  expect(io.fetches.length).toBe(0)
})

test('a path the floor names is never sent to Jev, even with the floor off', { options: EXTERNAL_JEV }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).deny).toBe(undefined)
  expect(io.fetches.length).toBe(0)
})

test('tool jev, active: a restricted judgment refuses, a standard one passes', { options: { toolJev: 'active', providerTrust: 'external' } }, async ($, on) => {
  let answer = RESTRICTED
  setup(on, { env: KEY_ENV, fetch: () => answer })
  const denied = (await $.tool.call({ tool: 'Read', file_path: '/proj/config/settings.yml' })).deny
  expect(denied).toContain('./config/settings.yml as restricted data (0.95)')
  answer = STANDARD
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.py' })).deny).toBe(undefined)
})

test('tool jev asks once per target in a session', { options: { toolJev: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => RESTRICTED })
  await $.tool.call({ tool: 'Read', file_path: '/proj/infra/prod.tfvars' })
  const second = await $.tool.call({ tool: 'Read', file_path: '/proj/infra/prod.tfvars' })
  expect(second.deny).toContain('restricted')
  expect(io.fetches.length).toBe(1)
})

test('tool jev, active: no answer in time lets the call through', { options: { toolJev: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on, { env: KEY_ENV, fetch: () => new Promise<HttpResponse>(() => undefined) })
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/config/settings.yml' })).deny).toBe(undefined)
})

test('tool jev shows a command relative to the working folder', { options: EXTERNAL_JEV }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => STANDARD })
  await $.tool.call({ tool: 'Bash', command: 'cat /proj/config/app.toml' })
  await settle(() => io.fetches.length > 0)
  expect(io.fetches[0]?.body.state).toEqual({ tool: 'Bash', target: 'cat ./config/app.toml' })
})
