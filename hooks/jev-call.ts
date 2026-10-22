// Calling Jev: the key, who serves the session, one bounded call, and the
// per-point budget around it.
import type { EngineInterface } from 'claude-code'
import { admit, afterCall, readBudget } from './budget'
import { JEV_ENDPOINT, parseResponse, requestBody, type JevFailure, type JevQuestion, type JevResult } from './jev'
import { pickKey } from './key'
import { runtime, settingsOf } from './state'
import { decideTrust, type Trust } from './tool-gate'

/** The key from the first source that has one: sensitive setting, the plugin's .env, the environment. */
export async function resolveKey($: EngineInterface, configured: unknown): Promise<{ key: string; source: string } | undefined> {
  const dotenvPath = `${$.plugin.root}/.env`
  const dotenv = (await $.fs.exists(dotenvPath)) ? await $.fs.read(dotenvPath) : undefined

  return pickKey({ config: configured, dotenv: typeof dotenv === 'string' ? dotenv : undefined, env: await $.env.get('TYPESAFE_API_KEY') })
}

/** Who serves the session: first-party only when every sign agrees. */
export async function resolveTrust($: EngineInterface, override: 'auto' | 'external', trustedProxies: readonly string[]): Promise<{ trust: Trust; why: string }> {
  const proxies = [await $.env.get('HTTPS_PROXY'), await $.env.get('https_proxy'), await $.env.get('HTTP_PROXY'), await $.env.get('http_proxy')]
  const thirdParty = [
    ['CLAUDE_CODE_USE_BEDROCK', await $.env.get('CLAUDE_CODE_USE_BEDROCK')],
    ['CLAUDE_CODE_USE_VERTEX', await $.env.get('CLAUDE_CODE_USE_VERTEX')],
    ['CLAUDE_CODE_USE_FOUNDRY', await $.env.get('CLAUDE_CODE_USE_FOUNDRY')],
  ]

  return decideTrust({
    isAuthorized: (await $.session.authorize()) !== null,
    baseUrl: await $.env.get('ANTHROPIC_BASE_URL'),
    proxies: proxies.filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
    caCerts: await $.env.get('NODE_EXTRA_CA_CERTS'),
    thirdParty: thirdParty.filter(([, v]) => typeof v === 'string' && v !== '' && v !== '0').map(([name]) => name as string),
    override,
    trustedProxies,
  })
}

export async function keyFor($: EngineInterface): Promise<{ key: string; source: string } | undefined> {
  if (runtime.key === undefined) runtime.key = (await resolveKey($, settingsOf().apiKey)) ?? null

  return runtime.key ?? undefined
}

export async function trustFor($: EngineInterface): Promise<{ trust: Trust; why: string }> {
  const settings = settingsOf()
  if (runtime.trust === undefined) runtime.trust = await resolveTrust($, settings.providerTrust, settings.trustedProxies)

  return runtime.trust
}

/** One Jev call, raced against a timer; never throws. */
export async function askJev(
  $: EngineInterface,
  key: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs: number,
): Promise<JevResult> {
  const started = await $.clock.now()
  const request = $.http
    .fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: requestBody(state, questions),
    })
    .then(
      response => ({ response }),
      () => ({ response: undefined }),
    )
  // A late answer is dropped: whichever settles first decides.
  const timer = $.clock.sleep(timeoutMs).then(() => 'timeout' as const)
  const winner = await Promise.race([request, timer])
  const ms = (await $.clock.now()) - started
  if (winner === 'timeout') return { ok: false, kind: 'timeout', ms }
  const { response } = winner
  if (response === undefined) return { ok: false, kind: 'network', ms }
  if (!response.ok) return { ok: false, kind: 'http', status: response.status, ms }
  const parsed = parseResponse(response.text, questions)

  return parsed.ok ? { ...parsed, ms } : { ok: false, kind: 'invalid', ms }
}

/** A Jev call within the point's session budget and circuit. */
export async function judge(
  $: EngineInterface,
  budget: { sessionId: string; point: string; cap: number },
  key: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs: number,
): Promise<JevResult> {
  const storeKey = `budget:${budget.sessionId}:${budget.point}`
  const before = readBudget(await $.store.get(storeKey))
  const gate = admit(before, budget.cap, await $.clock.now())
  if (gate !== 'ok') return { ok: false, kind: gate, ms: 0 }
  const result = await askJev($, key, state, questions, timeoutMs)
  await $.store.set(storeKey, afterCall(before, result.ok, await $.clock.now()))

  return result
}

/** A failed call as a record stores it. */
export function errorOf(result: JevResult | undefined): JevFailure | `http ${number}` | undefined {
  if (result === undefined || result.ok) return undefined

  return result.kind === 'http' ? `http ${result.status ?? 0}` : result.kind
}
