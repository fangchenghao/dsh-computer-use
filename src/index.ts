/** DSH Computer Use model-facing consumer and progressive Skill bundle. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, readComputerUseConfig, resolveConfig, type ComputerUseConfig } from './config.ts'
import { ComputerUseExposure } from './exposure.ts'
import { MacOSComputerUseProvider } from './providers/macos.ts'
import { COMPUTER_USE_SKILL, LEGACY_COMPUTER_USE_SKILL } from './skill.ts'
import { createComputerUseTools } from './tools.ts'
import { installComputerUseWeb, type ComputerUseUpdateControl } from './web.ts'
import { ComputerUseUpdater, locateInstallation } from './update.ts'

export { Config } from './config.ts'
export * from './errors.ts'
export * from './service.ts'
export * from './types.ts'

/** Register the portable Skill, bootstrap, Agent-scoped Tools, and optional Web diagnostics. */
export function installComputerUseConsumer(ctx: Context, update?: ComputerUseUpdateControl): () => void {
  const exposure = new ComputerUseExposure(ctx, () => createComputerUseTools(ctx.computerUse))
  let activation: (() => void) | undefined
  let skill: (() => void) | undefined
  let legacySkill: (() => void) | undefined
  let exposureDispose: (() => void) | undefined
  try {
    activation = ctx.tools.register(exposure.activationTool)
    skill = ctx.skills.register(COMPUTER_USE_SKILL)
    legacySkill = ctx.skills.register(LEGACY_COMPUTER_USE_SKILL)
    exposureDispose = exposure.install()
    installComputerUseWeb(ctx, update)
  } catch (error) {
    exposureDispose?.()
    legacySkill?.()
    skill?.()
    activation?.()
    throw error
  }
  return () => {
    exposureDispose?.()
    activation?.()
    legacySkill?.()
    skill?.()
  }
}

/** macOS provider plus the portable Skill, scoped Tools, and optional Web diagnostics. */
export class ComputerUseBundle extends MacOSComputerUseProvider {
  static override inject = ['subprocess', 'approval', 'settings', 'sessions', 'agents', 'tools', 'skills']
  static override Config = Config

  private consumerDispose: (() => void) | undefined
  private updateControl: ComputerUseUpdateControl | undefined
  private readonly updateSettings: { autoUpdate: boolean; intervalHours: number }

  constructor(ctx: Context, config: ComputerUseConfig = {}) {
    super(ctx, config)
    const resolved = resolveConfig(readComputerUseConfig(config))
    this.updateSettings = { autoUpdate: resolved.autoUpdate, intervalHours: resolved.updateIntervalHours }
    ctx.effect(() => () => {
      this.consumerDispose?.()
      this.consumerDispose = undefined
    }, 'dsh-computer-use: consumer lifecycle')
  }

  /** Publish model-facing capabilities only after provider integrity and health pass. */
  protected override async [Service.init](): Promise<void> {
    await super[Service.init]()
    this.startUpdater()
    if (process.platform !== 'darwin') {
      // Non-macOS hosts keep the profile healthy and show the reason in Web Settings,
      // but never expose Computer Use Tools or the Skill to the model.
      installComputerUseWeb(this.ctx, this.updateControl)
      return
    }
    this.consumerDispose = installComputerUseConsumer(this.ctx, this.updateControl)
  }

  /**
   * Follow the published package: check the registry shortly after startup and
   * install newer patch releases into the profile that owns this module.
   */
  private startUpdater(): void {
    const installation = locateInstallation(import.meta.url)
    if (installation === undefined) {
      this.ctx.logger.warn('dsh-computer-use: could not locate the owning profile; automatic updates are off for this run')
      return
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
    })
    this.updateControl = {
      status: () => updater.status(),
      check: () => updater.check(),
      apply: () => updater.update(),
    }
    updater.start()
    this.ctx.effect(() => () => updater.dispose(), 'dsh-computer-use: update lifecycle')
  }
}

export default ComputerUseBundle
