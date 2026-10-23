// Everything the plugin keeps on disk, under one root only the user can enter:
//   ~/.local/state/context-harness/archive/<session>/<id>.json  folded originals, never deleted
//   ~/.local/state/context-harness/records/<session>/<point>/   judgment records, 14 days
//   ~/.local/state/context-harness/records/labels/labels/       labels, kept
//   ~/.local/state/context-harness/compact.log                  one line per compaction, the last 1000
// Folds made before the rename stay readable at ~/.claude-context-fold/<session>/.
import type { EngineInterface } from 'claude-code'
import type { Archived } from './fold'
import type { ShadowRecord } from './report'
import { madeDirs } from './state'

export const STATE_DIR = '.local/state/context-harness'
const LEGACY_ARCHIVE_DIR = '.claude-context-fold'

export function stateRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${STATE_DIR}`
}

export function legacyArchiveRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${LEGACY_ARCHIVE_DIR}`
}

export const fileId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The commands that drop judgment records older than 14 days. They name the
 * records folder alone, so archives and labels are never touched; any other
 * folder gets no command at all.
 */
export function cleanupArgs(recordsRoot: string): string[][] {
  if (!recordsRoot.endsWith(`/${STATE_DIR}/records`)) return []

  return [
    ['find', recordsRoot, '-type', 'f', '-name', '*.json', '-mtime', '+14', '-not', '-path', `${recordsRoot}/labels/*`, '-delete'],
    ['find', recordsRoot, '-mindepth', '1', '-type', 'd', '-empty', '-delete'],
  ]
}

/** The root and every folder below it down to `dir`; empty when `dir` is outside the root. */
export function dirsBetween(root: string, dir: string): string[] {
  if (dir !== root && !dir.startsWith(`${root}/`)) return []
  const parts = dir.slice(root.length).split('/').filter(Boolean)

  return [root, ...parts.map((_, i) => `${root}/${parts.slice(0, i + 1).join('/')}`)]
}

export async function homeOf($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home === undefined || home.trim() === '' ? undefined : home
}

/** The state root. Without HOME it throws, so nothing lands in the project folder instead. */
export async function rootOf($: EngineInterface): Promise<string> {
  const home = await homeOf($)
  if (home === undefined) throw new Error('HOME is not set')

  return stateRoot(home)
}

/** Makes `dir`, and every folder from the root down to it readable by the user alone, before anything is written there. */
export async function ensureDir($: EngineInterface, dir: string): Promise<void> {
  // Made earlier and still there: a folder removed since is made again, private.
  if (madeDirs.has(dir) && (await $.fs.exists(dir))) return
  madeDirs.delete(dir)
  const chain = dirsBetween(await rootOf($), dir)
  if (chain.length === 0) throw new Error(`${dir} is outside the state root`)
  for (const argv of [['mkdir', '-p', dir], ['chmod', '700', ...chain]]) {
    const { exitCode } = await $.process.run(argv)
    if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`)
  }
  madeDirs.add(dir)
}

export async function writeArchive($: EngineInterface, sessionId: string, archived: readonly Archived[]): Promise<void> {
  const dir = `${await rootOf($)}/archive/${sessionId}`
  await ensureDir($, dir)
  for (const item of archived) await $.fs.write(`${dir}/${fileId(item.id)}.json`, JSON.stringify(item))
}

/** What one session.compact dispatch was and what this plugin made of it. */
export type CompactLogEntry = {
  ts: string
  session: string
  trigger: string
  agentId?: string
  /** passed-subagent, passed-precompute, summarized-nothing-to-fold, summarized-archive-failed, folded, folded-then-summarized, engine-skipped, hook-failed; idle-fold-requested when the mod is about to run /compact itself. */
  outcome: string
  messages: number
  folded: number
  savedChars: number
  /** Estimates from the transcript's characters, before and after this plugin's fold. */
  estTokensBefore: number
  estTokensAfter?: number
  /** The engine's own counts, when its summary ran and recorded them: after a fold, tokensBefore measures the folded transcript. */
  tokensBefore?: number
  tokensAfter?: number
  skip?: string
}

export const COMPACT_LOG_LINES = 1000

/**
 * Adds one line to compact.log, keeping the last COMPACT_LOG_LINES. The file
 * API has no append, so the file is read and written whole; at a thousand
 * short lines that is cheap, and compactions are minutes apart.
 */
export async function logCompaction($: EngineInterface, entry: CompactLogEntry): Promise<void> {
  const root = await rootOf($)
  await ensureDir($, root)
  const path = `${root}/compact.log`
  const lines = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(line => line !== '') : []
  lines.push(JSON.stringify(entry))
  await $.fs.write(path, `${lines.slice(-COMPACT_LOG_LINES).join('\n')}\n`)
}

/** A folded original by its call id: this plugin's archive first, then the one kept before the rename. */
export async function readArchived($: EngineInterface, sessionId: string, id: string): Promise<Archived | undefined> {
  const home = await homeOf($)
  if (home === undefined || id === '') return undefined
  for (const dir of [`${stateRoot(home)}/archive/${sessionId}`, `${legacyArchiveRoot(home)}/${sessionId}`]) {
    const path = `${dir}/${fileId(id)}.json`
    if (await $.fs.exists(path)) return JSON.parse(await $.fs.read(path)) as Archived
  }

  return undefined
}

/** One record, one file. */
export async function writeRecord($: EngineInterface, record: ShadowRecord): Promise<void> {
  const dir = `${await rootOf($)}/records/${record.sessionId}/${record.point}`
  await ensureDir($, dir)
  await $.fs.write(`${dir}/${record.id}.json`, JSON.stringify(record))
}

export async function writeLabel($: EngineInterface, id: string, label: boolean, ts: string): Promise<void> {
  const dir = `${await rootOf($)}/records/labels/labels`
  await ensureDir($, dir)
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ id, label, ts }))
}

/** Every record, at most `limit`, and the labels. */
export async function readRecords($: EngineInterface, limit: number): Promise<{ records: ShadowRecord[]; labels: Map<string, boolean> }> {
  const root = `${await rootOf($)}/records`
  const records: ShadowRecord[] = []
  const labels = new Map<string, boolean>()
  if (!(await $.fs.exists(root))) return { records, labels }
  for (const session of await $.fs.list(root)) {
    if (session.kind !== 'dir') continue
    const sessionDir = `${root}/${session.name}`
    for (const point of await $.fs.list(sessionDir)) {
      if (point.kind !== 'dir') continue
      for (const file of await $.fs.list(`${sessionDir}/${point.name}`)) {
        if (records.length >= limit || !file.name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(await $.fs.read(`${sessionDir}/${point.name}/${file.name}`)) as ShadowRecord | { id: string; label: boolean }
          if (session.name === 'labels' && 'label' in parsed) labels.set(parsed.id, parsed.label)
          else records.push(parsed as ShadowRecord)
        } catch {
          // A partly written or foreign file is skipped.
        }
      }
    }
  }

  return { records, labels }
}

/** Drops judgment records older than 14 days. */
export async function cleanupRecords($: EngineInterface): Promise<void> {
  const home = await homeOf($)
  if (home === undefined) return
  const root = `${stateRoot(home)}/records`
  if (!(await $.fs.exists(root))) return
  for (const args of cleanupArgs(root)) await $.process.run(args)
}
