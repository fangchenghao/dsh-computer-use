/** DSH Computer Use model-facing consumer and progressive Skill bundle. */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ComputerUseBackend } from './backend.ts';
import { type ComputerUseConfig, type ResolvedComputerUseConfig } from './config.ts';
import { MacOSComputerUseProvider } from './providers/macos.ts';
import { type ComputerUseUpdateControl } from './web.ts';
export { Config } from './config.ts';
export * from './errors.ts';
export * from './service.ts';
export * from './types.ts';
/** Register the portable Skill, bootstrap, Agent-scoped Tools, and optional Web diagnostics. */
export declare function installComputerUseConsumer(ctx: Context, update?: ComputerUseUpdateControl): () => void;
/** macOS provider plus the portable Skill, scoped Tools, and optional Web diagnostics. */
export declare class ComputerUseBundle extends MacOSComputerUseProvider {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<ComputerUseConfig>;
    private consumerDispose;
    private updateControl;
    private updater;
    private readonly updateSettings;
    constructor(ctx: Context, config?: ComputerUseConfig);
    /** Publish model-facing capabilities only after provider integrity and health pass. */
    protected [Service.init](): Promise<void>;
    /**
     * Follow the published package: check the registry shortly after startup and
     * install newer patch releases into the profile that owns this module.
     */
    private startUpdater;
    /**
     * Keep the background updater in step with Settings. The provider rebuilds
     * its backend generation on every accepted Settings change, which is the
     * same lifecycle hook the backend itself uses.
     */
    protected reconfigure(backend: ComputerUseBackend, config: ResolvedComputerUseConfig): Promise<void>;
}
export default ComputerUseBundle;
//# sourceMappingURL=index.d.ts.map