/** Unit coverage for the registry update check and profile-level self-update. */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  ComputerUseUpdater,
  compareVersions,
  discoverPackageManager,
  findProfileDir,
  isPatchUpdate,
  locateInstallation,
} from '../src/update.ts'

async function temporaryProfile(version = '0.4.0'): Promise<{ profile: string; moduleUrl: string }> {
  const profile = await mkdtemp(join(tmpdir(), 'dcu-update-'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile',
    dsh: { profile: { bundles: ['@fffangchenghao/dsh-computer-use'] } },
    dependencies: { '@fffangchenghao/dsh-computer-use': '^0.4.0' },
  }))
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  const packageDir = join(profile, 'node_modules', '@fffangchenghao', 'dsh-computer-use')
  await mkdir(join(packageDir, 'lib'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@fffangchenghao/dsh-computer-use',
    version,
  }))
  await writeFile(join(packageDir, 'lib', 'index.js'), 'export {}\n')
  return { profile, moduleUrl: pathToFileURL(join(packageDir, 'lib', 'index.js')).href }
}

describe('version comparison', () => {
  it('orders releases and prereleases', () => {
    expect(compareVersions('0.4.0', '0.4.1')).toBe(-1)
    expect(compareVersions('0.4.1', '0.4.0')).toBe(1)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
    expect(compareVersions('0.4.0-rc.2', '0.4.0')).toBe(-1)
    expect(compareVersions('0.4.0-rc.2', '0.4.0-rc.3')).toBe(-1)
    expect(compareVersions('v1.2.3+build', '1.2.3')).toBe(0)
  })

  it('accepts only patch updates as unattended', () => {
    expect(isPatchUpdate('0.4.0', '0.4.1')).toBe(true)
    expect(isPatchUpdate('0.4.0', '0.4.9')).toBe(true)
    expect(isPatchUpdate('0.4.0', '0.5.0')).toBe(false)
    expect(isPatchUpdate('0.4.0', '1.4.1')).toBe(false)
    expect(isPatchUpdate('0.4.0-rc.3', '0.4.1')).toBe(false)
  })
})

