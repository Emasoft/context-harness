// The Jev key, from the first source that has one, and the provider it is for.
// Never logged or shown.
import type { JevProviderName } from './jev'

export type KeySource = 'config' | 'dotenv' | 'env'

/** auto: a TypeSafe key if there is one, else an OpenRouter key. A named provider uses only its own key. */
export type ProviderChoice = 'auto' | JevProviderName

export type JevKey = { key: string; source: KeySource; provider: JevProviderName }

export type KeySources = { config?: unknown; dotenv?: string; env?: string }

/** The environment variable, and .env line, each provider's key is read from. */
export const KEY_VARIABLES: Readonly<Record<JevProviderName, string>> = { typesafe: 'TYPESAFE_API_KEY', openrouter: 'OPENROUTER_API_KEY' }

/** The value of the `variable` line of a .env text; other lines are ignored. */
export function keyFromDotenv(text: string, variable: string): string | undefined {
  // Unescaped: `variable` is always one of KEY_VARIABLES, letters and underscores only.
  const pattern = new RegExp(`^(?:export\\s+)?${variable}\\s*=\\s*(.*)$`)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const match = pattern.exec(line)
    if (match === null) continue
    let value = match[1]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (value !== '') return value
  }

  return undefined
}

/** The first key found, in order: the plugin's sensitive setting, its .env's `variable` line, the environment. */
export function pickKey(sources: KeySources, variable: string): { key: string; source: KeySource } | undefined {
  if (typeof sources.config === 'string' && sources.config.trim() !== '') return { key: sources.config.trim(), source: 'config' }
  const fromFile = sources.dotenv === undefined ? undefined : keyFromDotenv(sources.dotenv, variable)
  if (fromFile !== undefined) return { key: fromFile, source: 'dotenv' }
  if (typeof sources.env === 'string' && sources.env.trim() !== '') return { key: sources.env.trim(), source: 'env' }

  return undefined
}

/**
 * The key for the chosen provider. Under auto a TypeSafe key wins over an
 * OpenRouter one, so a setup that worked before OpenRouter was added sends to
 * the same place. A named provider without its own key has no key: it never
 * falls back to the other provider, which would send to a host not chosen.
 */
export function pickProviderKey(choice: ProviderChoice, sources: Readonly<Record<JevProviderName, KeySources>>): JevKey | undefined {
  const order: readonly JevProviderName[] = choice === 'auto' ? ['typesafe', 'openrouter'] : [choice]
  for (const provider of order) {
    const found = pickKey(sources[provider], KEY_VARIABLES[provider])
    if (found !== undefined) return { ...found, provider }
  }

  return undefined
}
