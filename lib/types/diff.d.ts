/** Accessibility-tree diff projection for model-context efficiency. */
import type { ComputerElement } from './types.ts';
/** Render only as many diff rows as fit in the model's UTF-8 text budget. */
export declare function projectElementDiff(previous: readonly ComputerElement[], current: readonly ComputerElement[], maxBytes: number): {
    text: string;
    truncated: boolean;
};
/** Return the text projection for callers that only consume the rendered diff. */
export declare function diffElements(previous: readonly ComputerElement[], current: readonly ComputerElement[], maxBytes: number): string;
//# sourceMappingURL=diff.d.ts.map