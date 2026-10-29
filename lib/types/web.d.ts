/** Optional Web Settings and provider-health route. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { type ComputerUseConfig } from './config.ts';
import type { ComputerUseStatus } from './types.ts';
import type { UpdateStatus } from './update.ts';
/** Exact same-origin Settings endpoint. */
export declare const COMPUTER_USE_SETTINGS_ROUTE = "/_dsh/computer-use/settings";
/** Browser-safe Settings snapshot. */
export interface ComputerUseSettingsSnapshot {
    schemaVersion: 1;
    writable: boolean;
    settings: {
        value: ComputerUseConfig;
        user?: unknown;
        base?: unknown;
        revision: number;
        applies: 'live';
    };
    provider: ComputerUseStatus;
    update?: UpdateStatus;
}
/** Same-origin backend used by the optional client Settings section. */
export interface ComputerUseUpdateControl {
    status(): UpdateStatus;
    check(): Promise<UpdateStatus>;
    apply(): Promise<UpdateStatus>;
}
export declare class ComputerUseWebBackend {
    private readonly ctx;
    private readonly authorizeUnmarkedPost?;
    private readonly update?;
    constructor(ctx: Context, authorizeUnmarkedPost?: ((req: IncomingMessage) => boolean) | undefined, update?: ComputerUseUpdateControl | undefined);
    /** Current browser-safe Settings and health state. */
    snapshot(): ComputerUseSettingsSnapshot;
    /** Handle one Settings request. */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
/** Attach the optional route when a Web host is present. */
export declare function installComputerUseWeb(ctx: Context, update?: ComputerUseUpdateControl): void;
//# sourceMappingURL=web.d.ts.map