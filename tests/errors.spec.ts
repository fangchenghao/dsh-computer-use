import { describe, expect, it } from 'vitest'
import { ComputerUseError, computerUseError, type ComputerUseErrorCode } from '../src/errors.ts'

describe('computerUseError', () => {
  it.each([
    ['native AbortError', () => new DOMException('native private details', 'AbortError')],
    ['Error named AbortError', () => Object.assign(new Error('native private details'), { name: 'AbortError' })],
    ['Node ABORT_ERR', () => ({ code: 'ABORT_ERR', message: 'native private details' })],
  ] as const)('classifies %s as cancellation even without an aborted signal', (_name, createError) => {
    const cause = createError()
    const error = computerUseError(cause, 'Computer Use click')
    expect(error).toBeInstanceOf(ComputerUseError)
    expect(error).toMatchObject({
      code: 'COMPUTER_CANCELLED',
      cause,
      message: 'COMPUTER_CANCELLED: Computer Use click was cancelled',
    })
    expect(error.message).not.toContain('native private details')
    expect(error.message).not.toContain('may already have executed')
  })

  it.each([new Error('private caller reason'), 'private caller reason', undefined])(
    'classifies arbitrary aborted-signal reasons without leaking them: %s',
    cause => {
      const controller = new AbortController()
      controller.abort(cause)
      const error = computerUseError(cause, 'Computer Use click', { signal: controller.signal })
      expect(error).toMatchObject({
        code: 'COMPUTER_CANCELLED',
        message: 'COMPUTER_CANCELLED: Computer Use click was cancelled',
      })
      expect(error.cause).toBe(cause)
    },
  )

  it.each([
    new DOMException('interrupted', 'AbortError'),
    new ComputerUseError('COMPUTER_CANCELLED', 'provider stopped'),
  ])('adds an observe-before-retry warning only when input may have been sent: %s', cause => {
    const error = computerUseError(cause, 'Computer Use click', { actionMayHaveExecuted: true })
    expect(error).toMatchObject({ code: 'COMPUTER_CANCELLED', cause })
    expect(error.message).toContain('the action may already have executed')
    expect(error.message).toContain('observe the current state before retrying')
    expect(error).not.toBe(cause)
  })

  it('preserves an existing cancellation unchanged before provider dispatch', () => {
    const cause = new Error('internal cause')
    const error = new ComputerUseError('COMPUTER_CANCELLED', 'cancelled before input', { cause })
    expect(computerUseError(error, 'Computer Use click')).toBe(error)
    expect(computerUseError(error, 'Computer Use click', { actionMayHaveExecuted: false })).toBe(error)
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain('may already have executed')
  })

  const stableCodes: Exclude<ComputerUseErrorCode, 'COMPUTER_CANCELLED'>[] = [
    'COMPUTER_UNSUPPORTED_PLATFORM',
    'COMPUTER_PERMISSION_REQUIRED',
    'COMPUTER_APP_NOT_FOUND',
    'COMPUTER_STALE_OBSERVATION',
    'COMPUTER_ELEMENT_UNAVAILABLE',
    'COMPUTER_TARGET_UNAVAILABLE',
    'COMPUTER_TARGET_AMBIGUOUS',
    'COMPUTER_TARGET_LOW_CONFIDENCE',
    'COMPUTER_TARGET_REBIND_REQUIRES_CONFIRMATION',
    'COMPUTER_CONFIRMATION_REQUIRED',
    'COMPUTER_ACTION_BLOCKED',
    'COMPUTER_TIMEOUT',
    'COMPUTER_PROVIDER_FAILURE',
  ]

  it.each(stableCodes)('preserves %s and its cause even when cancellation races with the failure', code => {
    const controller = new AbortController()
    controller.abort()
    const cause = new Error('original cause')
    const error = new ComputerUseError(code, 'original correction', { cause })
    expect(computerUseError(error, 'Computer Use click')).toBe(error)
    expect(computerUseError(error, 'Computer Use click', {
      signal: controller.signal,
      actionMayHaveExecuted: true,
    })).toBe(error)
    expect(error.message).toBe(`${code}: original correction`)
    expect(error.cause).toBe(cause)
  })

  it.each([false, true])('keeps ordinary provider failures bounded when actionMayHaveExecuted=%s', actionMayHaveExecuted => {
    const cause = new Error('x'.repeat(1500))
    const error = computerUseError(cause, 'Computer Use click', {
      signal: new AbortController().signal,
      actionMayHaveExecuted,
    })
    expect(error).toMatchObject({
      code: 'COMPUTER_PROVIDER_FAILURE',
      cause,
      message: `COMPUTER_PROVIDER_FAILURE: Computer Use click: ${'x'.repeat(1000)}`,
    })
    expect(error.message).not.toContain('may already have executed')
  })

  it.each(['AbortError', { name: 'AbortError' }, { code: 'OTHER_ERR' }, new DOMException('deadline', 'TimeoutError')])(
    'does not mistake lookalike or timeout failures for native cancellation: %s',
    cause => {
      const error = computerUseError(cause, 'Computer Use click')
      expect(error.code).toBe('COMPUTER_PROVIDER_FAILURE')
      expect(error.cause).toBe(cause)
    },
  )
})