describe('installation discovery', () => {
  it('finds the profile that owns the module', async () => {
    const { profile, moduleUrl } = await temporaryProfile()
    expect(findProfileDir(moduleUrl)).toBe(profile)
    expect(locateInstallation(moduleUrl)).toEqual({ profileDir: profile, version: '0.4.0' })
  })

  it('returns undefined outside a profile', () => {
    expect(findProfileDir(pathToFileURL('/tmp/not-a-profile/node_modules/x/lib/index.js').href)).toBeUndefined()
  })

  it('reuses the package manager the desktop host was started with', () => {
    const manager = discoverPackageManager(
      ['/Applications/DSH.app/Contents/MacOS/DSH', '/Applications/DSH.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'],
      '/Applications/DSH.app/Contents/MacOS/DSH',
      'darwin',
    )
    expect(manager?.command).toBe('/Applications/DSH.app/Contents/MacOS/DSH')
    expect(manager?.args).toEqual(['--expose-internals', '/Applications/DSH.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'])
    expect(manager?.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('update check and self-update', () => {
  it('reports a newer release', async () => {
    const { profile } = await temporaryProfile()
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      fetchImpl: (async () => new Response(JSON.stringify({ version: '0.4.1' }), { status: 200 })) as typeof fetch,
    })
    const status = await updater.check()
    expect(status.latest).toBe('0.4.1')
    expect(status.available).toBe(true)
    expect(status.error).toBeUndefined()
  })

  it('treats the current release as up to date', async () => {
    const { profile } = await temporaryProfile()
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      fetchImpl: (async () => new Response(JSON.stringify({ version: '0.4.0' }), { status: 200 })) as typeof fetch,
    })
    const status = await updater.check()
    expect(status.available).toBe(false)
  })

  it('installs the requested release through the injected package manager', async () => {
    const { profile } = await temporaryProfile()
    const calls: string[][] = []
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      runner: async (_command, args) => {
        calls.push(args)
        await writeFile(join(profile, 'node_modules', '@fffangchenghao', 'dsh-computer-use', 'package.json'),
          JSON.stringify({ name: '@fffangchenghao/dsh-computer-use', version: '0.4.1' }))
        return { code: 0, output: 'done' }
      },
    })
    const status = await updater.update('0.4.1')
    expect(calls[0]).toContain('@fffangchenghao/dsh-computer-use@0.4.1')
    expect(status.updatedTo).toBe('0.4.1')
    expect(status.restartRequired).toBe(true)
    expect(status.available).toBe(false)
    const state = JSON.parse(await readFile(join(profile, '.dsh-computer-use', 'update-state.json'), 'utf8'))
    expect(state.updatedTo).toBe('0.4.1')
  })

  it('retries past the package manager release-age gate for this package only', async () => {
    const { profile } = await temporaryProfile()
    const calls: string[][] = []
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      runner: async (_command, args) => {
        calls.push(args)
        if (calls.length === 1) {
          return { code: 1, output: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION: within the minimumReleaseAge cutoff' }
        }
        await writeFile(join(profile, 'node_modules', '@fffangchenghao', 'dsh-computer-use', 'package.json'),
          JSON.stringify({ name: '@fffangchenghao/dsh-computer-use', version: '0.4.1' }))
        return { code: 0, output: 'done' }
      },
    })
    const status = await updater.update('0.4.1')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('--config.minimumReleaseAge=0')
    expect(status.updatedTo).toBe('0.4.1')
  })

  it('restores the profile files when the package manager fails', async () => {
    const { profile } = await temporaryProfile()
    const before = await readFile(join(profile, 'package.json'), 'utf8')
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      runner: async () => {
        await writeFile(join(profile, 'package.json'), '{"broken":true}')
        return { code: 1, output: 'registry unreachable' }
      },
    })
    const status = await updater.update('0.4.1')
    expect(status.error).toContain('registry unreachable')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
  })

  it('rejects an explicit version that is not SemVer before spawning the package manager', async () => {
    const { profile } = await temporaryProfile()
    const calls: string[][] = []
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      runner: async (_command, args) => {
        calls.push(args)
        return { code: 0, output: 'done' }
      },
    })
    const status = await updater.update('latest')
    expect(calls).toHaveLength(0)
    expect(status.error).toContain('not a valid SemVer version')
    expect(status.installing).toBe(false)
    expect(status.updatedTo).toBeUndefined()
  })

  it('keeps only the newest backup directory after a successful update', async () => {
    const { profile } = await temporaryProfile()
    const stateDir = join(profile, '.dsh-computer-use')
    await mkdir(join(stateDir, 'backup-1000'), { recursive: true })
    await mkdir(join(stateDir, 'backup-2000'), { recursive: true })
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      now: () => 3000,
      runner: async () => {
        await writeFile(join(profile, 'node_modules', '@fffangchenghao', 'dsh-computer-use', 'package.json'),
          JSON.stringify({ name: '@fffangchenghao/dsh-computer-use', version: '0.4.1' }))
        return { code: 0, output: 'done' }
      },
    })
    const status = await updater.update('0.4.1')
    expect(status.updatedTo).toBe('0.4.1')
    const names = (await readdir(stateDir)).filter(entry => entry.startsWith('backup-')).sort()
    expect(names).toEqual(['backup-3000'])
  })

  it('shares one registry check between concurrent callers', async () => {
    const { profile } = await temporaryProfile()
    let fetches = 0
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      fetchImpl: (async () => {
        fetches += 1
        return new Response(JSON.stringify({ version: '0.4.1' }), { status: 200 })
      }) as typeof fetch,
    })
    const [first, second] = await Promise.all([updater.check(), updater.check()])
    expect(fetches).toBe(1)
    expect(first.latest).toBe('0.4.1')
    expect(second.latest).toBe('0.4.1')
  })

  it('does not start a second install while one is already running', async () => {
    const { profile } = await temporaryProfile()
    let runs = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      runner: async () => {
        runs += 1
        await gate
        await writeFile(join(profile, 'node_modules', '@fffangchenghao', 'dsh-computer-use', 'package.json'),
          JSON.stringify({ name: '@fffangchenghao/dsh-computer-use', version: '0.4.1' }))
        return { code: 0, output: 'done' }
      },
    })
    const first = updater.update('0.4.1')
    await Promise.resolve()
    const second = updater.update('0.4.1')
    release?.()
    const [a, b] = await Promise.all([first, second])
    expect(runs).toBe(1)
    expect(a.updatedTo).toBe('0.4.1')
    expect(b.updatedTo).toBe('0.4.1')
  })

  it('re-arms the background schedule when autoUpdate is configured live', async () => {
    const { profile } = await temporaryProfile()
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      autoUpdate: false,
      intervalHours: 24,
    })
    updater.start()
    updater.configure({ autoUpdate: true, intervalHours: 6 })
    updater.configure({ autoUpdate: true, intervalHours: 6 })
    updater.configure({ autoUpdate: false })
    updater.dispose()
    expect(updater.status().installing).toBe(false)
  })

  it.each(['disable', 'disable then re-enable', 'dispose'])('drops a pending automatic install after %s', async change => {
    const { profile } = await temporaryProfile()
    const registry = Promise.withResolvers<Response>()
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      fetchImpl: async () => (await registry.promise).clone(),
    })
    const install = vi.spyOn(updater, 'update').mockResolvedValue(updater.status())
    const timer = vi.spyOn(globalThis, 'setInterval')
    try {
      updater.start()
      const pending = timer.mock.lastCall![0]()
      if (change === 'dispose') updater.dispose()
      else updater.configure({ autoUpdate: false })
      if (change === 'disable then re-enable') updater.configure({ autoUpdate: true })
      registry.resolve(Response.json({ version: '0.4.1' }))
      await pending
      expect(install).not.toHaveBeenCalled()
      if (change === 'disable then re-enable') {
        await timer.mock.lastCall![0]()
        expect(install).toHaveBeenCalledExactlyOnceWith('0.4.1')
      }
    } finally {
      updater.dispose()
      timer.mockRestore()
    }
  })

  it('does not auto-install a cached version after the registry check fails', async () => {
    const { profile } = await temporaryProfile()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ version: '0.4.1' }))
      .mockRejectedValueOnce(new Error('offline'))
    const updater = new ComputerUseUpdater({
      packageName: '@fffangchenghao/dsh-computer-use',
      currentVersion: '0.4.0',
      profileDir: profile,
      fetchImpl,
    })
    expect((await updater.check()).available).toBe(true)
    const install = vi.spyOn(updater, 'update').mockResolvedValue(updater.status())
    const timer = vi.spyOn(globalThis, 'setInterval')
    try {
      updater.start()
      await timer.mock.lastCall![0]()
      expect(updater.status().error).toContain('offline')
      expect(install).not.toHaveBeenCalled()
    } finally {
      updater.dispose()
      timer.mockRestore()
    }
  })
})
