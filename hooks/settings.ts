// The judgment layer's settings: the plugin's userConfig fields beside the
// fold policy's (those are read by settingsFrom in fold.ts).

export type Mode = 'off' | 'shadow' | 'active'

export type HarnessSettings = {
  stopGate: Mode
  toolGate: Mode
  stopThreshold: number
  timeoutMs: number
  stopCap: number
  toolJev: Mode
  toolThreshold: number
  toolCap: number
  providerTrust: 'auto' | 'external'
  trustedProxies: string[]
  apiKey: unknown
  instructions: Mode
  fragmentsDir: string
  instructionThreshold: number
  instructionCap: number
  foldJev: 'off' | 'shadow'
  foldCap: number
}

const modeOf = (value: unknown): Mode => (value === 'shadow' || value === 'active' ? value : 'off')
const numberOf = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function harnessSettingsFrom(options: Readonly<Record<string, unknown>>): HarnessSettings {
  return {
    stopGate: modeOf(options.stopGate),
    toolGate: modeOf(options.toolGate),
    stopThreshold: numberOf(options.stopThreshold, 0.7, 0, 1),
    timeoutMs: numberOf(options.timeoutMs, 2000, 200, 8000),
    stopCap: numberOf(options.stopCap, 200, 0, 10_000),
    toolJev: modeOf(options.toolJev),
    toolThreshold: numberOf(options.toolThreshold, 0.8, 0, 1),
    toolCap: numberOf(options.toolCap, 300, 0, 10_000),
    providerTrust: options.providerTrust === 'external' ? 'external' : 'auto',
    trustedProxies:
      typeof options.trustedProxies === 'string'
        ? options.trustedProxies
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean)
        : [],
    apiKey: options.apiKey,
    instructions: modeOf(options.instructions),
    fragmentsDir: typeof options.fragmentsDir === 'string' && options.fragmentsDir.trim() !== '' ? options.fragmentsDir : '~/.agents/fragments',
    instructionThreshold: numberOf(options.instructionThreshold, 0.95, 0, 1),
    instructionCap: numberOf(options.instructionCap, 200, 0, 10_000),
    foldJev: options.foldJev === 'shadow' ? 'shadow' : 'off',
    foldCap: numberOf(options.foldCap, 20, 0, 1000),
  }
}

/** Whether a setting can send anything to Jev; only then is a key looked up. */
export function usesJev(settings: HarnessSettings): boolean {
  return settings.stopGate !== 'off' || settings.toolJev !== 'off' || settings.instructions !== 'off' || settings.foldJev !== 'off'
}
