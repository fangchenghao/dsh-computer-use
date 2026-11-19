import { Context } from '@deepseek-ai/cordis'
import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome, ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { resolveConfig, type ComputerUseConfig } from '../src/config.ts'
import type { ComputerUseSessionState } from '../src/leases.ts'
import { ComputerUseError } from '../src/errors.ts'
import { ComputerUseService } from '../src/service.ts'
import {
  ComputerObservationId,
  ComputerConfirmationToken,
  ComputerTargetHandle,
  type ComputerActionRequest,
  type ComputerUseContext,
} from '../src/types.ts'
import { FakeBackend, FIXTURE_APP, backendObservation, fakeAgent, temporaryDirectory } from './helpers.ts'

class TestComputerUseService extends ComputerUseService {
  initializeForTest(): Promise<void> {
    return this.initialize()
  }

  reconfigureForTest(backend: FakeBackend, config: ComputerUseConfig): Promise<void> {
    return this.reconfigure(backend, resolveConfig(config))
  }
}

function serviceHarness(
  config: ComputerUseConfig = {},
  approval: ApprovalOutcome = 'allowed-once',
  policy: ApprovalPolicy = 'ask',
  options: { storage?: boolean; flushParticipates?: boolean } = {},
) {
  const ctx = new Context()
  const order: string[] = []
  let approvalId = 0
  const request = vi.fn(({ agent }: { agent: ReturnType<typeof fakeAgent> }) => {
    const id = `approval-${++approvalId}`
    agent.session.append('approval/asked', { id })
    agent.session.append('approval/decided', { id, outcome: approval })
    order.push('approval:decided')
    return Promise.resolve(approval)
  })
  ctx.provide('approval', {
    request,
    overrideOf: () => (policy === 'never' ? 'never' : undefined),
    config: { policy },
  } as never)
  const rows = new Map<string, ComputerUseSessionState>()
  const flush = vi.fn(() => {
    order.push('session:flushed')
    return Promise.resolve(options.flushParticipates ?? true)
  })
  ctx.provide('sessions', { flush } as never)
  if (options.storage !== false) {
    ctx.provide('storageDomain', {
      open: () => Promise.resolve({
        table: () => ({
          get: (key: string) => rows.get(key),
          put: (key: string, value: ComputerUseSessionState) => {
            order.push('sidecar:durable')
            rows.set(key, value)
            return Promise.resolve()
          },
        }),
        close: () => Promise.resolve(),
      }),
    } as never)
  }
  const backend = new FakeBackend()
  const service = new TestComputerUseService(ctx, backend, resolveConfig({
    settleMs: 0,
    maxSettleMs: 100,
    grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: true }],
    ...config,
  }))
  return { ctx, backend, service, request, rows, flush, order }
}

