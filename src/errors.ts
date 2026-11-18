/** Stable Computer Use failure codes returned across provider and Tool boundaries. */
export type ComputerUseErrorCode =
  | 'COMPUTER_UNSUPPORTED_PLATFORM'
  | 'COMPUTER_PERMISSION_REQUIRED'
  | 'COMPUTER_APP_NOT_FOUND'
  | 'COMPUTER_STALE_OBSERVATION'
  | 'COMPUTER_ELEMENT_UNAVAILABLE'
  | 'COMPUTER_TARGET_UNAVAILABLE'
  | 'COMPUTER_TARGET_AMBIGUOUS'
  | 'COMPUTER_TARGET_LOW_CONFIDENCE'
  | 'COMPUTER_TARGET_REBIND_REQUIRES_CONFIRMATION'
  | 'COMPUTER_CONFIRMATION_REQUIRED'
  | 'COMPUTER_ACTION_BLOCKED'
  | 'COMPUTER_TIMEOUT'
  | 'COMPUTER_CANCELLED'
  | 'COMPUTER_PROVIDER_FAILURE'

/** Error with a stable model-visible code and bounded public details. */
export class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode

  /**
   * @param code - Stable failure category.
   * @param message - Bounded correction-oriented description without UI secrets.
   * @param options - Optional original cause retained outside the model-facing message.
   */
  constructor(code: ComputerUseErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'ComputerUseError'
    this.code = code
  }
}

/** Context used when translating cancellation from an AbortSignal or native AbortError. */
export interface ComputerUseErrorOptions {
  signal?: AbortSignal
  /** The provider call may have emitted input before cancellation was observed. */
  actionMayHaveExecuted?: boolean
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ABORT_ERR'
}

/** Convert an unknown failure into a stable model-visible category without leaking unbounded native text. */
export function computerUseError(error: unknown, fallback: string, options: ComputerUseErrorOptions = {}): ComputerUseError {
  const cancelled = error instanceof ComputerUseError
    ? error.code === 'COMPUTER_CANCELLED'
    : options.signal?.aborted === true || isAbortError(error)
  if (error instanceof ComputerUseError && (!cancelled || options.actionMayHaveExecuted !== true)) return error
  if (cancelled) {
    const executed = options.actionMayHaveExecuted === true
      ? '; the action may already have executed; observe the current state before retrying'
      : ''
    return new ComputerUseError('COMPUTER_CANCELLED', `${fallback} was cancelled${executed}`, { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `${fallback}: ${message.slice(0, 1000)}`, { cause: error })
}
