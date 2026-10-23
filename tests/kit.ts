// One stub of everything the plugin asks the engine, shared by the hook tests.
import type { HttpResponse, SessionMessage } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

export type On = Parameters<TestBody>[1]
// The test runtime has timers; the type library the mod is checked with does not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown

export const HOME = '/home/me'
export const KEY_ENV = { TYPESAFE_API_KEY: 'tk-env' }
export const OPENROUTER_ENV = { OPENROUTER_API_KEY: 'or-env' }

export type Setup = {
  env?: Record<string, string>
  files?: Record<string, string>
  /** mtimeMs of files and folders, for fs.stat and fs.list; 0 otherwise. */
  mtimes?: Record<string, number>
  fetch?: (body: Record<string, unknown>) => HttpResponse | Promise<HttpResponse>
  isAuthorized?: boolean
  realPaths?: Record<string, string>
  cwdFails?: boolean
  /** A timer that never fires, so only the Jev answer can settle the race. */
  isTimerStopped?: boolean
  /** What the settings Stop hooks beneath the plugin answer. */
  stopBelow?: { block?: string }
  /** The transcript $.session.messages() returns. */
  messages?: SessionMessage[]
  /** How full the context window is, in percent, and its size in tokens. */
  percent?: number
  window?: number
  /** What the engine's own compaction beneath answers: a summary, or a skip. */
  compactBelow?: 'summary' | 'skip'
  /** The plugin folder's .env, wherever the plugin root is. */
  dotenv?: string
  /** A command that exits 1 when run, by its first word. */
  failRun?: string
  /** Writes to paths holding this text are refused. */
  failWrite?: string
  /** Listing a folder whose path holds this text is refused. */
  failList?: string
  /** Prompts are queued behind a running turn: not in the conversation yet when the next one is judged. */
  isQueued?: boolean
}

type ApiMessage = { role: 'user' | 'assistant'; content: { type: string; text?: string }[] }

export const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

export const setup = (on: On, s: Setup = {}) => {
  const env: Record<string, string> = { HOME, ...s.env }
  const files: Record<string, string> = { ...s.files }
  const fetches: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const writes: { path: string; text: string }[] = []
  const runs: string[][] = []
  // What touched the disk, in order: `run <argv0>` and `write <path>`.
  const disk: string[] = []
  const store = new Map<string, unknown>()
  const statuses: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const appended: string[] = []
  const submitted: { text: string; context?: readonly string[] }[] = []
  const configured: [string, unknown][] = []
  const order: string[] = []
  const commands: string[] = []
  // The messages the next request is built from: what $.session.messages({ as: 'api' }) answers.
  const api: ApiMessage[] = []
  let now = 1_700_000_000_000
  const under = (dir: string): string[] => [...Object.keys(files), ...writes.map(w => w.path)].filter(p => p.startsWith(`${dir}/`))

  on('env.get', (_, e) => ({ value: env[e.name] }))
  const isDotenv = (path: string): boolean => s.dotenv !== undefined && path.endsWith('/.env') && !(path in files)
  on('fs.exists', (_, e) => ({ value: e.path in files || isDotenv(e.path) || writes.some(w => w.path === e.path) || under(e.path).length > 0 }))
  on('fs.list', (_, e) => {
    if (s.failList !== undefined && e.path.includes(s.failList)) return { deny: 'refused' }
    const names = new Set(under(e.path).map(p => p.slice(e.path.length + 1).split('/')[0]!))
    return {
      value: [...names].map(name => ({
        name,
        kind: under(`${e.path}/${name}`).length > 0 ? ('dir' as const) : ('file' as const),
        size: 1,
        mtimeMs: s.mtimes?.[`${e.path}/${name}`] ?? 0,
        isLink: false,
      })),
    }
  })
  on('fs.read', (_, e) => {
    const written = [...writes].reverse().find(w => w.path === e.path)
    if (written) return { value: written.text }
    if (isDotenv(e.path)) return { value: s.dotenv! }
    return e.path in files ? { value: files[e.path]! } : { deny: 'missing' }
  })
  on('fs.write', (_, e) => {
    if (s.failWrite !== undefined && e.path.includes(s.failWrite)) return { deny: 'refused' }
    writes.push({ path: e.path, text: e.text })
    disk.push(`write ${e.path}`)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const real = s.realPaths?.[e.path]
    if (real !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: real } }
    return e.path in files ? { value: { kind: 'file', size: 1, mtimeMs: s.mtimes?.[e.path] ?? 0, isLink: false } } : { deny: 'missing' }
  })
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    disk.push(`run ${e.argv[0]}`)
    return { value: { exitCode: e.argv[0] === s.failRun ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.now', () => ({ value: (now += 5) }))
  on('clock.sleep', () => (s.isTimerStopped ? new Promise<never>(() => undefined) : { value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('http.fetch', async (_, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    fetches.push({ url: e.url, headers: { ...e.init?.headers }, body })
    order.push('jev')
    return { value: await (s.fetch ?? (() => ({ status: 500, ok: false, headers: {}, text: '' })))(body) }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: s.isAuthorized === false ? null : { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => (s.cwdFails ? { deny: 'no cwd' } : { value: '/proj' }))
  on('session.messages', (_, e) => ({ value: (e.as === 'api' ? api : (s.messages ?? [])) as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: s.window ?? 200_000, percent: s.percent ?? 10 }, rateLimits: [] } as never }))
  on('session.append', (_, e, next) => {
    appended.push(JSON.stringify(e.message))
    return next(e)
  })
  on('ui.status', (_, e) => {
    if (e.text !== undefined) statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.run', (_, e) => {
    commands.push(e.command)
    return { value: undefined } as never
  })
  on('config.set', (_, e) => {
    configured.push([e.key, e.value])
    return { value: e.value }
  })
  // What sits beneath the plugin: the engine's own behaviour and the settings hooks.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context })
    if (!s.isQueued) api.push({ role: 'user', content: [{ type: 'text', text: e.text }, ...(e.context ?? []).map(text => ({ type: 'text', text }))] })
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are helpful.', scope: 'shared' as const }] }))
  // A summary replaces what the next request is built from; a compaction the plugin answers never gets here.
  on('session.compact', () => {
    if (s.compactBelow === 'skip') return { skip: 'skipped below' } as never
    api.length = 0
    api.push({ role: 'user', content: [{ type: 'text', text: 'summary' }] })
    return { messages: [prompt('summary')] }
  })
  on('classic.PostCompact', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => s.stopBelow ?? {})
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => {
    order.push('tool')
    return { result: 'ok' }
  })

  return { env, files, fetches, writes, runs, disk, store, statuses, toasts, logs, appended, submitted, configured, order, api, commands }
}

export const records = (writes: readonly { path: string; text: string }[], point: string) =>
  writes.filter(w => w.path.includes('/records/') && w.path.includes(`/${point}/`)).map(w => JSON.parse(w.text) as Record<string, unknown>)

export const settle = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
}

/** Lets fire-and-forget work run to its end. */
export const drain = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
}