function callContext(agent: ReturnType<typeof fakeAgent>, workspace: string): ComputerUseContext {
  return { agent, workspace, signal: new AbortController().signal }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Computer Use Service', () => {
  it('initializes health, lists apps, observes, acts, returns fresh diff state, and rejects stale reuse', async () => {
    const workspace = await temporaryDirectory('dsh-computer-service-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      expect(service.status()).toMatchObject({
        ready: true,
        provider: 'macos-ax',
        helperVersion: '0.1.0-test',
        generation: 1,
      })
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      expect(await service.listApps(context)).toHaveLength(1)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      expect(before.tree.mode).toBe('full')
      const result = await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      expect(result).toMatchObject({
        action: 'click',
        channel: 'accessibility',
        activation: 'not-requested',
        pointerInput: false,
        pointerRouting: 'none',
        resolution: {
          mode: 'exact-locator',
          confidence: 1,
          candidateCount: 1,
          targetChanged: false,
        },
      })
      expect(result.observation.observationId).not.toBe(before.observationId)
      expect(result.observation.tree.mode).toBe('diff')
      expect(result.observation.tree.text).toContain('AXStaticText')
      expect(backend.actions).toHaveLength(1)
      expect(backend.cursorActions).toEqual([
        { phase: 'before', action: { kind: 'click', to: { x: 260, y: 334 }, targetPid: FIXTURE_APP.pid, targetWindowNumber: 7, targetWindowFrame: { x: 100, y: 200, width: 760, height: 592 } } },
        { phase: 'after', action: { kind: 'click', to: { x: 260, y: 334 }, targetPid: FIXTURE_APP.pid, targetWindowNumber: 7, targetWindowFrame: { x: 100, y: 200, width: 760, height: 592 } } },
      ])
      await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports bounded structural observation changes without claiming causal proof', async () => {
    // Routing fields describe the attempt. The effect reports only the
    // structural state hash and explicitly preserves uncertainty about pixels,
    // transient UI, remote effects, and unrelated external changes.
    const workspace = await temporaryDirectory('dsh-computer-effect-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const effective = await service.act(
        { kind: 'click', observationId: before.observationId, elementIndex: 1 },
        context,
      )
      expect(effective.effect.observedStateChanged).toBe(true)
      expect(effective.effect).not.toHaveProperty('note')

      backend.inert = true
      const after = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const inert = await service.act(
        { kind: 'click', observationId: after.observationId, elementIndex: 1 },
        context,
      )
      expect(inert.effect.observedStateChanged).toBe(false)
      expect(inert.effect.note).toContain('pixel-only, remote, or transient effects may still have occurred')
      // The attempt still reads as a clean success, which is exactly why the
      // outcome needs its own field.
      expect(inert.pointerRouting).toBe('target-process')
    } finally {
      await workspace.cleanup()
    }
  })

  it('serializes actions for one app through their post-action observation', async () => {
    const workspace = await temporaryDirectory('dsh-computer-action-queue-')
    try {
      const { backend, service } = serviceHarness()
      backend.inert = true
      await service.initializeForTest()
      const firstAgent = fakeAgent(workspace.path, 'queue-1')
      const secondAgent = fakeAgent(workspace.path, 'queue-2')
      const firstContext = callContext(firstAgent, workspace.path)
      const secondContext = callContext(secondAgent, workspace.path)
      const firstObservation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, firstContext)
      const secondObservation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, secondContext)
      const originalAct = backend.act.bind(backend)
      let active = 0
      let maximumActive = 0
      vi.spyOn(backend, 'act').mockImplementation(async request => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        try {
          return await originalAct(request)
        } finally {
          active -= 1
        }
      })

      const [first, second] = await Promise.all([
        service.act({ kind: 'click', observationId: firstObservation.observationId, elementIndex: 1 }, firstContext),
        service.act({ kind: 'click', observationId: secondObservation.observationId, elementIndex: 1 }, secondContext),
      ])
      expect(maximumActive).toBe(1)
      expect(first.effect.observedStateChanged).toBe(false)
      expect(second.effect.observedStateChanged).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails closed when a foreground cursor cannot complete before input', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const visible = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const shown = await service.act({ kind: 'click', observationId: visible.observationId, elementIndex: 1 }, context)
      expect(shown).not.toHaveProperty('agentCursor')

      backend.cursorVisibility = { visible: false, reason: 'the bound target window moved' }
      const next = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await expect(service.act({ kind: 'click', observationId: next.observationId, elementIndex: 1 }, context)).rejects.toMatchObject({
        code: 'COMPUTER_PROVIDER_FAILURE',
        message: expect.stringContaining('the bound target window moved'),
      })
      expect(backend.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('allows targeted background input when the cursor is hidden for that explicit reason', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-background-')
    try {
      const { backend, service } = serviceHarness()
      backend.cursorVisibility = {
        visible: false,
        reason: 'the bound target application is not frontmost',
        reasonCode: 'target-not-frontmost',
      }
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const result = await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      expect(result.agentCursor).toEqual({
        visible: false,
        reason: 'the bound target application is not frontmost',
      })
      expect(backend.actions).toHaveLength(1)
      expect(backend.cursorActions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not bypass cursor feedback after activation-mode focus loss', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-activation-focus-loss-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.cursorVisibility = {
        visible: false,
        reason: 'the bound target application is not frontmost',
        reasonCode: 'target-not-frontmost',
      }
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await expect(service.act({
        kind: 'click',
        observationId: before.observationId,
        x: 300,
        y: 350,
        coordinateSpace: 'window',
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_PROVIDER_FAILURE',
        message: expect.stringContaining('not frontmost'),
      })
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps semantic background clicks nonactivating in activation mode', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-semantic-background-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.observation = backendObservation({ frontmost: false })
      backend.cursorVisibility = {
        visible: false,
        reason: 'the bound target application is not frontmost',
        reasonCode: 'target-not-frontmost',
      }
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const result = await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      expect(result.agentCursor).toEqual({
        visible: false,
        reason: 'the bound target application is not frontmost',
      })
      expect(backend.cursorActivations).toHaveLength(0)
      expect(backend.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('activates before an AXPress click that permits pointer fallback', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-fallback-activate-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.observation = backendObservation({ frontmost: false })
      const activate = vi.spyOn(backend, 'activateForCursor')
      const visualize = vi.spyOn(backend, 'visualizeCursor')
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await service.act({
        kind: 'click',
        observationId: before.observationId,
        elementIndex: 1,
        allowCoordinateFallback: true,
      }, context)

      expect(activate).toHaveBeenCalledOnce()
      expect(activate.mock.invocationCallOrder[0]).toBeLessThan(visualize.mock.invocationCallOrder[0]!)
      expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('starts native drag input with the separate live cursor-tracking phase', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-drag-order-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.observation = backendObservation({ frontmost: false })
      const beforeCursor = Promise.withResolvers<{ visible: boolean }>()
      const duringCursor = Promise.withResolvers<{ visible: boolean }>()
      const visualize = vi.spyOn(backend, 'visualizeCursor').mockImplementation((_action, phase) => (
        phase === 'before' ? beforeCursor.promise : phase === 'during' ? duringCursor.promise : Promise.resolve({ visible: true })
      ))
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)

      const action = service.act({
        kind: 'drag',
        observationId: before.observationId,
        fromX: 10,
        fromY: 20,
        toX: 200,
        toY: 240,
      }, context)
      await vi.waitFor(() => { expect(visualize).toHaveBeenCalledTimes(1) })
      expect(backend.actions).toHaveLength(0)

      beforeCursor.resolve({ visible: true })
      await vi.waitFor(() => { expect(backend.actions).toHaveLength(1) })
      expect(visualize.mock.calls.map(call => call[1])).toEqual(['before', 'during'])
      let settled = false
      void action.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)

      duringCursor.resolve({ visible: true })
      await expect(action).resolves.toMatchObject({ effect: expect.any(Object) })
      expect(visualize.mock.calls.map(call => call[1])).toEqual(['before', 'during', 'after'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an after-only cursor failure instead of dropping release validation', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-after-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      vi.spyOn(backend, 'visualizeCursor').mockImplementation((_action, phase) => Promise.resolve(
        phase === 'before'
          ? { visible: true }
          : { visible: false, reason: 'the target window moved during the action' },
      ))

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const result = await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      expect(result.agentCursor).toEqual({ visible: false, reason: 'the target window moved during the action' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('releases cursor feedback when confirmation consumption fails after arrival', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-confirmation-cleanup-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)

      await expect(service.act({
        kind: 'click',
        observationId: before.observationId,
        elementIndex: 1,
        sensitive: true,
        confirmationToken: ComputerConfirmationToken('unknown'),
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })
      expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects an already-cancelled action before provider work without implying input was sent', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-before-input-')
    try {
      const { backend, service, request } = serviceHarness()
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const act = vi.spyOn(backend, 'act')
      const observe = vi.spyOn(backend, 'observe')
      const reason = new Error('caller stopped before input')
      controller.abort(reason)

      const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      await expect(action).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        cause: reason,
        message: expect.not.stringContaining('may already have executed'),
      })
      expect(act).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
      expect(backend.cursorActions).toHaveLength(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps cancellation during pre-input cursor movement distinct from an attempted action', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-cursor-before-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const reason = new Error('cursor movement interrupted')
      const visualize = vi.spyOn(backend, 'visualizeCursor').mockImplementation(async () => {
        controller.abort(reason)
        throw reason
      })
      const act = vi.spyOn(backend, 'act')

      await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context))
        .rejects.toMatchObject({
          code: 'COMPUTER_CANCELLED',
          cause: reason,
          message: expect.not.stringContaining('may already have executed'),
        })
      expect(visualize).toHaveBeenCalledOnce()
      expect(visualize.mock.calls[0]?.[1]).toBe('before')
      expect(act).not.toHaveBeenCalled()
      expect(backend.actions).toHaveLength(0)
      expect(backend.observations).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not dispatch input or consume confirmation when the pre-input cursor resolves after cancellation', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-cursor-race-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const proposed: ComputerActionRequest = {
        kind: 'click', observationId: before.observationId, elementIndex: 1, sensitive: true,
      }
      const confirmation = await service.confirm({ action: proposed, reason: 'Apply fixture change', target: 'fixture' }, context)
      const act = vi.spyOn(backend, 'act')
      vi.spyOn(backend, 'visualizeCursor').mockImplementationOnce(async () => {
        controller.abort()
        return { visible: true }
      })
      const confirmed = { ...proposed, confirmationToken: confirmation.token }

      await expect(service.act(confirmed, context)).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        message: expect.not.stringContaining('may already have executed'),
      })
      expect(act).not.toHaveBeenCalled()
      expect(backend.actions).toHaveLength(0)
      // A cancellation before input must not burn the one-use authorization.
      await expect(service.act(confirmed, { ...context, signal: new AbortController().signal }))
        .resolves.toMatchObject({ action: 'click' })
      expect(act).toHaveBeenCalledOnce()
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects cancellation even when the post-action observation resolves with settleMs zero', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-observe-race-')
    try {
      const { backend, service } = serviceHarness({ settleMs: 0 })
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const originalObserve = backend.observe.bind(backend)
      const observe = vi.spyOn(backend, 'observe').mockImplementation(async (app, options) => {
        const fresh = await originalObserve(app, options)
        controller.abort()
        return fresh
      })
      const act = vi.spyOn(backend, 'act')
      const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)

      await expect(action).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        message: expect.stringContaining('may already have executed'),
      })
      await expect(action).rejects.toThrow('observe the current state before retrying')
      expect(act).toHaveBeenCalledOnce()
      await expect(act.mock.results[0]?.value).resolves.toMatchObject({ channel: 'accessibility' })
      expect(observe).toHaveBeenCalledOnce()
      await expect(observe.mock.results[0]?.value).resolves.toMatchObject({ stateHash: 'state-2' })
      expect(backend.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('maps cancellation during the real settle timer to cancellation with an executed-action warning', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-settle-timer-')
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const { backend, service } = serviceHarness({ settleMs: 100, maxSettleMs: 200 })
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const reason = new Error('caller stopped during settling')
      const originalAct = backend.act.bind(backend)
      const act = vi.spyOn(backend, 'act').mockImplementation(async request => {
        const outcome = await originalAct(request)
        // Let actNow enter node:timers/promises.delay before aborting. The
        // ABORT_ERR assertion below distinguishes the timer from a signal guard.
        cancelTimer = setTimeout(() => { controller.abort(reason) }, 10)
        return outcome
      })
      const observe = vi.spyOn(backend, 'observe')
      const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)

      await expect(action).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        cause: { name: 'AbortError', code: 'ABORT_ERR', cause: reason },
        message: expect.stringContaining('may already have executed'),
      })
      await expect(action).rejects.toThrow('observe the current state before retrying')
      expect(act).toHaveBeenCalledOnce()
      await expect(act.mock.results[0]?.value).resolves.toMatchObject({ channel: 'accessibility' })
      expect(backend.actions).toHaveLength(1)
      expect(observe).not.toHaveBeenCalled()
      expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer)
      await workspace.cleanup()
    }
  })

  it('rejects cancellation after a successful post-action screenshot capture instead of returning success', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-capture-race-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const controller = new AbortController()
      const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      const originalObserve = backend.observe.bind(backend)
      const reason = new Error('caller stopped after screenshot capture')
      const observe = vi.spyOn(backend, 'observe').mockImplementation(async (app, options) => {
        const fresh = await originalObserve(app, options)
        // The settle observation succeeds with a live signal. Only the final
        // screenshot capture aborts, after its provider promise has fulfilled.
        if (options.screenshot !== 'none') controller.abort(reason)
        return fresh
      })
      const act = vi.spyOn(backend, 'act')
      const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)

      await expect(action).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        cause: reason,
        message: expect.stringContaining('may already have executed'),
      })
      await expect(action).rejects.toThrow('observe the current state before retrying')
      expect(act).toHaveBeenCalledOnce()
      await expect(act.mock.results[0]?.value).resolves.toMatchObject({ channel: 'accessibility' })
      expect(observe.mock.calls.map(call => call[1].screenshot)).toEqual(['none', 'optional'])
      await expect(observe.mock.results[0]?.value).resolves.toMatchObject({ stateHash: 'state-2' })
      await expect(observe.mock.results[1]?.value).resolves.toMatchObject({
        stateHash: 'state-2',
        screenshot: { path: expect.any(String), width: 760, height: 592 },
      })
      expect(backend.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not dispatch a cancelled queued action or borrow the preceding action execution warning', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cancel-queued-')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const firstContext = callContext(fakeAgent(workspace.path, 'first'), workspace.path)
      const controller = new AbortController()
      const queuedContext = { ...callContext(fakeAgent(workspace.path, 'queued'), workspace.path), signal: controller.signal }
      const firstObservation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, firstContext)
      const queuedObservation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, queuedContext)
      const originalAct = backend.act.bind(backend)
      const act = vi.spyOn(backend, 'act').mockImplementation(async request => {
        entered.resolve()
        await release.promise
        return await originalAct(request)
      })
      const first = service.act({ kind: 'click', observationId: firstObservation.observationId, elementIndex: 1 }, firstContext)
      await entered.promise
      const queued = service.act({ kind: 'click', observationId: queuedObservation.observationId, elementIndex: 1 }, queuedContext)
      const cancelled = expect(queued).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        message: expect.not.stringContaining('may already have executed'),
      })
      controller.abort()
      release.resolve()
      await Promise.all([expect(first).resolves.toMatchObject({ action: 'click' }), cancelled])
      expect(act).toHaveBeenCalledOnce()
      expect(backend.actions).toHaveLength(1)
      expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
    } finally {
      release.resolve()
      await workspace.cleanup()
    }
  })

  it.each(['AbortError', 'COMPUTER_CANCELLED', 'signal reason'] as const)(
    'warns against retrying when the provider is cancelled in flight via %s',
    async kind => {
      const workspace = await temporaryDirectory('dsh-computer-cancel-provider-')
      try {
        const { backend, service } = serviceHarness()
        await service.initializeForTest()
        const controller = new AbortController()
        const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
        const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
        const reason = kind === 'AbortError'
          ? new DOMException('provider interrupted', 'AbortError')
          : kind === 'COMPUTER_CANCELLED'
            ? new ComputerUseError('COMPUTER_CANCELLED', 'provider interrupted')
            : new Error('caller stopped the provider')
        const originalAct = backend.act.bind(backend)
        const act = vi.spyOn(backend, 'act').mockImplementation(async request => {
          // Record actual input before rejecting, not merely a provider call.
          await originalAct(request)
          if (kind === 'signal reason') controller.abort(reason)
          throw reason
        })

        const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
        await expect(action).rejects.toMatchObject({
          code: 'COMPUTER_CANCELLED',
          cause: reason,
          message: expect.stringContaining('may already have executed'),
        })
        await expect(action).rejects.toThrow('observe the current state before retrying')
        expect(act).toHaveBeenCalledOnce()
        expect(backend.actions).toHaveLength(1)
        expect(backend.observations).toHaveLength(1)
        expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
        expect(backend.cursorSignals[1]?.aborted).toBe(false)
      } finally {
        await workspace.cleanup()
      }
    },
  )

  it.each(['settle', 'screenshot'] as const)(
    'reports cancellation in the post-action %s observation after successful input, not provider failure',
    async phase => {
      const workspace = await temporaryDirectory('dsh-computer-cancel-post-observe-')
      try {
        const { backend, service } = serviceHarness()
        await service.initializeForTest()
        const controller = new AbortController()
        const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
        const before = await service.observe({
          app: { bundleId: FIXTURE_APP.bundleId },
          screenshot: phase === 'screenshot' ? 'required' : 'none',
        }, context)
        const originalObserve = backend.observe.bind(backend)
        const reason = new Error('post-action observation interrupted')
        const observe = vi.spyOn(backend, 'observe').mockImplementation(async (app, options) => {
          // Only the observation rejects: backend.act has returned successfully.
          expect(backend.actions).toHaveLength(1)
          if (phase === 'settle' || options.screenshot !== 'none') {
            controller.abort(reason)
            throw reason
          }
          return await originalObserve(app, options)
        })
        const act = vi.spyOn(backend, 'act')
        const action = service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)

        await expect(action).rejects.toMatchObject({
          code: 'COMPUTER_CANCELLED',
          cause: reason,
          message: expect.stringContaining('may already have executed'),
        })
        await expect(action).rejects.toThrow('observe the current state before retrying')
        expect(act).toHaveBeenCalledOnce()
        await expect(act.mock.results[0]?.value).resolves.toMatchObject({ channel: 'accessibility' })
        expect(observe.mock.calls.map(call => call[1].screenshot)).toEqual(
          phase === 'settle' ? ['none'] : ['none', 'optional'],
        )
        expect(backend.actions).toHaveLength(1)
        expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
      } finally {
        await workspace.cleanup()
      }
    },
  )

  it.each(['COMPUTER_TIMEOUT', 'COMPUTER_STALE_OBSERVATION', 'COMPUTER_PERMISSION_REQUIRED'] as const)(
    'preserves provider %s rather than reclassifying a concurrent cancellation',
    async code => {
      const workspace = await temporaryDirectory('dsh-computer-cancel-classification-')
      try {
        const { backend, service } = serviceHarness()
        await service.initializeForTest()
        const controller = new AbortController()
        const context = { ...callContext(fakeAgent(workspace.path), workspace.path), signal: controller.signal }
        const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
        const failure = new ComputerUseError(code, 'provider correction')
        const act = vi.spyOn(backend, 'act').mockImplementation(async () => {
          controller.abort()
          throw failure
        })
        await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context))
          .rejects.toBe(failure)
        expect(act).toHaveBeenCalledOnce()
        expect(failure.message).not.toContain('may already have executed')
      } finally {
        await workspace.cleanup()
      }
    },
  )

  it('keeps a non-cancellation post-action observation error in the provider-failure category', async () => {
    const workspace = await temporaryDirectory('dsh-computer-post-observe-failure-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const cause = new Error('observation unavailable')
      vi.spyOn(backend, 'observe').mockRejectedValue(cause)
      await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_PROVIDER_FAILURE', cause })
      expect(context.signal.aborted).toBe(false)
      expect(backend.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('uses an independent bounded signal for cursor cleanup after cancellation', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-cancel-cleanup-')
    try {
      const { backend, service } = serviceHarness()
      const controller = new AbortController()
      vi.spyOn(backend, 'act').mockImplementation(() => {
        controller.abort()
        return Promise.reject(new ComputerUseError('COMPUTER_CANCELLED', 'fixture action cancelled'))
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = { ...callContext(agent, workspace.path), signal: controller.signal }
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)

      await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CANCELLED' })
      expect(backend.cursorActions.map(entry => entry.phase)).toEqual(['before', 'after'])
      expect(backend.cursorSignals[0]?.aborted).toBe(true)
      expect(backend.cursorSignals[1]?.aborted).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails closed before foreground input when the cursor has no stable window id', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-window-id-')
    try {
      const { backend, service } = serviceHarness()
      backend.observation = backendObservation({
        window: {
          title: 'DSH Computer Use Fixture',
          frame: { x: 100, y: 200, width: 760, height: 592 },
        },
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await expect(service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)).rejects.toMatchObject({
        code: 'COMPUTER_PROVIDER_FAILURE',
        message: expect.stringContaining('no stable window id'),
      })
      expect(backend.cursorActions).toHaveLength(0)
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('activates a background pointer target before running the cursor sequence', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-activate-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.observation = backendObservation({ frontmost: false })
      const activate = vi.spyOn(backend, 'activateForCursor')
      const visualize = vi.spyOn(backend, 'visualizeCursor')
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const result = await service.act({
        kind: 'click',
        observationId: before.observationId,
        x: 300,
        y: 350,
        coordinateSpace: 'window',
      }, context)

      expect(activate).toHaveBeenCalledOnce()
      expect(visualize).toHaveBeenCalled()
      expect(activate.mock.invocationCallOrder[0]).toBeLessThan(visualize.mock.invocationCallOrder[0]!)
      expect(result.activation).toBe('activated')
      expect(backend.actions[0]?.expectedStateHash).toBe(backend.cursorActivations[0])
    } finally {
      await workspace.cleanup()
    }
  })

  it('rebinds a unique target after an unrelated sibling shifts its locator', async () => {
    const workspace = await temporaryDirectory('dsh-computer-rebind-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const target = before.elements.find(element => element.title === 'Apply')!
      expect(target.targetHandle).toEqual(expect.any(String))
      expect(target).not.toHaveProperty('nativeIdentifier')
      target.actions.length = 0
      backend.observation = backendObservation({
        stateHash: 'state-reordered',
        elements: [
          backend.observation.elements[0]!,
          { index: 1, locator: [0], role: 'AXStaticText', label: 'Unrelated status', actions: [] },
          { ...backend.observation.elements[1]!, index: 2, locator: [1] },
        ],
      })
      // Resolve the older handle even after the more recent tree has been published.
      await service.observe({ app: FIXTURE_APP, screenshot: 'none' }, context)

      await expect(service.act({
        kind: 'click',
        observationId: before.observationId,
        elementIndex: target.index,
        targetHandle: target.targetHandle,
        allowRebind: true,
        allowCoordinateFallback: true,
      }, context)).resolves.toMatchObject({
        resolution: {
          mode: 'semantic-rebind',
          candidateCount: 1,
          targetChanged: true,
        },
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers a provider-native identifier over semantic rebinding', async () => {
    const workspace = await temporaryDirectory('dsh-computer-native-rebind-')
    try {
      const { backend, service } = serviceHarness()
      backend.observation = backendObservation({
        elements: backend.observation.elements.map(element => element.index === 1
          ? { ...element, nativeIdentifier: 'fixture.apply' }
          : element),
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const target = before.elements.find(element => element.title === 'Apply')!
      backend.observation = backendObservation({
        stateHash: 'state-native-reordered',
        elements: [
          backend.observation.elements[0]!,
          { index: 1, locator: [0], role: 'AXStaticText', label: 'Unrelated status', actions: [] },
          { ...backend.observation.elements[1]!, index: 2, locator: [1] },
        ],
      })

      await expect(service.act({
        kind: 'click',
        observationId: before.observationId,
        targetHandle: target.targetHandle,
        allowRebind: true,
      }, context)).resolves.toMatchObject({
        resolution: {
          mode: 'native-identifier',
          confidence: 1,
          candidateCount: 1,
          targetChanged: true,
        },
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps an unrelated status update from invalidating an exact handle target', async () => {
    const workspace = await temporaryDirectory('dsh-computer-unrelated-update-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const target = before.elements.find(element => element.title === 'Apply')!
      backend.observation = backendObservation({
        ...backend.observation,
        stateHash: 'state-timer-update',
        treeText: `${backend.observation.treeText}\n  [2] AXStaticText "Timer: 1"`,
        elements: [
          ...backend.observation.elements,
          { index: 2, locator: [1], role: 'AXStaticText', label: 'Timer', value: '1', actions: [] },
        ],
      })

      await expect(service.act({
        kind: 'click',
        observationId: before.observationId,
        targetHandle: target.targetHandle,
        allowRebind: true,
      }, context)).resolves.toMatchObject({
        resolution: {
          mode: 'exact-locator',
          confidence: 1,
          candidateCount: 1,
          targetChanged: false,
        },
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects unscoped, mismatched, and index-only rebinding requests before fresh provider work', async () => {
    const workspace = await temporaryDirectory('dsh-computer-handle-scope-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const window = observation.elements[0]!
      const target = observation.elements[1]!
      const observationsBefore = backend.observations.length

      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        targetHandle: ComputerTargetHandle('unknown-handle'),
        allowRebind: true,
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_TARGET_UNAVAILABLE' })
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        elementIndex: target.index,
        targetHandle: window.targetHandle,
        allowRebind: true,
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_TARGET_UNAVAILABLE' })
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        elementIndex: target.index,
        allowRebind: true,
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_TARGET_UNAVAILABLE' })
      expect(backend.observations).toHaveLength(observationsBefore)
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it.each([
    ['coordinate click', (observationId: ComputerObservationId) => ({
      kind: 'click' as const,
      observationId,
      x: 1,
      y: 2,
    })],
    ['coordinate fallback', (observationId: ComputerObservationId) => ({
      kind: 'click' as const,
      observationId,
      elementIndex: 0,
      allowCoordinateFallback: true,
    })],
    ...(['right', 'middle'] as const).map(button => [
      `${button} element click`,
      (observationId: ComputerObservationId) => ({ kind: 'click' as const, observationId, elementIndex: 1, button }),
    ] as const),
    ...([2, 3] as const).map(clickCount => [
      `element click with count ${clickCount}`,
      (observationId: ComputerObservationId) => ({ kind: 'click' as const, observationId, elementIndex: 1, clickCount }),
    ] as const),
    ['scroll', (observationId: ComputerObservationId) => ({
      kind: 'scroll' as const,
      observationId,
      x: 1,
      y: 2,
      direction: 'down' as const,
    })],
    ['drag', (observationId: ComputerObservationId) => ({
      kind: 'drag' as const,
      observationId,
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
    })],
  ])('blocks %s before control approval or confirmation consumption', async (_name, actionOf) => {
    const workspace = await temporaryDirectory('dsh-computer-pointer-policy-')
    try {
      const { backend, service, request } = serviceHarness({
        interaction: { focusPolicy: 'preserve', pointerInputPolicy: 'deny' },
        grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: false }],
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      request.mockClear()
      await expect(service.act({
        ...actionOf(before.observationId),
        sensitive: true,
        confirmationToken: ComputerConfirmationToken('unconsumed-token'),
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_ACTION_BLOCKED',
      })
      expect(request).not.toHaveBeenCalled()
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects invalid click counts before asking for approval, moving a cursor, or sending input', async () => {
    const workspace = await temporaryDirectory('dsh-computer-click-count-')
    try {
      const { backend, request, service } = serviceHarness()
      await service.initializeForTest()
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      request.mockClear()
      for (const clickCount of [-1, 0, 1.5, 4]) {
        const action = { kind: 'click' as const, observationId: observation.observationId, elementIndex: 1, clickCount, sensitive: true }
        const error = { code: 'COMPUTER_ACTION_BLOCKED', message: expect.stringContaining('clickCount') }
        await expect(service.confirm({ action, reason: 'Test click count', target: 'Apply' }, context)).rejects.toMatchObject(error)
        await expect(service.act(action, context)).rejects.toMatchObject(error)
      }
      expect(request).not.toHaveBeenCalled()
      expect(backend.cursorActions).toHaveLength(0)
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it.each([
    ['right click', { button: 'right' as const }, { x: 110, y: 220 }],
    ['double click with element fallback', { clickCount: 2, allowCoordinateFallback: true }, { x: 110, y: 220 }],
    ['single left click', { button: 'left' as const, allowCoordinateFallback: true }, { x: 260, y: 334 }],
  ] as const)('places the cursor at the input target for a mixed element and point %s', async (_name, gesture, point) => {
    const workspace = await temporaryDirectory('dsh-computer-click-point-')
    try {
      const { backend, service } = serviceHarness()
      await service.initializeForTest()
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1, x: 10, y: 20, ...gesture }, context)
      expect(backend.cursorActions.map(entry => entry.action)).toMatchObject([{ to: point }, { to: point }])
    } finally {
      await workspace.cleanup()
    }
  })

  it('checks pointer policy from opaque-handle evidence before attempting rebinding', async () => {
    const workspace = await temporaryDirectory('dsh-computer-handle-pointer-policy-')
    try {
      const { backend, service } = serviceHarness({
        interaction: { focusPolicy: 'preserve', pointerInputPolicy: 'deny' },
      })
      backend.observation = backendObservation({
        elements: [
          backend.observation.elements[0]!,
          { ...backend.observation.elements[1]!, actions: [] },
        ],
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const target = observation.elements[1]!
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        targetHandle: target.targetHandle,
        allowRebind: true,
        allowCoordinateFallback: true,
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_ACTION_BLOCKED' })
      expect(backend.observations).toHaveLength(1)
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps target-process pointer input available when the host enables it', async () => {
    const workspace = await temporaryDirectory('dsh-computer-pointer-allow-')
    try {
      const { backend, service } = serviceHarness({
        interaction: { focusPolicy: 'preserve', pointerInputPolicy: 'targeted' },
      })
      backend.actionChannel = 'coordinates'
      backend.actionActivation = 'not-requested'
      backend.actionPointerInput = true
      backend.actionPointerRouting = 'target-process'
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const result = await service.act({ kind: 'drag', observationId: before.observationId, fromX: 1, fromY: 2, toX: 3, toY: 4 }, context)
      expect(result).toMatchObject({
        channel: 'coordinates',
        activation: 'not-requested',
        pointerInput: true,
        pointerRouting: 'target-process',
      })
      expect(backend.cursorActions).toEqual([
        {
          phase: 'before',
          action: { kind: 'drag', from: { x: 101, y: 202 }, to: { x: 103, y: 204 }, targetPid: FIXTURE_APP.pid, targetWindowNumber: 7, targetWindowFrame: { x: 100, y: 200, width: 760, height: 592 } },
        },
        {
          phase: 'during',
          action: { kind: 'drag', from: { x: 101, y: 202 }, to: { x: 103, y: 204 }, targetPid: FIXTURE_APP.pid, targetWindowNumber: 7, targetWindowFrame: { x: 100, y: 200, width: 760, height: 592 } },
        },
        {
          phase: 'after',
          action: { kind: 'drag', from: { x: 101, y: 202 }, to: { x: 103, y: 204 }, targetPid: FIXTURE_APP.pid, targetWindowNumber: 7, targetWindowFrame: { x: 100, y: 200, width: 760, height: 592 } },
        },
      ])
    } finally {
      await workspace.cleanup()
    }
  })

  it('can hide the Agent cursor without changing native input behavior', async () => {
    const workspace = await temporaryDirectory('dsh-computer-cursor-hidden-')
    try {
      const { backend, service } = serviceHarness({
        interaction: {
          focusPolicy: 'preserve',
          pointerInputPolicy: 'targeted',
          cursorVisualization: 'hidden',
        },
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await service.act({ kind: 'click', observationId: before.observationId, elementIndex: 1 }, context)
      expect(backend.actions).toHaveLength(1)
      expect(backend.cursorActions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('blocks AXRaise before control approval when foreground activation is not authorized', async () => {
    const workspace = await temporaryDirectory('dsh-computer-raise-policy-')
    try {
      const { backend, service, request } = serviceHarness({
        interaction: { focusPolicy: 'preserve', pointerInputPolicy: 'targeted' },
        grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: false }],
      })
      backend.observation = backendObservation({
        elements: [{
          index: 0,
          locator: [],
          role: 'AXWindow',
          title: 'DSH Computer Use Fixture',
          actions: ['AXRaise'],
          frame: { x: 100, y: 200, width: 760, height: 592 },
        }],
      })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      request.mockClear()
      await expect(service.act({
        kind: 'perform-action',
        observationId: observation.observationId,
        elementIndex: 0,
        action: 'AXRaise',
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_ACTION_BLOCKED' })
      expect(request).not.toHaveBeenCalled()
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('scopes observations to one Agent, expires them, and releases them on disposal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T04:00:00Z'))
    const workspace = await temporaryDirectory('dsh-computer-scope-')
    try {
      const { service } = serviceHarness({ observationTtlMs: 1000 })
      const owner = fakeAgent(workspace.path, 'owner')
      const other = fakeAgent(workspace.path, 'other')
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, callContext(owner, workspace.path))
      await expect(service.act({ kind: 'click', observationId: observation.observationId, elementIndex: 1 }, callContext(other, workspace.path)))
        .rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })
      vi.setSystemTime(new Date('2026-08-11T04:00:02Z'))
      await expect(service.act({ kind: 'click', observationId: observation.observationId, elementIndex: 1 }, callContext(owner, workspace.path)))
        .rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })

      vi.setSystemTime(new Date('2026-08-11T04:00:03Z'))
      const fresh = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, callContext(owner, workspace.path))
      service.releaseAgent(owner)
      await expect(service.act({ kind: 'click', observationId: fresh.observationId, elementIndex: 1 }, callContext(owner, workspace.path)))
        .rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps observations reusable when observationTtlMs is zero', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T04:00:00Z'))
    const workspace = await temporaryDirectory('dsh-computer-ttl-off-')
    try {
      const { service } = serviceHarness({ observationTtlMs: 0 })
      const agent = fakeAgent(workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, callContext(agent, workspace.path))
      expect(observation.expiresAt).toBe('9999-12-31T23:59:59.999Z')
      vi.setSystemTime(new Date('2026-08-11T05:00:00Z'))
      await expect(service.act({ kind: 'click', observationId: observation.observationId, elementIndex: 1 }, callContext(agent, workspace.path)))
        .resolves.toMatchObject({ action: 'click' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('invalidates observations when the provider generation changes', async () => {
    const workspace = await temporaryDirectory('dsh-computer-generation-')
    try {
      const { service } = serviceHarness()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const replacement = new FakeBackend()
      await service.reconfigureForTest(replacement, {
        settleMs: 0,
        maxSettleMs: 100,
        grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: true }],
      })
      expect(service.status().generation).toBe(2)
      await expect(service.act({ kind: 'click', observationId: observation.observationId, elementIndex: 1 }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })
    } finally {
      await workspace.cleanup()
    }
  })

  it.each(['observe', 'wait'] as const)('discards a late %s screenshot after its provider is replaced', async kind => {
    const workspace = await temporaryDirectory('dsh-computer-generation-capture-')
    try {
      const { service, backend } = serviceHarness({ maxSettleMs: 5000 })
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const request = { app: FIXTURE_APP, screenshot: 'required' as const }
      const initial = kind === 'wait' ? await service.observe(request, context) : undefined
      const captured = Promise.withResolvers<string>()
      const finish = Promise.withResolvers<void>()
      const observe = backend.observe.bind(backend)
      vi.spyOn(backend, 'observe').mockImplementationOnce(async (app, options) => {
        const snapshot = await observe(app, options)
        if (snapshot.screenshot === undefined) throw new Error('expected a captured fixture screenshot')
        captured.resolve(snapshot.screenshot.path)
        await finish.promise
        return snapshot
      })
      const pending = initial === undefined
        ? service.observe(request, context)
        : service.act({ kind: 'wait', observationId: initial.observationId, condition: { elementTitle: 'Apply' } }, context)
      const capturedPath = await captured.promise
      const replacement = new FakeBackend()
      replacement.observation.treeText = 'replacement window'
      await service.reconfigureForTest(replacement, { allowAllApps: true })
      finish.resolve()

      await expect(pending).rejects.toMatchObject({ code: 'COMPUTER_CANCELLED' })
      expect(replacement.observations).toHaveLength(0)
      expect(await readdir(dirname(capturedPath))).toEqual(initial?.screenshot ? [initial.screenshot.filename] : [])
      const fresh = await service.observe({ app: FIXTURE_APP, screenshot: 'none' }, context)
      expect(fresh.tree).toMatchObject({ mode: 'full', text: 'replacement window' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('discards a late control approval before dispatch and asks again under the replacement', async () => {
    const workspace = await temporaryDirectory('dsh-computer-generation-approval-')
    try {
      const config = { settleMs: 0, grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: false }] }
      const { service, backend, request } = serviceHarness(config)
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const observe = { app: FIXTURE_APP, screenshot: 'none' as const }
      const original = await service.observe(observe, context)
      const asked = Promise.withResolvers<void>()
      const decision = Promise.withResolvers<ApprovalOutcome>()
      request.mockImplementationOnce(() => { asked.resolve(); return decision.promise })
      const pending = service.act({ kind: 'click', observationId: original.observationId, elementIndex: 1 }, context)
      await asked.promise
      const replacement = new FakeBackend()
      await service.reconfigureForTest(replacement, config)
      decision.resolve('allowed-once')

      await expect(pending).rejects.toMatchObject({
        code: 'COMPUTER_CANCELLED',
        message: expect.not.stringContaining('may already have executed'),
      })
      expect(backend.actions).toHaveLength(0)
      expect(replacement.actions).toHaveLength(0)
      expect(replacement.cursorActions).toHaveLength(0)
      expect(replacement.observations).toHaveLength(0)
      const fresh = await service.observe(observe, context)
      await service.act({ kind: 'click', observationId: fresh.observationId, elementIndex: 1 }, context)
      expect(request).toHaveBeenCalledTimes(2)
      expect(replacement.actions).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns only for dispatched input and keeps queued work and cursor cleanup off the replacement', async () => {
    const workspace = await temporaryDirectory('dsh-computer-generation-dispatch-')
    try {
      const { service, backend } = serviceHarness()
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const first = await service.observe({ app: FIXTURE_APP, screenshot: 'none' }, context)
      const started = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      const act = backend.act.bind(backend)
      vi.spyOn(backend, 'act').mockImplementationOnce(async request => {
        const result = await act(request)
        started.resolve()
        await finish.promise
        return result
      })
      const click = { kind: 'click' as const, observationId: first.observationId, elementIndex: 1 }
      const inFlight = service.act(click, context)
      await started.promise
      const queued = service.act(click, context)
      const replacement = new FakeBackend()
      await service.reconfigureForTest(replacement, {})
      finish.resolve()
      await Promise.all([
        expect(inFlight).rejects.toMatchObject({
          code: 'COMPUTER_CANCELLED',
          message: expect.stringContaining('may already have executed'),
        }),
        expect(queued).rejects.toMatchObject({
          code: 'COMPUTER_CANCELLED',
          message: expect.not.stringContaining('may already have executed'),
        }),
      ])
      expect(backend.actions).toHaveLength(1)
      expect(replacement.actions).toHaveLength(0)
      expect(replacement.cursorActions).toHaveLength(0)
      expect(replacement.observations).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('cancels late sensitive approvals when their Agent is disposed', async () => {
    const workspace = await temporaryDirectory('dsh-computer-agent-confirm-')
    try {
      const { service, request } = serviceHarness()
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const before = await service.observe({ app: FIXTURE_APP, screenshot: 'none' }, context)
      const asked = Promise.withResolvers<void>()
      const decision = Promise.withResolvers<ApprovalOutcome>()
      request.mockImplementationOnce(() => { asked.resolve(); return decision.promise })
      const action = { kind: 'click' as const, observationId: before.observationId, elementIndex: 1, sensitive: true }
      const pending = service.confirm({ action, reason: 'Apply the fixture change', target: 'Apply button' }, context)
      await asked.promise
      service.releaseAgent(context.agent)
      decision.resolve('allowed-once')

      await expect(pending).rejects.toMatchObject({ code: 'COMPUTER_CANCELLED' })
      await expect(service.act(action, context)).rejects.toMatchObject({ code: 'COMPUTER_STALE_OBSERVATION' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('applies overlapping Settings in submission order and ignores a late health result from the old backend', async () => {
    const { service, backend } = serviceHarness()
    const healthStarted = Promise.withResolvers<void>()
    const finishHealth = Promise.withResolvers<void>()
    vi.spyOn(backend, 'health').mockImplementationOnce(async () => {
      healthStarted.resolve()
      await finishHealth.promise
      return backend.healthValue
    })
    const health = service.health(new AbortController().signal)
    await healthStarted.promise

    const first = new FakeBackend()
    const firstStarted = Promise.withResolvers<void>()
    const finishFirst = Promise.withResolvers<void>()
    vi.spyOn(first, 'health').mockImplementationOnce(async () => {
      firstStarted.resolve()
      await finishFirst.promise
      return first.healthValue
    })
    const last = new FakeBackend()
    last.healthValue.helperVersion = 'last-settings'
    const checkLast = vi.spyOn(last, 'health')
    const firstUpdate = service.reconfigureForTest(first, {})
    await firstStarted.promise
    const lastUpdate = service.reconfigureForTest(last, {})
    await Promise.resolve()
    expect(checkLast).not.toHaveBeenCalled()
    finishFirst.resolve()
    await Promise.all([firstUpdate, lastUpdate])
    finishHealth.resolve()

    await expect(health).rejects.toMatchObject({ code: 'COMPUTER_CANCELLED' })
    expect(service.status()).toMatchObject({ generation: 3, helperVersion: 'last-settings', ready: true })
    expect(backend.disposed).toBe(true)
    expect(first.disposed).toBe(true)
    expect(last.disposed).toBe(false)
  })

  it('keeps failed candidates with their owner and accepts a healthy replacement even if retired cleanup fails', async () => {
    const { service, backend } = serviceHarness()
    const broken = new FakeBackend()
    const failure = new Error('candidate could not start')
    vi.spyOn(broken, 'health').mockRejectedValue(failure)
    const releaseCandidate = vi.spyOn(broken, 'dispose')
    const releaseActive = vi.spyOn(backend, 'dispose').mockRejectedValue(new Error('retired backend cleanup failed'))

    await expect(service.reconfigureForTest(broken, {})).rejects.toBe(failure)
    expect(service.status().generation).toBe(1)
    expect(releaseCandidate).not.toHaveBeenCalled()
    expect(releaseActive).not.toHaveBeenCalled()

    const healthy = new FakeBackend()
    healthy.healthValue.helperVersion = 'replacement'
    await expect(service.reconfigureForTest(healthy, {})).resolves.toBeUndefined()
    expect(releaseActive).toHaveBeenCalledOnce()
    expect(healthy.disposed).toBe(false)
    expect(await service.health(new AbortController().signal)).toMatchObject({
      generation: 2, helperVersion: 'replacement', ready: true,
    })
  })

  it('persists read leases for the Session and control leases for the current turn', async () => {
    const workspace = await temporaryDirectory('dsh-computer-leases-')
    try {
      const { service, request, rows, order } = serviceHarness({ grants: [] })
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const first = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      expect(request).toHaveBeenCalledTimes(1)
      const firstAction = await service.act({ kind: 'click', observationId: first.observationId, elementIndex: 1 }, context)
      expect(request).toHaveBeenCalledTimes(2)
      await service.act({ kind: 'click', observationId: firstAction.observation.observationId, elementIndex: 1 }, context)
      expect(request).toHaveBeenCalledTimes(2)
      expect(rows.get(agent.session.id)).toEqual({
        session: { createdAt: agent.session.header.createdAt, cwd: workspace.path },
        readGrants: [FIXTURE_APP.bundleId],
        denied: [],
      })
      expect(order.slice(0, 3)).toEqual(['approval:decided', 'session:flushed', 'sidecar:durable'])
      expect(agent.session.events.some(event => event.type.startsWith('computer-use/'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails closed when an application lease is unavailable or requested outside a turn', async () => {
    const workspace = await temporaryDirectory('dsh-computer-lease-denied-')
    try {
      const denied = serviceHarness({ grants: [] }, 'unavailable')
      const agent = fakeAgent(workspace.path)
      await expect(denied.service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, callContext(agent, workspace.path)))
        .rejects.toMatchObject({ code: 'COMPUTER_PERMISSION_REQUIRED' })
      agent.session.events.push({ type: 'turn/end', data: { turn: 1 } })
      await expect(denied.service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, callContext(agent, workspace.path)))
        .rejects.toThrow(/open Agent turn/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('records a rejected approval for the Session and does not ask again for the same app and scope', async () => {
    const workspace = await temporaryDirectory('dsh-computer-lease-rejected-')
    try {
      const { service, request, rows } = serviceHarness({ grants: [] }, 'rejected')
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      await expect(service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_PERMISSION_REQUIRED' })
      await expect(service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_PERMISSION_REQUIRED' })
      expect(request).toHaveBeenCalledTimes(1)
      expect(rows.get(agent.session.id)?.denied).toEqual([{ bundleId: FIXTURE_APP.bundleId, scope: 'read' }])
      expect(agent.session.events.some(event => event.type.startsWith('computer-use/'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('blocks un-granted apps without an approval ask when approval prompts are disabled', async () => {
    const workspace = await temporaryDirectory('dsh-computer-policy-never-')
    try {
      const { service, request } = serviceHarness({ grants: [] }, 'allowed-once', 'never')
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      await expect(service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context))
        .rejects.toMatchObject({
          code: 'COMPUTER_PERMISSION_REQUIRED',
          message: expect.stringContaining('approval prompts are disabled'),
        })
      await expect(service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_PERMISSION_REQUIRED' })
      expect(request).not.toHaveBeenCalled()
      expect(agent.session.events.some(event => event.type.startsWith('computer-use/'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps static grants and current-turn control approval usable without storage-domain', async () => {
    const workspace = await temporaryDirectory('dsh-computer-no-storage-control-')
    try {
      const configured = serviceHarness({}, 'allowed-once', 'ask', { storage: false })
      const configuredAgent = fakeAgent(workspace.path, 'configured-no-storage')
      await expect(configured.service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        callContext(configuredAgent, workspace.path),
      )).resolves.toBeDefined()
      expect(configured.request).not.toHaveBeenCalled()

      const interactive = serviceHarness({
        grants: [{ bundleId: FIXTURE_APP.bundleId, read: true, control: false }],
      }, 'allowed-once', 'ask', { storage: false })
      const agent = fakeAgent(workspace.path, 'control-no-storage')
      const context = callContext(agent, workspace.path)
      const first = await interactive.service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        context,
      )
      const result = await interactive.service.act(
        { kind: 'click', observationId: first.observationId, elementIndex: 1 },
        context,
      )
      await interactive.service.act(
        { kind: 'click', observationId: result.observation.observationId, elementIndex: 1 },
        context,
      )
      expect(interactive.request).toHaveBeenCalledTimes(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails clearly before asking for a Session-wide read grant without storage-domain', async () => {
    const workspace = await temporaryDirectory('dsh-computer-no-storage-read-')
    try {
      const { service, request } = serviceHarness({ grants: [] }, 'allowed-once', 'ask', { storage: false })
      const agent = fakeAgent(workspace.path)
      await expect(service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        callContext(agent, workspace.path),
      )).rejects.toMatchObject({
        code: 'COMPUTER_PERMISSION_REQUIRED',
        message: expect.stringContaining('ctx.storageDomain'),
      })
      expect(request).not.toHaveBeenCalled()
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a stale sidecar row when a Session id is reused with another header identity', async () => {
    const workspace = await temporaryDirectory('dsh-computer-sidecar-identity-')
    try {
      const { service, request, rows } = serviceHarness({ grants: [] })
      const first = fakeAgent(workspace.path, 'reused')
      await service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        callContext(first, workspace.path),
      )
      const replacement = fakeAgent(workspace.path, 'reused')
      ;(replacement.session.header as { createdAt: number }).createdAt += 1
      await service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        callContext(replacement, workspace.path),
      )
      expect(request).toHaveBeenCalledTimes(2)
      expect(rows.get(replacement.session.id)?.session.createdAt).toBe(replacement.session.header.createdAt)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not publish a read grant when Session persistence does not participate in flush', async () => {
    const workspace = await temporaryDirectory('dsh-computer-no-flush-')
    try {
      const { service, rows } = serviceHarness(
        { grants: [] },
        'allowed-once',
        'ask',
        { flushParticipates: false },
      )
      const agent = fakeAgent(workspace.path)
      await expect(service.observe(
        { app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' },
        callContext(agent, workspace.path),
      )).rejects.toMatchObject({
        code: 'COMPUTER_PERMISSION_REQUIRED',
        message: expect.stringContaining('no Session persistence listener participated'),
      })
      expect(rows.has(agent.session.id)).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('allows every app when allowAllApps is enabled, even with approval prompts disabled', async () => {
    const workspace = await temporaryDirectory('dsh-computer-allow-all-')
    try {
      const { service, request } = serviceHarness({ grants: [], allowAllApps: true }, 'allowed-once', 'never')
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      await expect(service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)).resolves.toBeDefined()
      expect(request).not.toHaveBeenCalled()
    } finally {
      await workspace.cleanup()
    }
  })

  it('blocks sensitive confirmation without an approval ask when approval prompts are disabled', async () => {
    const workspace = await temporaryDirectory('dsh-computer-confirm-policy-never-')
    try {
      const { service, request } = serviceHarness({}, 'allowed-once', 'never')
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const proposed: ComputerActionRequest = {
        kind: 'click',
        observationId: observation.observationId,
        elementIndex: 1,
        sensitive: true,
      }
      await expect(service.confirm({ action: proposed, reason: 'Publish a fixture state', target: 'fixture' }, context))
        .rejects.toMatchObject({
          code: 'COMPUTER_CONFIRMATION_REQUIRED',
          message: expect.stringContaining('approval prompts are disabled'),
        })
      expect(request).not.toHaveBeenCalled()
    } finally {
      await workspace.cleanup()
    }
  })

  it('binds sensitive confirmation to one exact app, observation, and action, then consumes it once', async () => {
    const workspace = await temporaryDirectory('dsh-computer-confirm-')
    try {
      const { service, request } = serviceHarness()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const proposed: ComputerActionRequest = {
        kind: 'click',
        observationId: observation.observationId,
        elementIndex: 1,
        sensitive: true,
      }
      const confirmation = await service.confirm({ action: proposed, reason: 'Publish a fixture state', target: 'fixture' }, context)
      expect(request).toHaveBeenCalledTimes(1)
      await expect(service.act({ ...proposed, clickCount: 2, confirmationToken: confirmation.token }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })
      await expect(service.act({ ...proposed, confirmationToken: confirmation.token }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })

      const next = await service.confirm({ action: proposed, reason: 'Publish a fixture state', target: 'fixture' }, context)
      const result = await service.act({ ...proposed, confirmationToken: next.token }, context)
      expect(result.action).toBe('click')
      await expect(service.act({ ...proposed, confirmationToken: next.token }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })
      await expect(service.act({ ...proposed, confirmationToken: ComputerConfirmationToken('unknown') }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('invalidates one-use confirmation when a sensitive target rebinds', async () => {
    const workspace = await temporaryDirectory('dsh-computer-confirm-rebind-')
    try {
      const { backend, service } = serviceHarness({ interaction: { focusPolicy: 'activate' } })
      backend.observation = backendObservation({ frontmost: false })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      const target = observation.elements.find(element => element.title === 'Apply')!
      const proposed: ComputerActionRequest = {
        kind: 'click',
        observationId: observation.observationId,
        targetHandle: target.targetHandle,
        allowRebind: true,
        allowCoordinateFallback: true,
        sensitive: true,
      }
      const confirmation = await service.confirm({ action: proposed, reason: 'Publish a fixture state', target: 'fixture' }, context)
      const original = structuredClone(backend.observation)
      backend.observation = backendObservation({
        stateHash: 'state-sensitive-reordered',
        elements: [
          original.elements[0]!,
          { index: 1, locator: [0], role: 'AXStaticText', label: 'Unrelated status', actions: [] },
          { ...original.elements[1]!, index: 2, locator: [1] },
        ],
      })

      await expect(service.act({ ...proposed, confirmationToken: confirmation.token }, context)).rejects.toMatchObject({
        code: 'COMPUTER_TARGET_REBIND_REQUIRES_CONFIRMATION',
      })
      expect(backend.actions).toHaveLength(0)
      expect(backend.cursorActivations).toHaveLength(0)

      backend.observation = original
      await expect(service.act({ ...proposed, confirmationToken: confirmation.token }, context)).rejects.toMatchObject({
        code: 'COMPUTER_CONFIRMATION_REQUIRED',
      })
      expect(backend.actions).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('builds handles for a wide tree with linear locator reads', async () => {
    const { service, backend } = serviceHarness()
    const context = callContext(fakeAgent('/fixture'), '/fixture')
    let reads = 0
    const elements = Array.from({ length: 128 }, (_, index) => {
      const locator = index === 0 ? [] : [index - 1]
      return {
        index, role: index === 0 ? 'AXWindow' : 'AXButton', actions: [],
        get locator() {
          reads++
          return locator
        },
      }
    })
    vi.spyOn(backend, 'observe').mockResolvedValue(backendObservation({ elements }))
    const observed = await service.observe({ app: FIXTURE_APP, screenshot: 'none' }, context)
    expect(new Set(observed.elements.map(element => element.targetHandle)).size).toBe(elements.length)
    // Publishing handles can strip locators once per row. Ancestor indexing starts on use.
    expect(reads).toBeLessThanOrEqual(elements.length)
  })

  it('marks a clipped diff even when both source trees fit the byte limit', async () => {
    const workspace = await temporaryDirectory('dsh-computer-diff-')
    try {
      const { backend, service } = serviceHarness({ maxTextBytes: 1024 })
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const request = { app: FIXTURE_APP, screenshot: 'none' as const }
      for (const version of ['前', '后']) {
        const elements = Array.from({ length: 8 }, (_, index) => ({
          index, locator: [index], role: 'AXButton', title: version.repeat(30) + index, actions: ['AXPress'],
        }))
        const treeText = elements.map(row => `[${row.index}] AXButton "${row.title}"`).join('\n')
        expect(Buffer.byteLength(treeText)).toBeLessThan(1024)
        backend.observation = backendObservation({ elements, treeText, truncated: false })
        const observation = await service.observe(request, context)
        expect(observation.tree.truncated).toBe(version === '后')
        expect(Buffer.byteLength(observation.tree.text)).toBeLessThanOrEqual(1024)
      }
    } finally {
      await workspace.cleanup()
    }
  })

  it.each(['none', 'required'] as const)('rechecks a formerly matching control and cleans up unmatched images (%s)', async screenshot => {
    const workspace = await temporaryDirectory('dsh-computer-wait-stale-')
    try {
      const { backend, service } = serviceHarness({ settleMs: 10, maxSettleMs: 200 })
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const before = await service.observe({ app: FIXTURE_APP, screenshot }, context)
      backend.observation = backendObservation({
        stateHash: 'different-controls',
        elements: [
          { index: 0, locator: [], role: 'AXButton', title: 'Cancel', actions: ['AXPress'] },
          { index: 1, locator: [0], role: 'AXStaticText', title: 'Apply', actions: [] },
        ],
      })
      await expect(service.act({
        kind: 'wait', observationId: before.observationId, timeoutMs: 100,
        condition: { elementRole: 'AXButton', elementTitle: 'Apply' },
      }, context)).rejects.toMatchObject({ code: 'COMPUTER_TIMEOUT' })
      expect(backend.observations.length).toBeGreaterThan(1)
      if (before.screenshot !== undefined) {
        expect(await readdir(dirname(before.screenshot.path))).toEqual([basename(before.screenshot.path)])
      }
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns the matching screenshot snapshot when a condition disappears during capture', async () => {
    const workspace = await temporaryDirectory('dsh-computer-wait-transient-')
    try {
      const { backend, service } = serviceHarness({ settleMs: 10, maxSettleMs: 500 })
      const context = callContext(fakeAgent(workspace.path), workspace.path)
      const before = await service.observe({ app: FIXTURE_APP, screenshot: 'required' }, context)
      const observe = backend.observe.bind(backend)
      const states = ['Ready', 'Busy', 'Ready', 'Ready']
      vi.spyOn(backend, 'observe').mockImplementation((app, options) => {
        const title = states.shift()
        if (title === undefined) throw new Error('unexpected extra observation')
        backend.observation = backendObservation({
          stateHash: title, treeText: title,
          elements: [{ index: 0, locator: [], role: 'AXButton', title, actions: ['AXPress'] }],
        })
        return observe(app, options)
      })
      const result = await service.act({
        kind: 'wait', observationId: before.observationId, condition: { elementTitle: 'Ready' },
      }, context)
      expect(result.observation.elements[0]?.title).toBe('Ready')
      expect(result.observation.screenshot).toBeDefined()
      expect(backend.observations.map(call => call.screenshot)).toEqual(['required', 'none', 'optional', 'none', 'optional'])
      expect(await readdir(dirname(before.screenshot!.path))).toHaveLength(2)
    } finally {
      await workspace.cleanup()
    }
  })

  it('waits for a bounded condition and returns the matching fresh observation', async () => {
    const workspace = await temporaryDirectory('dsh-computer-wait-')
    try {
      const { backend, service } = serviceHarness({ settleMs: 10, maxSettleMs: 300 })
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      setTimeout(() => {
        backend.observation = backendObservation({
          ...backend.observation,
          stateHash: 'delayed-state',
          treeText: `${backend.observation.treeText}\nStatus: delayed complete`,
          elements: [...backend.observation.elements, {
            index: backend.observation.elements.length,
            locator: [99],
            role: 'AXStaticText',
            value: 'Status: delayed complete',
            actions: [],
          }],
        })
      }, 30)
      const result = await service.act({
        kind: 'wait',
        observationId: observation.observationId,
        condition: { text: 'delayed complete' },
        timeoutMs: 200,
      }, context)
      expect(result.channel).toBe('wait')
      expect(result.effect.observedStateChanged).toBe(true)
      expect(result.observation.tree.text).toContain('delayed complete')

      const alreadySatisfied = await service.act({
        kind: 'wait',
        observationId: result.observation.observationId,
        condition: { text: 'delayed complete' },
        timeoutMs: 200,
      }, context)
      expect(alreadySatisfied.effect).toMatchObject({
        observedStateChanged: false,
        note: 'the wait condition was already satisfied by the referenced observation',
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves screen coordinates untouched and prefers the provider pixel scale', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-screen-')
    try {
      const { backend, service } = serviceHarness()
      backend.screenshotSize = { width: 1520, height: 1184 }
      backend.screenshotPixelScale = 2
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      expect(observation.screenshot?.pixelScale).toBe(2)

      await service.act({
        kind: 'click',
        observationId: observation.observationId,
        x: 1500,
        y: 1100,
        coordinateSpace: 'screen',
      }, context)
      expect(backend.actions.at(-1)?.action).toMatchObject({ kind: 'click', coordinateSpace: 'screen', x: 1500, y: 1100 })
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails closed when screenshot dimensions do not match the reported scale', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-scale-')
    try {
      const { backend, service } = serviceHarness()
      backend.screenshotSize = { width: 1600, height: 1184 }
      backend.screenshotPixelScale = 2
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        x: 520,
        y: 668,
        coordinateSpace: 'screenshot',
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_STALE_OBSERVATION',
        message: expect.stringContaining('observe again'),
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('confirms then executes a screenshot-space sensitive action with one token', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-confirm-')
    try {
      const { backend, service } = serviceHarness()
      backend.screenshotSize = { width: 1520, height: 1184 }
      backend.screenshotPixelScale = 2
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      const proposed: ComputerActionRequest = {
        kind: 'click',
        observationId: observation.observationId,
        x: 520,
        y: 668,
        coordinateSpace: 'screenshot',
        sensitive: true,
      }
      const confirmation = await service.confirm({ action: proposed, reason: 'Activate a fixture control', target: 'fixture' }, context)
      const result = await service.act({ ...proposed, confirmationToken: confirmation.token }, context)
      expect(result.action).toBe('click')
      expect(backend.actions.at(-1)?.action).toMatchObject({ kind: 'click', coordinateSpace: 'window', x: 260, y: 334 })
      await expect(service.act({ ...proposed, confirmationToken: confirmation.token }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_CONFIRMATION_REQUIRED' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a missing window frame for screenshot coordinates instead of asking for a screenshot', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-nowindow-')
    try {
      const { backend, service } = serviceHarness()
      backend.observation = backendObservation({ window: undefined })
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        x: 20,
        y: 20,
        coordinateSpace: 'screenshot',
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_TARGET_UNAVAILABLE',
        message: expect.stringContaining('no window frame'),
      })
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('screenshot coordinate space', () => {
  it('maps 2x screenshot pixels onto window points for click, scroll, and drag', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-space-')
    try {
      const { backend, service } = serviceHarness()
      backend.screenshotSize = { width: 1520, height: 1184 }
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)

      const before = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      expect(before.screenshot?.pixelScale).toBe(2)
      expect(before.screenshot).toMatchObject({ width: 1520, height: 1184 })

      const clicked = await service.act({
        kind: 'click',
        observationId: before.observationId,
        x: 520,
        y: 668,
        coordinateSpace: 'screenshot',
      }, context)
      expect(backend.actions.at(-1)?.action).toMatchObject({
        kind: 'click',
        coordinateSpace: 'window',
        x: 260,
        y: 334,
      })
      // The Agent cursor travels to the same window point the click uses.
      expect(backend.cursorActions.at(-2)?.action).toMatchObject({ to: { x: 360, y: 534 } })

      await service.act({
        kind: 'scroll',
        observationId: clicked.observation.observationId,
        x: 520,
        y: 668,
        direction: 'down',
        coordinateSpace: 'screenshot',
      }, context)
      expect(backend.actions.at(-1)?.action).toMatchObject({
        kind: 'scroll',
        coordinateSpace: 'window',
        x: 260,
        y: 334,
        direction: 'down',
      })

      const dragObservation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      await service.act({
        kind: 'drag',
        observationId: dragObservation.observationId,
        fromX: 40,
        fromY: 60,
        toX: 520,
        toY: 668,
        coordinateSpace: 'screenshot',
      }, context)
      expect(backend.actions.at(-1)?.action).toMatchObject({
        kind: 'drag',
        coordinateSpace: 'window',
        fromX: 20,
        fromY: 30,
        toX: 260,
        toY: 334,
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects screenshot coordinates without a captured screenshot', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-missing-')
    try {
      const { service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      expect(observation.screenshot).toBeUndefined()
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        x: 20,
        y: 20,
        coordinateSpace: 'screenshot',
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_TARGET_UNAVAILABLE',
        message: expect.stringContaining("coordinateSpace 'screenshot'"),
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('explains window coordinates that only fit the screenshot pixel space', async () => {
    const workspace = await temporaryDirectory('dsh-computer-screenshot-hint-')
    try {
      const { backend, service } = serviceHarness()
      backend.screenshotSize = { width: 1520, height: 1184 }
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'required' }, context)
      await expect(service.act({
        kind: 'click',
        observationId: observation.observationId,
        x: 1200,
        y: 900,
        coordinateSpace: 'window',
      }, context)).rejects.toMatchObject({
        code: 'COMPUTER_TARGET_UNAVAILABLE',
        message: expect.stringContaining('pixelScale 2'),
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects an empty wait condition immediately instead of running the timeout', async () => {
    const workspace = await temporaryDirectory('dsh-computer-wait-empty-')
    try {
      const { service } = serviceHarness()
      await service.initializeForTest()
      const agent = fakeAgent(workspace.path)
      const context = callContext(agent, workspace.path)
      const observation = await service.observe({ app: { bundleId: FIXTURE_APP.bundleId }, screenshot: 'none' }, context)
      vi.useFakeTimers()
      const started = Date.now()
      await expect(service.act({ kind: 'wait', observationId: observation.observationId, condition: {}, timeoutMs: 100 }, context))
        .rejects.toMatchObject({ code: 'COMPUTER_ACTION_BLOCKED' })
      expect(Date.now() - started).toBe(0)
      vi.useRealTimers()
    } finally {
      await workspace.cleanup()
    }
  })
})
