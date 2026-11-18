/** Error with a stable model-visible code and bounded public details. */
export class ComputerUseError extends Error {
    code;
    /**
     * @param code - Stable failure category.
     * @param message - Bounded correction-oriented description without UI secrets.
     * @param options - Optional original cause retained outside the model-facing message.
     */
    constructor(code, message, options) {
        super(`${code}: ${message}`, options);
        this.name = 'ComputerUseError';
        this.code = code;
    }
}
function isAbortError(error) {
    if (error instanceof Error && error.name === 'AbortError')
        return true;
    return typeof error === 'object' && error !== null && error.code === 'ABORT_ERR';
}
/** Convert an unknown failure into a stable model-visible category without leaking unbounded native text. */
export function computerUseError(error, fallback, options = {}) {
    const cancelled = error instanceof ComputerUseError
        ? error.code === 'COMPUTER_CANCELLED'
        : options.signal?.aborted === true || isAbortError(error);
    if (error instanceof ComputerUseError && (!cancelled || options.actionMayHaveExecuted !== true))
        return error;
    if (cancelled) {
        const executed = options.actionMayHaveExecuted === true
            ? '; the action may already have executed; observe the current state before retrying'
            : '';
        return new ComputerUseError('COMPUTER_CANCELLED', `${fallback} was cancelled${executed}`, { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `${fallback}: ${message.slice(0, 1000)}`, { cause: error });
}
//# sourceMappingURL=errors.js.map