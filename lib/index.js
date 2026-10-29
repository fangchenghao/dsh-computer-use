/** DSH Computer Use model-facing consumer and progressive Skill bundle. */
import { Service } from '@deepseek-ai/cordis';
import { Config, readComputerUseConfig, resolveConfig } from "./config.js";
import { ComputerUseExposure } from "./exposure.js";
import { MacOSComputerUseProvider } from "./providers/macos.js";
import { COMPUTER_USE_SKILL, LEGACY_COMPUTER_USE_SKILL } from "./skill.js";
import { createComputerUseTools } from "./tools.js";
import { installComputerUseWeb } from "./web.js";
import { ComputerUseUpdater, locateInstallation } from "./update.js";
export { Config } from "./config.js";
export * from "./errors.js";
export * from "./service.js";
export * from "./types.js";
/** Register the portable Skill, bootstrap, Agent-scoped Tools, and optional Web diagnostics. */
export function installComputerUseConsumer(ctx, update) {
    const exposure = new ComputerUseExposure(ctx, () => createComputerUseTools(ctx.computerUse));
    let activation;
    let skill;
    let legacySkill;
    let exposureDispose;
    try {
        activation = ctx.tools.register(exposure.activationTool);
        skill = ctx.skills.register(COMPUTER_USE_SKILL);
        legacySkill = ctx.skills.register(LEGACY_COMPUTER_USE_SKILL);
        exposureDispose = exposure.install();
        installComputerUseWeb(ctx, update);
    }
    catch (error) {
        exposureDispose?.();
        legacySkill?.();
        skill?.();
        activation?.();
        throw error;
    }
    return () => {
        exposureDispose?.();
        activation?.();
        legacySkill?.();
        skill?.();
    };
}
/** macOS provider plus the portable Skill, scoped Tools, and optional Web diagnostics. */
export class ComputerUseBundle extends MacOSComputerUseProvider {
    static inject = ['subprocess', 'approval', 'settings', 'sessions', 'agents', 'tools', 'skills'];
    static Config = Config;
    consumerDispose;
    updateControl;
    updateSettings;
    constructor(ctx, config = {}) {
        super(ctx, config);
        const resolved = resolveConfig(readComputerUseConfig(config));
        this.updateSettings = { autoUpdate: resolved.autoUpdate, intervalHours: resolved.updateIntervalHours };
        ctx.effect(() => () => {
            this.consumerDispose?.();
            this.consumerDispose = undefined;
        }, 'dsh-computer-use: consumer lifecycle');
    }
    /** Publish model-facing capabilities only after provider integrity and health pass. */
    async [Service.init]() {
        await super[Service.init]();
        this.startUpdater();
        if (process.platform !== 'darwin') {
            // Non-macOS hosts keep the profile healthy and show the reason in Web Settings,
            // but never expose Computer Use Tools or the Skill to the model.
            installComputerUseWeb(this.ctx, this.updateControl);
            return;
        }
        this.consumerDispose = installComputerUseConsumer(this.ctx, this.updateControl);
    }
    /**
     * Follow the published package: check the registry shortly after startup and
     * install newer patch releases into the profile that owns this module.
     */
    startUpdater() {
        const installation = locateInstallation(import.meta.url);
        if (installation === undefined) {
            this.ctx.logger.warn('dsh-computer-use: could not locate the owning profile; automatic updates are off for this run');
            return;
        }
        const updater = new ComputerUseUpdater({
            packageName: '@fffangchenghao/dsh-computer-use',
            currentVersion: installation.version,
            profileDir: installation.profileDir,
            autoUpdate: this.updateSettings.autoUpdate,
            intervalHours: this.updateSettings.intervalHours,
            logger: {
                info: message => this.ctx.logger.info('dsh-computer-use: %s', message),
                warn: message => this.ctx.logger.warn('dsh-computer-use: %s', message),
            },
        });
        this.updateControl = {
            status: () => updater.status(),
            check: () => updater.check(),
            apply: () => updater.update(),
        };
        updater.start();
        this.ctx.effect(() => () => updater.dispose(), 'dsh-computer-use: update lifecycle');
    }
}
export default ComputerUseBundle;
//# sourceMappingURL=index.js.map