import { describe, expect, it, vi } from 'vitest'
import { configOf, draftOf, type ConfigValue } from '../src/client/index.tsx'
import { resolveConfig } from '../src/config.ts'

// Exercise the actual form codec without loading browser-only UI dependencies.
vi.mock('react', () => ({ useEffect: vi.fn(), useState: vi.fn(), useSyncExternalStore: vi.fn() }))
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: vi.fn() }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Input: () => null }))

const translate = (key: string): string => key
const bundleId = 'com.example.Editor'

describe('Computer Use settings grant codec', () => {
  it.each([
    [{ read: false, control: false }, 'none', { read: false, control: false }],
    [{ read: true, control: false }, 'read', { read: true, control: false }],
    [{ read: true, control: true }, 'read,control', { read: true, control: true }],
    [{ read: false, control: true }, 'read,control', { read: true, control: true }],
    [{}, 'none', { read: false, control: false }],
    [{ read: false }, 'none', { read: false, control: false }],
    [{ control: false }, 'none', { read: false, control: false }],
    [{ read: true }, 'read', { read: true, control: false }],
    [{ control: true }, 'read,control', { read: true, control: true }],
  ] as const)('round-trips grant flags %o without escalating effective access', (flags, scopes, expected) => {
    const value: ConfigValue = { allowAllApps: false, grants: [{ bundleId, ...flags }] }
    const draft = draftOf(value)
    expect(draft.grants).toBe(`${bundleId} ${scopes}`)
    const saved = configOf(draft, translate)
    expect(saved.grants).toEqual([{ bundleId, ...expected }])
    expect(saved.allowAllApps).toBe(false)
    expect(resolveConfig(saved).grants).toEqual(resolveConfig(value).grants)
  })

  it('preserves disabled entries when saving an unrelated setting', () => {
    const grants = [
      { bundleId: 'com.example.Disabled', read: false, control: false },
      { bundleId: 'com.example.Reader', read: true, control: false },
      { bundleId: 'com.example.Controller', read: true, control: true },
    ]
    const draft = draftOf({ grants, allowAllApps: false })
    draft.cursorClickDelayMs = '120'
    const saved = configOf(draft, translate)
    expect(saved.grants).toEqual(grants)
    expect(saved.interaction?.cursorClickDelayMs).toBe(120)
    expect(resolveConfig(saved).grants).toEqual(grants)
  })

  it('accepts CRLF, blank lines, none, and legacy control shorthand', () => {
    const draft = draftOf({})
    draft.grants = '  com.example.Disabled none  \r\n\r\ncom.example.Reader read\r\n com.example.Controller\tcontrol \r\n'
    expect(configOf(draft, translate).grants).toEqual([
      { bundleId: 'com.example.Disabled', read: false, control: false },
      { bundleId: 'com.example.Reader', read: true, control: false },
      { bundleId: 'com.example.Controller', read: true, control: true },
    ])
  })

  it.each(['none,read', 'read,none', 'none,control', 'control,none', 'none,read,control', 'write', 'READ', 'read,', ',none'])
    ('rejects conflicting or unknown grant scopes %s', (scopes) => {
      const draft = draftOf({})
      draft.grants = `${bundleId} ${scopes}`
      expect(() => configOf(draft, translate)).toThrow('invalid grant scope')
    })

  it.each([bundleId, `${bundleId} read extra`])('rejects malformed grant line %s', (line) => {
    const draft = draftOf({})
    draft.grants = line
    expect(() => configOf(draft, translate)).toThrow('invalid grant line')
  })

  it('does not synthesize grants for an empty form', () => {
    const draft = draftOf({})
    expect(draft.grants).toBe('')
    expect(configOf(draft, translate).grants).toEqual([])
  })
})
