/** Registry update check and profile-level self-update for this Bundle. */

import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One comparable SemVer release, including its prerelease identifiers. */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Parse a SemVer string, or return undefined when the input is not a release. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compare two SemVer releases; a prerelease sorts before its release. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return left === right ? 0 : left < right ? -1 : 1
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key])
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const order = compareIdentifier(left, right)
    if (order !== 0) return order
  }
  return 0
}

/** Whether a release is a patch update of the same line, which is safe to install unattended. */
export function isPatchUpdate(current: string, next: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(next)
  if (a === undefined || b === undefined) return false
  return a.major === b.major && a.minor === b.minor && a.prerelease.length === 0 && b.prerelease.length === 0
    && b.patch > a.patch
}

/**
 * Walk up from an installed module file until a directory holds both a
 * `package.json` with `dsh.profile` and a `node_modules` directory.
 */
export function findProfileDir(moduleUrl: string): string | undefined {
  let current = dirname(fileURLToPath(moduleUrl))
  for (let depth = 0; depth < 12; depth += 1) {
    if (isProfileRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function isProfileRoot(candidate: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as { dsh?: { profile?: unknown } }
    return manifest.dsh?.profile !== undefined && statSync(join(candidate, 'node_modules')).isDirectory()
  } catch {
    return false
  }
}

/** Update state exposed to Settings and logs. */
export interface UpdateStatus {
  current: string
  latest?: string
  available: boolean
  checkedAt?: string
  installing: boolean
  updatedTo?: string
  restartRequired: boolean
  error?: string
}

/** Persistent throttling state, stored beside the profile so restarts do not retry in a loop. */
interface UpdateStateFile {
  checkedAt?: number
  failedVersion?: string
  failedAt?: number
  updatedTo?: string
}

/** Injected process boundary so tests never spawn a package manager. */
export interface UpdateRunner {
  (command: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<{
    code: number
    output: string
  }>
}

/** Everything the updater needs from the host. */
export interface UpdateOptions {
  packageName: string
  currentVersion: string
  profileDir: string
  intervalHours?: number
  autoUpdate?: boolean
  registry?: string
  logger?: { info: (message: string) => void; warn: (message: string) => void }
  runner?: UpdateRunner
  fetchImpl?: typeof fetch
  now?: () => number
}

const STATE_DIR = '.dsh-computer-use'
const FETCH_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 300_000
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000

function defaultRunner(): UpdateRunner {
  return (command, args, options) => new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      env: options.env,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const output = `${String(stdout)}${String(stderr)}`.trim()
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolvePromise({ code, output })
    })
    child.on('error', () => resolvePromise({ code: 1, output: 'the package manager could not be started' }))
  })
}

/** Locate the package manager DSH itself uses for profile installs. */
export function discoverPackageManager(
  argv: string[],
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const pnpmModule = argv.find(argument => /[\\/]pnpm[\\/]bin[\\/]pnpm\.mjs$/u.test(argument))
  if (pnpmModule !== undefined) {
    return {
      command: execPath,
      args: ['--expose-internals', pnpmModule],
      env: { ELECTRON_RUN_AS_NODE: '1', ...(platform === 'win32' ? {} : {}) },
    }
  }
  const configured = process.env.DSH_PNPM_COMMAND
  if (configured !== undefined && configured.trim().length > 0) {
    return { command: configured, args: [], env: {} }
  }
  return { command: 'corepack', args: ['pnpm'], env: {} }
}

/** Check the registry, and update the installed Bundle when a newer release exists. */
export class ComputerUseUpdater {
  private readonly options: UpdateOptions & { packageName: string; currentVersion: string; profileDir: string }
  private readonly runner: UpdateRunner
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly statePath: string
  private state: UpdateStatus
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(options: UpdateOptions) {
    this.options = options
    this.runner = options.runner ?? defaultRunner()
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.statePath = join(options.profileDir, STATE_DIR, 'update-state.json')
    this.state = {
      current: options.currentVersion,
      available: false,
      installing: false,
      restartRequired: false,
    }
  }

  /** Current update state, safe to serialize into the Settings snapshot. */
  status(): UpdateStatus {
    return { ...this.state }
  }

  /** Start the background check; the first check runs shortly after plugin startup. */
  start(): void {
    if (this.options.autoUpdate === false) {
      this.log('info', 'automatic update is disabled by configuration')
      return
    }
    this.timer = setTimeout(() => {
      void this.runScheduledCheck()
    }, 5_000)
    this.timer.unref?.()
  }

