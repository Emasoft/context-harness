// As installed: every Jev setting at its manifest default. A key in every
// source must still send nothing and record no judgment, whichever hook runs.
import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { KEY_ENV, drain, prompt, setup } from './kit'

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x\n'.repeat(1500)
const FOLDABLE: SessionMessage[] = [
  prompt('Look at the parser'),
  call('a', 'Read', { file_path: '/proj/a.ts' }),
  answer('a', BIG),
  call('b', 'Bash', { command: 'npm test' }),
  answer('b', BIG),
  prompt('next'),
  prompt('Publish the release and write a report'),
]
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

// Only the key is set; every mode is the manifest's.
test('defaults: a key in every source, every hook run, nothing sent and no judgment recorded', { options: { apiKey: 'tk-config' } }, async ($, on) => {
  const io = setup(on, {
    env: KEY_ENV,
    dotenv: 'TYPESAFE_API_KEY=tk-dotenv\n',
    messages: FOLDABLE,
    percent: 70,
    files: { '/home/me/.agents/fragments/prose.md': '---\nwhen: The person asks for prose.\nkeywords: report\n---\nWrite plainly.\n' },
  })
  await $.session.start(START)
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as never)
  await $.prompt.submit(typed('Publish the release and write a report'))
  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })
  await $.tool.call({ tool: 'Bash', command: 'printenv' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.ts' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.compact({ trigger: 'manual', messages: FOLDABLE } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  const report = await $.command.run({ command: 'jev-report', args: '' } as never)
  await drain()

  expect(io.fetches.length).toBe(0)
  expect(io.writes.filter(w => w.path.includes('/records/'))).toEqual([])
  // The modes the engine filled in from the manifest.
  expect(report.text).toContain('context-harness: stop off, tool off, tool jev off, instructions off, fold off')
  // The fragment was not attached: instructions are off.
  expect(io.submitted[0]?.context).toBe(undefined)
  // Folding needs no key and is on by default.
  expect(io.writes.some(w => w.path.includes('/archive/'))).toBe(true)
})