  /** Stop the background timer. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Read the newest published version without changing the installation. */
  async check(): Promise<UpdateStatus> {
    const registry = (this.options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
    const url = `${registry}/${this.options.packageName.replace('/', '%2F')}/latest`
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`registry answered ${response.status}`)
      const body = await response.json() as { version?: unknown }
      if (typeof body.version !== 'string' || parseVersion(body.version) === undefined) {
        throw new Error('registry answered no usable version')
      }
      const latest = body.version
      const available = compareVersions(latest, this.options.currentVersion) > 0 && this.state.updatedTo !== latest
      const { error: _previousError, ...rest } = this.state
      this.state = {
        ...rest,
        latest,
        available,
        checkedAt: new Date(this.now()).toISOString(),
      }
      await this.writeState({ ...(await this.readState()), checkedAt: this.now() })
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.state = { ...this.state, error: `update check failed: ${message}` }
      this.log('warn', this.state.error ?? message)
      return this.status()
    }
  }

  /** Install a published version into the profile that owns this module. */
  async update(version?: string): Promise<UpdateStatus> {
    if (this.running) return this.status()
    this.running = true
    const { error: _previousError, ...rest } = this.state
    this.state = { ...rest, installing: true }
    const backup = join(this.options.profileDir, STATE_DIR, `backup-${this.now()}`)
    try {
      const latest = version ?? this.state.latest ?? (await this.check()).latest
      if (latest === undefined) throw new Error('no published version was resolved')
      if (this.state.updatedTo === latest) {
        this.state = { ...this.state, available: false, installing: false }
        return this.status()
      }
      if (compareVersions(latest, this.options.currentVersion) <= 0) {
        this.state = { ...this.state, available: false, installing: false }
        return this.status()
      }
      await mkdir(backup, { recursive: true })
      for (const file of ['package.json', 'pnpm-lock.yaml']) {
        const source = join(this.options.profileDir, file)
        if (await pathExists(source)) await copyFile(source, join(backup, file))
      }
      const manager = discoverPackageManager(process.argv, process.execPath)
      if (manager === undefined) throw new Error('no package manager was found for this DSH installation')
      const args = [...manager.args, 'add', `${this.options.packageName}@${latest}`, '--save-prefix', '^']
      this.log('info', `installing ${this.options.packageName}@${latest} in ${this.options.profileDir}`)
      const result = await this.runner(manager.command, args, {
        cwd: this.options.profileDir,
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: { ...process.env, ...manager.env },
      })
      if (result.code !== 0) throw new Error(`package manager exited ${result.code}: ${result.output.slice(-800)}`)
      const installed = await installedVersion(this.options.profileDir, this.options.packageName)
      if (installed !== latest) throw new Error(`installed version is ${installed ?? 'missing'}, expected ${latest}`)
      this.state = {
        ...this.state,
        latest,
        available: false,
        installing: false,
        updatedTo: latest,
        restartRequired: true,
        checkedAt: new Date(this.now()).toISOString(),
      }
      await this.writeState({ checkedAt: this.now(), updatedTo: latest })
      this.log('info', `updated to ${latest}; restart DeepSeek Harness to load it`)
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await restoreBackup(this.options.profileDir, backup)
      this.state = { ...this.state, installing: false, error: `update failed: ${message}` }
      await this.writeState({
        ...(await this.readState()),
        ...(this.state.latest === undefined ? {} : { failedVersion: this.state.latest }),
        failedAt: this.now(),
      })
      this.log('warn', `update failed: ${message}`)
      return this.status()
    } finally {
      this.running = false
    }
  }

  private async runScheduledCheck(): Promise<void> {
    const previous = await this.readState()
    const interval = (this.options.intervalHours ?? 24) * 60 * 60 * 1000
    if (previous.checkedAt !== undefined && this.now() - previous.checkedAt < interval) {
      this.log('info', `skipping the scheduled check; the last one was ${Math.round((this.now() - previous.checkedAt) / 60_000)} minutes ago`)
      return
    }
    const status = await this.check()
    if (!status.available || status.latest === undefined) return
    const state = await this.readState()
    if (state.updatedTo === status.latest) return
    if (state.failedVersion === status.latest && state.failedAt !== undefined
      && this.now() - state.failedAt < RETRY_BACKOFF_MS) {
      this.log('info', `skipping retry of ${status.latest} after a recent failure`)
      return
    }
    if (!isPatchUpdate(this.options.currentVersion, status.latest)) {
      this.log('warn', `version ${status.latest} needs a manual update because it is not a patch release of ${this.options.currentVersion}`)
      return
    }
    await this.update(status.latest)
  }

  private async readState(): Promise<UpdateStateFile> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as UpdateStateFile
    } catch {
      return {}
    }
  }

  private async writeState(value: UpdateStateFile): Promise<void> {
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      await writeFile(this.statePath, `${JSON.stringify(value, null, 2)}\n`)
    } catch (error) {
      this.log('warn', `could not persist update state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.options.logger?.[level](message)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function installedVersion(profileDir: string, packageName: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')
    const manifest = JSON.parse(raw) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

async function restoreBackup(profileDir: string, backup: string): Promise<void> {
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    const source = join(backup, file)
    if (!(await pathExists(source))) continue
    try {
      await copyFile(source, join(profileDir, file))
    } catch {
      /* best-effort restore */
    }
  }
}

/** Resolve the profile directory and installed version of the current module when possible. */
export function locateInstallation(moduleUrl: string): { profileDir: string; version: string } | undefined {
  const profileDir = findProfileDir(moduleUrl)
  if (profileDir === undefined) return undefined
  const packageDir = resolve(dirname(fileURLToPath(moduleUrl)), '..')
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? { profileDir, version: manifest.version } : undefined
  } catch {
    return undefined
  }
}
