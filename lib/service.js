/** Provider-independent Computer Use Service: leases, observations, staleness, confirmations, and fresh post-action state. */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Service } from '@deepseek-ai/cordis';
import { allocateScreenshotPath, describeScreenshot } from "./artifacts.js";
import { ComputerConfirmationManager } from "./confirmations.js";
import { projectElementDiff } from "./diff.js";
import { ComputerUseError, computerUseError } from "./errors.js";
import { ComputerLeaseManager } from "./leases.js";
import { describeComputerTarget, indexElementsByLocator, resolveComputerTarget, } from "./target-resolver.js";
import { ComputerObservationId, ComputerTargetHandle, } from "./types.js";
function publicElements(observation) {
    const targets = new Map();
    const elements = observation.elements.map((backendElement) => {
        const { locator: _locator, nativeIdentifier: _nativeIdentifier, actions, frame, ...element } = backendElement;
        const targetHandle = ComputerTargetHandle(randomUUID());
        targets.set(targetHandle, backendElement);
        // Public results are mutable. Keep the original actions and geometry as provider evidence.
        return { ...element, targetHandle, actions: [...actions], ...(frame === undefined ? {} : { frame: { ...frame } }) };
    });
    return { elements, targets };
}
function describeStoredTarget(stored, element) {
    const cache = stored.targetCache ??= {
        byLocator: indexElementsByLocator(stored.backend),
        descriptors: new Map(),
    };
    let descriptor = cache.descriptors.get(element);
    if (descriptor === undefined) {
        descriptor = describeComputerTarget(element, stored.backend, cache.byLocator);
        cache.descriptors.set(element, descriptor);
    }
    return descriptor;
}
/** Screenshot pixels per window point, or undefined when either is unavailable. */
function screenshotPixelScale(observation) {
    const frame = observation.window?.frame;
    const screenshot = observation.screenshot;
    if (frame === undefined || screenshot === undefined || frame.width <= 0 || frame.height <= 0)
        return undefined;
    // Prefer the provider's own scale: the image dimensions alone cannot reveal
    // shadow framing or non-uniform pixel scale.
    const reported = screenshot.pixelScale;
    if (reported !== undefined)
        return Number.isFinite(reported) && reported > 0 ? reported : undefined;
    const scale = screenshot.width / frame.width;
    return Number.isFinite(scale) && scale > 0 ? scale : undefined;
}
function requiresCoordinates(action) {
    switch (action.kind) {
        case 'click': return action.x !== undefined || action.y !== undefined;
        case 'scroll': return action.x !== undefined || action.y !== undefined;
        case 'drag': return true;
        case 'set-value':
        case 'type-text':
        case 'press-key':
        case 'perform-action': return false;
    }
}
/**
 * Validate the click count before confirmation or input. Translate screenshot
 * pixels into window points and flag window coordinates that only make sense as
 * screenshot pixels.
 *
 * A macOS screenshot is captured at the window's backing scale (usually 2x on
 * Retina), while element frames, `coordinateSpace: window` and the provider all
 * speak points. A coordinate read off the screenshot therefore lands at twice
 * its intended offset unless it is divided by `pixelScale`; that is the offset
 * this normalization exists to remove.
 */
function normalizeAction(action, observation) {
    if (action.kind === 'click' && action.clickCount !== undefined && ![1, 2, 3].includes(action.clickCount)) {
        throw new ComputerUseError('COMPUTER_ACTION_BLOCKED', 'clickCount must be 1, 2, or 3');
    }
    const space = action.kind === 'click' || action.kind === 'scroll' || action.kind === 'drag'
        ? action.coordinateSpace
        : undefined;
    if (space === undefined || !requiresCoordinates(action))
        return action;
    const frame = observation.window?.frame;
    const screenshot = observation.screenshot;
    const scale = screenshotPixelScale(observation);
    if (space === 'screenshot') {
        if (frame === undefined) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', 'the observation has no window frame, so screenshot pixels cannot be mapped to window points; observe a windowed app and retry');
        }
        if (scale === undefined || screenshot === undefined) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', "coordinateSpace 'screenshot' needs an observation whose screenshot was captured; call computer_observe with screenshot 'optional' or 'required' for the same app, then retry with that observationId");
        }
        if (screenshot.pixelScale !== undefined) {
            const expectedWidth = Math.round(frame.width * scale);
            const expectedHeight = Math.round(frame.height * scale);
            if (Math.abs(screenshot.width - expectedWidth) > 2 || Math.abs(screenshot.height - expectedHeight) > 2) {
                throw new ComputerUseError('COMPUTER_STALE_OBSERVATION', `the screenshot is ${screenshot.width}×${screenshot.height} pixels but the ${frame.width}×${frame.height} point window frame implies ${expectedWidth}×${expectedHeight}; observe again before using screenshot coordinates`);
            }
        }
        const toPoint = (x, y) => {
            const point = { x: x / scale, y: y / scale };
            if (point.x < 0 || point.y < 0 || point.x > frame.width || point.y > frame.height) {
                const screenshot = observation.screenshot;
                throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', `screenshot coordinate (${x}, ${y}) maps to window point (${point.x.toFixed(1)}, ${point.y.toFixed(1)}), outside the ${frame.width}×${frame.height} point window frame${screenshot === undefined ? '' : ` (screenshot is ${screenshot.width}×${screenshot.height} pixels)`}`);
            }
            return point;
        };
        switch (action.kind) {
            case 'click':
            case 'scroll': {
                if (action.x === undefined || action.y === undefined) {
                    throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', `${action.kind} with coordinateSpace 'screenshot' requires both x and y`);
                }
                const point = toPoint(action.x, action.y);
                return { ...action, coordinateSpace: 'window', x: point.x, y: point.y };
            }
            case 'drag': {
                const from = toPoint(action.fromX, action.fromY);
                const to = toPoint(action.toX, action.toY);
                return { ...action, coordinateSpace: 'window', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
            }
            case 'set-value':
            case 'type-text':
            case 'press-key':
            case 'perform-action': return action;
        }
    }
    if (space === 'window' && frame !== undefined && scale !== undefined && observation.screenshot !== undefined) {
        const screenshot = observation.screenshot;
        const looksLikePixels = (x, y) => x !== undefined && y !== undefined
            && (x > frame.width || y > frame.height) && x <= screenshot.width && y <= screenshot.height;
        const suspect = (() => {
            if (action.kind === 'drag')
                return looksLikePixels(action.fromX, action.fromY) || looksLikePixels(action.toX, action.toY);
            if (action.kind === 'click' || action.kind === 'scroll')
                return looksLikePixels(action.x, action.y);
            return false;
        })();
        if (suspect) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', `window coordinates are outside the ${frame.width}×${frame.height} point window frame but fit inside the ${screenshot.width}×${screenshot.height} pixel screenshot; if they were read off the screenshot, pass coordinateSpace 'screenshot' so they are divided by pixelScale ${scale}; otherwise they are simply outside the window`);
        }
    }
    return action;
}
/** Whether the condition names at least one thing this wait can actually observe. */
function hasWaitCondition(condition) {
    const named = (value) => value !== undefined && value.trim().length > 0;
    return named(condition.text) || named(condition.elementRole) || named(condition.elementTitle);
}
function matchesWait(observation, action) {
    const { text, elementRole, elementTitle } = action.condition;
    if (text !== undefined && !observation.treeText.toLocaleLowerCase().includes(text.toLocaleLowerCase()))
        return false;
    if (elementRole === undefined && elementTitle === undefined)
        return true;
    return observation.elements.some(element => (elementRole === undefined || element.role === elementRole)
        && (elementTitle === undefined || element.title === elementTitle || element.label === elementTitle));
}
function targetIndex(action) {
    switch (action.kind) {
        case 'click':
        case 'scroll': return action.elementIndex;
        case 'set-value':
        case 'perform-action': return action.elementIndex;
        case 'type-text':
        case 'press-key':
        case 'drag':
        case 'wait': return undefined;
    }
}
function targetHandle(action) {
    switch (action.kind) {
        case 'click':
        case 'scroll':
        case 'set-value':
        case 'perform-action': return action.targetHandle;
        case 'type-text':
        case 'press-key':
        case 'drag':
        case 'wait': return undefined;
    }
}
function allowsTargetRebind(action) {
    switch (action.kind) {
        case 'click':
        case 'scroll':
        case 'set-value':
        case 'perform-action': return action.allowRebind === true;
        case 'type-text':
        case 'press-key':
        case 'drag':
        case 'wait': return false;
    }
}
function requiresElement(action) {
    return action.kind === 'set-value' || action.kind === 'perform-action';
}
function isPrimaryClick(action) {
    return (action.button ?? 'left') === 'left' && (action.clickCount ?? 1) === 1;
}
function requiresPointerInput(action, element) {
    switch (action.kind) {
        case 'click':
            return !isPrimaryClick(action)
                || action.x !== undefined || action.y !== undefined
                || (element !== undefined && action.allowCoordinateFallback === true);
        case 'scroll':
        case 'drag': return true;
        case 'set-value':
        case 'type-text':
        case 'press-key':
        case 'perform-action': return false;
    }
}
function requiresForegroundPermission(action) {
    return action.kind === 'perform-action' && action.action === 'AXRaise';
}
function cursorAction(action, element, window, app) {
    if (window?.id === undefined)
        return undefined;
    const target = {
        targetPid: app.pid,
        targetWindowNumber: window.id,
        targetWindowFrame: { ...window.frame },
    };
    const elementPoint = element?.frame === undefined
        ? undefined
        : {
            x: element.frame.x + element.frame.width / 2,
            y: element.frame.y + element.frame.height / 2,
        };
    const coordinateSpace = action.kind === 'click' || action.kind === 'scroll' || action.kind === 'drag'
        ? action.coordinateSpace
        : undefined;
    const windowPoint = (x, y) => {
        if (x === undefined || y === undefined || window === undefined)
            return undefined;
        return coordinateSpace === 'screen' ? { x, y } : { x: window.frame.x + x, y: window.frame.y + y };
    };
    switch (action.kind) {
        case 'click':
        case 'scroll': {
            const coordinates = windowPoint(action.x, action.y);
            const point = action.kind === 'click' && !isPrimaryClick(action)
                ? coordinates ?? elementPoint
                : elementPoint ?? coordinates;
            return point === undefined ? undefined : { kind: action.kind, to: point, ...target };
        }
        case 'drag': {
            const from = windowPoint(action.fromX, action.fromY);
            const to = windowPoint(action.toX, action.toY);
            return from === undefined || to === undefined ? undefined : { kind: 'drag', from, to, ...target };
        }
        case 'set-value':
        case 'type-text':
        case 'press-key':
        case 'perform-action': return undefined;
    }
}
/** Complete Service Definition plus provider-independent implementation. */
export class ComputerUseService extends Service {
    backend;
    config;
    generation = 1;
    generationLifetime = new AbortController();
    reconfiguration = Promise.resolve();
    agents = new Map();
    actionTails = new Map();
    leases;
    confirmations;
    lifecycle = new AbortController();
    healthState = {
        ready: false,
        accessibility: 'unavailable',
        screenRecording: 'unavailable',
    };
    /** Persist backend health facts while allowing a disabled provider to stay ready=false with a visible reason. */
    applyHealth(health) {
        this.healthState = {
            ready: health.ready ?? true,
            helperVersion: health.helperVersion,
            helperSha256: health.helperSha256,
            accessibility: health.accessibility,
            screenRecording: health.screenRecording,
            ...(health.error === undefined ? {} : { lastError: health.error }),
        };
    }
    /** Register `ctx.computerUse` using one validated backend and configuration generation. */
    constructor(ctx, backend, config) {
        super(ctx, 'computerUse');
        this.backend = backend;
        this.config = config;
        this.leases = new ComputerLeaseManager(ctx, () => this.config);
        this.confirmations = new ComputerConfirmationManager(ctx, () => this.config);
        ctx.effect(() => async () => {
            this.lifecycle.abort(new ComputerUseError('COMPUTER_CANCELLED', 'the Computer Use service was disposed'));
            this.clearState();
            await this.backend.dispose();
        }, 'dsh-computer-use: service lifecycle');
    }
    /** Verify the active backend before consumers become injectable. */
    async initialize() {
        const signal = AbortSignal.any([this.lifecycle.signal, this.generationLifetime.signal]);
        try {
            await this.leases.initialize();
            signal.throwIfAborted();
            const health = await this.backend.health(signal);
            signal.throwIfAborted();
            this.applyHealth(health);
        }
        catch (error) {
            // A successfully validated replacement already published its own health.
            if (signal.aborted && !this.lifecycle.signal.aborted)
                return;
            const failure = computerUseError(error, 'Computer Use provider initialization failed', { signal });
            this.healthState = {
                ready: false,
                accessibility: 'unavailable',
                screenRecording: 'unavailable',
                lastError: failure.message,
            };
            throw failure;
        }
    }
    /** Replace the backend/config generation after a validated live Settings update. */
    reconfigure(backend, config) {
        // Settings updates can overlap. Validate and install them in submission order.
        const run = this.reconfiguration.then(async () => {
            const signal = this.lifecycle.signal;
            signal.throwIfAborted();
            const health = await backend.health(signal);
            signal.throwIfAborted();
            const previous = this.backend;
            const previousLifetime = this.generationLifetime;
            this.backend = backend;
            this.config = config;
            this.generation += 1;
            this.generationLifetime = new AbortController();
            this.clearState();
            this.applyHealth(health);
            previousLifetime.abort(new ComputerUseError('COMPUTER_CANCELLED', 'Computer Use settings changed during this operation'));
            try {
                await previous.dispose();
            }
            catch (error) {
                // The candidate is already active. Its owner disposes candidates on rejection.
                this.ctx.get('logger')?.warn('dsh-computer-use: could not dispose the retired provider: %s', error);
            }
        });
        this.reconfiguration = run.catch(() => undefined);
        return run;
    }
    operationSignal(caller, agent) {
        const signals = [caller, this.lifecycle.signal, this.generationLifetime.signal];
        if (agent !== undefined)
            signals.push(this.state(agent).lifetime.signal);
        return AbortSignal.any(signals);
    }
    /** Current provider and permission diagnostics. */
    status() {
        return {
            platform: process.platform,
            provider: this.backend.name,
            generation: this.generation,
            helperPath: this.backend.helperPath,
            ...this.healthState,
        };
    }
    /** Re-run non-mutating provider health checks. */
    async health(signal) {
        const operation = this.operationSignal(signal);
        try {
            operation.throwIfAborted();
            const health = await this.backend.health(operation);
            operation.throwIfAborted();
            this.applyHealth(health);
        }
        catch (error) {
            const failure = computerUseError(error, 'Computer Use health check failed', { signal: operation });
            if (!operation.aborted)
                this.healthState = { ...this.healthState, ready: false, lastError: failure.message };
            throw failure;
        }
        return this.status();
    }
    /** Open the exact macOS privacy pane after an explicit Settings-page action. */
    async openPermissionSettings(kind, signal) {
        const operation = this.operationSignal(signal);
        operation.throwIfAborted();
        await this.backend.openSettings(kind, operation);
        operation.throwIfAborted();
    }
    /** List bounded running applications without inspecting their UI contents. */
    async listApps(context) {
        const signal = this.operationSignal(context.signal, context.agent);
        signal.throwIfAborted();
        const apps = await this.backend.listApps(signal);
        signal.throwIfAborted();
        return apps;
    }
    /** Obtain a fresh, scoped observation after enforcing the app read lease. */
    async observe(request, context) {
        const signal = this.operationSignal(context.signal, context.agent);
        signal.throwIfAborted();
        const app = await this.backend.resolveApp(request.app, signal);
        signal.throwIfAborted();
        await this.leases.ensure(context.agent, app, 'read', 'computer_observe', context.callId, signal);
        return await this.capture(app, request, context, 'computer_observe', signal);
    }
    /** Ask for a one-use token bound to an exact proposed sensitive action. */
    async confirm(request, context) {
        const signal = this.operationSignal(context.signal, context.agent);
        signal.throwIfAborted();
        const stored = this.requireObservation(request.action.observationId, context.agent);
        // Mint the token over the same normalized action that act() will execute;
        // otherwise a screenshot-space proposal hashes differently after
        // normalization and the one-use token can never match.
        const action = request.action.kind === 'wait'
            ? request.action
            : normalizeAction(request.action, stored.backend);
        const confirmation = await this.confirmations.confirm(context.agent, stored.backend.app, { ...request, action }, context.callId, signal);
        signal.throwIfAborted();
        return confirmation;
    }
    /** Execute one observation-bound action and always return a fresh post-action observation. */
    async act(action, context) {
        const signal = this.operationSignal(context.signal, context.agent);
        let actionMayHaveExecuted = false;
        try {
            signal.throwIfAborted();
            const stored = this.requireObservation(action.observationId, context.agent);
            if (action.kind === 'wait')
                return await this.wait(stored, action, context, signal);
            const normalized = normalizeAction(action, stored.backend);
            return await this.enqueueAction(stored.backend.app, async () => {
                signal.throwIfAborted();
                return await this.actNow(normalized, context, signal, () => { actionMayHaveExecuted = true; });
            });
        }
        catch (error) {
            // Cancellation before input is different from cancellation while input
            // or post-action observation is in flight: the latter is unsafe to retry.
            throw computerUseError(error, `Computer Use ${action.kind}`, { signal, actionMayHaveExecuted });
        }
    }
    /** Keep this service's actions for one process ordered through post-action observation. */
    async actNow(action, context, signal, markActionStarted) {
        const backend = this.backend;
        const generationSignal = this.generationLifetime.signal;
        const stored = this.requireObservation(action.observationId, context.agent);
        const index = targetIndex(action);
        const handle = targetHandle(action);
        const originalElement = index === undefined ? undefined : stored.backend.elements.find(candidate => candidate.index === index);
        if (index !== undefined && originalElement === undefined) {
            throw new ComputerUseError('COMPUTER_ELEMENT_UNAVAILABLE', `element ${index} is not part of observation ${String(action.observationId)}`);
        }
        if (allowsTargetRebind(action) && handle === undefined) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', 'allowRebind requires a targetHandle from the referenced observation');
        }
        const handleElement = handle === undefined ? undefined : stored.targets.get(handle);
        if (handle !== undefined && handleElement === undefined) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', 'targetHandle is unknown or does not belong to the referenced observation');
        }
        if (handleElement !== undefined && originalElement !== undefined && handleElement !== originalElement) {
            throw new ComputerUseError('COMPUTER_TARGET_UNAVAILABLE', 'elementIndex and targetHandle select different elements');
        }
        const selectedOriginalElement = handleElement ?? originalElement;
        if (requiresElement(action) && selectedOriginalElement === undefined) {
            throw new ComputerUseError('COMPUTER_ELEMENT_UNAVAILABLE', `${action.kind} requires elementIndex or targetHandle`);
        }
        if (requiresPointerInput(action, selectedOriginalElement) && this.config.interaction.pointerInputPolicy === 'deny') {
            throw new ComputerUseError('COMPUTER_ACTION_BLOCKED', `${action.kind} requires target-process pointer input, which interaction.pointerInputPolicy denies; use an Accessibility action or enable targeted pointer input in host Settings`);
        }
        if (requiresForegroundPermission(action) && this.config.interaction.focusPolicy === 'preserve') {
            throw new ComputerUseError('COMPUTER_ACTION_BLOCKED', 'AXRaise may raise the target window, which interaction.focusPolicy preserve denies; enable explicit activation in host Settings before using this action');
        }
        await this.leases.ensure(context.agent, stored.backend.app, 'control', `computer_${action.kind}`, context.callId, signal);
        signal.throwIfAborted();
        const cursorRequested = this.config.interaction.cursorVisualization === 'visible'
            && (action.kind === 'click' || action.kind === 'scroll' || action.kind === 'drag');
        const observationOptions = {
            screenshot: 'none',
            maxNodes: this.config.maxNodes,
            maxDepth: this.config.maxDepth,
            maxTextBytes: this.config.maxTextBytes,
        };
        let actionObservation = stored.backend;
        let cursorActivation;
        let element = selectedOriginalElement;
        let resolution = selectedOriginalElement === undefined
            ? undefined
            : { mode: 'exact-locator', confidence: 1, candidateCount: 1, targetChanged: false };
        const descriptor = handleElement === undefined ? undefined : describeStoredTarget(stored, handleElement);
        if (descriptor !== undefined) {
            const fresh = await backend.observe(stored.backend.app, observationOptions, signal);
            signal.throwIfAborted();
            const resolved = resolveComputerTarget(stored.backend, fresh, descriptor, allowsTargetRebind(action));
            actionObservation = resolved.observation;
            element = resolved.element;
            resolution = resolved.resolution;
        }
        if (action.sensitive === true && resolution?.targetChanged === true) {
            this.confirmations.invalidate(context.agent, action.confirmationToken);
            throw new ComputerUseError('COMPUTER_TARGET_REBIND_REQUIRES_CONFIRMATION', 'the sensitive target rebound to a fresh element; observe the current UI and request a new one-use confirmation before acting');
        }
        if (cursorRequested
            && this.config.interaction.focusPolicy === 'activate'
            && requiresPointerInput(action, selectedOriginalElement)
            && !actionObservation.frontmost) {
            const activated = await backend.activateForCursor(stored.backend.app, actionObservation.stateHash, observationOptions, signal);
            signal.throwIfAborted();
            actionObservation = activated.observation;
            cursorActivation = activated.activation;
            if (descriptor !== undefined) {
                const resolved = resolveComputerTarget(stored.backend, actionObservation, descriptor, allowsTargetRebind(action));
                actionObservation = resolved.observation;
                element = resolved.element;
                resolution = resolved.resolution;
            }
        }
        if (action.sensitive === true && resolution?.targetChanged === true) {
            this.confirmations.invalidate(context.agent, action.confirmationToken);
            throw new ComputerUseError('COMPUTER_TARGET_REBIND_REQUIRES_CONFIRMATION', 'the sensitive target rebound to a fresh element; observe the current UI and request a new one-use confirmation before acting');
        }
        const visualization = cursorAction(action, element, actionObservation.window, actionObservation.app);
        let cursorStarted = false;
        // Background targets intentionally hide the overlay. Any other pre-action
        // failure would violate move-before-input ordering and therefore fails closed.
        let cursorState;
        const recordCursor = (next) => {
            if (cursorState === undefined || (cursorState.visible && !next.visible))
                cursorState = next;
        };
        if (cursorRequested && visualization === undefined) {
            const unavailable = {
                visible: false,
                reason: actionObservation.window?.id === undefined
                    ? 'the agent cursor could not be bound because the target window has no stable window id'
                    : 'the agent cursor could not be placed because this action has no observable cursor position',
                ...(!actionObservation.frontmost ? { reasonCode: 'target-not-frontmost' } : {}),
            };
            recordCursor(unavailable);
            if (actionObservation.frontmost) {
                throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `the agent cursor could not complete before the action: ${unavailable.reason}`);
            }
        }
        else if (visualization !== undefined && cursorRequested) {
            let beforeCursor;
            try {
                beforeCursor = await backend.visualizeCursor(visualization, 'before', signal);
            }
            catch (error) {
                throw computerUseError(error, 'the agent cursor could not be driven before the action', { signal });
            }
            recordCursor(beforeCursor);
            if (!beforeCursor.visible)
                signal.throwIfAborted();
            const intentionalBackground = beforeCursor.reasonCode === 'target-not-frontmost'
                && (this.config.interaction.focusPolicy === 'preserve'
                    || !requiresPointerInput(action, selectedOriginalElement));
            if (!beforeCursor.visible && !intentionalBackground) {
                throw new ComputerUseError('COMPUTER_PROVIDER_FAILURE', `the agent cursor could not complete before the action: ${beforeCursor.reason ?? 'the overlay is unavailable'}`);
            }
            cursorStarted = beforeCursor.visible;
        }
        let outcome;
        const request = {
            action,
            app: actionObservation.app,
            expectedStateHash: actionObservation.stateHash,
            interaction: this.config.interaction,
            ...(element === undefined ? {} : { element }),
            ...(actionObservation.window === undefined ? {} : { window: actionObservation.window }),
        };
        try {
            // Pre-action awaits may resolve after cancellation; do not consume a
            // one-use confirmation or dispatch input in that case.
            signal.throwIfAborted();
            this.confirmations.consume(context.agent, stored.backend.app, action);
            markActionStarted();
            if (cursorStarted && visualization?.kind === 'drag') {
                const tracked = await backend.actDragWithCursor(request, visualization, signal);
                recordCursor(tracked.cursor);
                outcome = tracked.action;
            }
            else {
                outcome = await backend.act(request, signal);
            }
            if (cursorActivation === 'activated' && outcome.activation !== 'activated') {
                outcome = { ...outcome, activation: 'activated' };
            }
        }
        finally {
            // The retiring backend disposes its own overlay. Caller cancellation alone
            // still needs cleanup on the backend that actually displayed the cursor.
            if (cursorStarted && visualization !== undefined && !generationSignal.aborted && !this.lifecycle.signal.aborted) {
                try {
                    recordCursor(await backend.visualizeCursor(visualization, 'after', AbortSignal.any([AbortSignal.timeout(1_500), generationSignal, this.lifecycle.signal])));
                }
                catch (error) {
                    recordCursor({
                        visible: false,
                        reason: `the agent cursor could not be validated after the action: ${error instanceof Error ? error.message : String(error)}`,
                    });
                }
            }
        }
        // The settle loop reports whether the bounded structural observation
        // changed. It complements routing facts without claiming causal proof or
        // visibility into pixel-only, transient, or remote effects.
        const started = Date.now();
        let latest;
        let settled = false;
        do {
            signal.throwIfAborted();
            if (this.config.settleMs > 0)
                await delay(this.config.settleMs, undefined, { signal });
            latest = await this.readSnapshot(stored.backend.app, 'none', undefined, signal);
            if (latest.stateHash !== actionObservation.stateHash) {
                settled = true;
                break;
            }
        } while (Date.now() - started < this.config.maxSettleMs);
        const observation = await this.capture(stored.backend.app, { app: { bundleId: stored.backend.app.bundleId, pid: stored.backend.app.pid }, screenshot: stored.public.screenshot === undefined ? 'none' : 'optional' }, context, 'computer_action', signal, latest);
        signal.throwIfAborted();
        return {
            action: action.kind,
            channel: outcome.channel,
            activation: outcome.activation,
            pointerInput: outcome.pointerInput,
            pointerRouting: outcome.pointerRouting,
            // Only reported when the cursor is meant to be showing and is not, so a
            // normal result stays unchanged and a lost cursor becomes visible to the
            // caller instead of to nobody.
            ...(cursorState === undefined || cursorState.visible ? {} : {
                agentCursor: { visible: false, ...(cursorState.reason === undefined ? {} : { reason: cursorState.reason }) },
            }),
            // This reports only what the bounded structural observation can prove.
            // Pixel-only, remote, or transient effects remain outside this hash and
            // must not be described as action failure.
            effect: {
                observedStateChanged: settled,
                observedForMs: Date.now() - started,
                ...(settled ? {} : {
                    note: 'no change was observed in the window title, id, frame, or accessibility element tree;'
                        + ' pixel-only, remote, or transient effects may still have occurred',
                }),
            },
            ...(resolution === undefined ? {} : { resolution }),
            observation,
        };
    }
    async enqueueAction(app, operation) {
        const key = `${app.bundleId}:${app.pid}`;
        const previous = this.actionTails.get(key) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(operation);
        const tail = run.then(() => undefined, () => undefined);
        this.actionTails.set(key, tail);
        try {
            return await run;
        }
        finally {
            if (this.actionTails.get(key) === tail)
                this.actionTails.delete(key);
        }
    }
    /** Release all scoped observations and confirmations for one disposed Agent. */
    releaseAgent(agent) {
        const state = this.agents.get(agent);
        this.agents.delete(agent);
        this.leases.releaseAgent(agent);
        this.confirmations.releaseAgent(agent);
        state?.lifetime.abort(new ComputerUseError('COMPUTER_CANCELLED', 'the Agent was disposed during this operation'));
    }
    state(agent) {
        let state = this.agents.get(agent);
        if (state === undefined) {
            state = { lifetime: new AbortController(), observations: new Map(), latestByApp: new Map() };
            this.agents.set(agent, state);
        }
        return state;
    }
    requireObservation(id, agent) {
        this.prune(agent);
        const stored = this.state(agent).observations.get(id);
        if (stored === undefined || stored.generation !== this.generation) {
            throw new ComputerUseError('COMPUTER_STALE_OBSERVATION', `observation ${String(id)} is unknown, expired, or belongs to another provider generation`);
        }
        return stored;
    }
    prune(agent) {
        const state = this.agents.get(agent);
        if (state === undefined)
            return;
        const now = Date.now();
        for (const [id, stored] of state.observations) {
            if (Date.parse(stored.public.expiresAt) <= now || stored.generation !== this.generation)
                state.observations.delete(id);
        }
        for (const [app, id] of state.latestByApp) {
            if (!state.observations.has(id))
                state.latestByApp.delete(app);
        }
    }
    async readSnapshot(app, screenshot, screenshotPath, signal) {
        signal.throwIfAborted();
        const backend = await this.backend.observe(app, {
            screenshot,
            ...(screenshotPath === undefined ? {} : { screenshotPath }),
            maxNodes: this.config.maxNodes,
            maxDepth: this.config.maxDepth,
            maxTextBytes: this.config.maxTextBytes,
        }, signal);
        signal.throwIfAborted();
        if (backend.app.bundleId !== app.bundleId || backend.app.pid !== app.pid) {
            throw new ComputerUseError('COMPUTER_STALE_OBSERVATION', 'the selected application restarted or resolved to a different process');
        }
        return backend;
    }
    async capture(app, request, context, sourceTool, signal, preObserved) {
        signal.throwIfAborted();
        const screenshot = request.screenshot ?? 'optional';
        const screenshotPath = screenshot === 'none'
            ? undefined
            : await allocateScreenshotPath(context.workspace, this.config.artifactRoot, context.agent.session.id);
        try {
            const backend = preObserved !== undefined && screenshot === 'none'
                ? preObserved
                : await this.readSnapshot(app, screenshot, screenshotPath, signal);
            return await this.recordObservation(backend, request.full === true, context, sourceTool, signal);
        }
        catch (error) {
            if (screenshotPath !== undefined)
                await rm(screenshotPath, { force: true });
            throw error;
        }
    }
    async recordObservation(backend, full, context, sourceTool, signal) {
        signal.throwIfAborted();
        const artifact = backend.screenshot === undefined
            ? undefined
            : await describeScreenshot(backend.screenshot.path, backend.screenshot.width, backend.screenshot.height, this.config.maxScreenshotBytes, sourceTool, screenshotPixelScale(backend));
        // Read the diff baseline and commit without yielding after the final lifetime check.
        signal.throwIfAborted();
        const state = this.state(context.agent);
        this.prune(context.agent);
        const key = `${backend.app.bundleId}:${backend.app.pid}`;
        const previousId = state.latestByApp.get(key);
        const previous = previousId === undefined ? undefined : state.observations.get(previousId);
        const projected = publicElements(backend);
        const elements = projected.elements;
        const diff = full || previous === undefined
            ? undefined
            : projectElementDiff(previous.public.elements, elements, this.config.maxTextBytes);
        const createdAt = Date.now();
        const observationId = ComputerObservationId(randomUUID());
        const observation = {
            observationId,
            app: { ...backend.app },
            createdAt: new Date(createdAt).toISOString(),
            expiresAt: this.config.observationTtlMs === 0
                ? '9999-12-31T23:59:59.999Z'
                : new Date(createdAt + this.config.observationTtlMs).toISOString(),
            frontmost: backend.frontmost,
            ...(backend.window === undefined ? {} : { window: { ...backend.window, frame: { ...backend.window.frame } } }),
            tree: {
                mode: diff === undefined ? 'full' : 'diff',
                text: diff?.text ?? backend.treeText,
                truncated: backend.truncated || diff?.truncated === true,
            },
            elements,
            ...(artifact === undefined ? {} : { screenshot: artifact }),
            permissions: { ...backend.permissions },
        };
        state.observations.set(observationId, { public: observation, backend, targets: projected.targets, generation: this.generation });
        state.latestByApp.set(key, observationId);
        while (state.observations.size > 64) {
            const oldest = state.observations.keys().next().value;
            if (oldest === undefined)
                break;
            state.observations.delete(oldest);
        }
        return observation;
    }
    async wait(stored, action, context, signal) {
        if (!hasWaitCondition(action.condition)) {
            // An empty condition can never be satisfied and can never be reported as
            // met, so reject it up front instead of burning the whole timeout.
            throw new ComputerUseError('COMPUTER_ACTION_BLOCKED', 'wait requires at least one of condition.text, condition.elementRole, or condition.elementTitle; an empty condition can never be met');
        }
        await this.leases.ensure(context.agent, stored.backend.app, 'read', 'computer_wait', context.callId, signal);
        signal.throwIfAborted();
        const timeoutMs = action.timeoutMs ?? this.config.maxSettleMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > this.config.maxSettleMs) {
            throw new ComputerUseError('COMPUTER_TIMEOUT', `wait timeout must be between 100 and ${this.config.maxSettleMs} milliseconds`);
        }
        const started = Date.now();
        const deadline = AbortSignal.timeout(timeoutMs);
        const pollSignal = AbortSignal.any([signal, deadline]);
        const wantsScreenshot = stored.public.screenshot !== undefined;
        const previouslyMatched = matchesWait(stored.backend, action);
        let captureScreenshot = wantsScreenshot && previouslyMatched;
        let screenshotPath;
        let latest;
        let observation;
        try {
            for (;;) {
                if (captureScreenshot && screenshotPath === undefined) {
                    screenshotPath = await allocateScreenshotPath(context.workspace, this.config.artifactRoot, context.agent.session.id);
                }
                latest = await this.readSnapshot(stored.backend.app, captureScreenshot ? 'optional' : 'none', captureScreenshot ? screenshotPath : undefined, pollSignal);
                if (matchesWait(latest, action)) {
                    if (!wantsScreenshot || captureScreenshot)
                        break;
                    // Recheck the condition on the same snapshot that provides the optional image.
                    captureScreenshot = true;
                    continue;
                }
                captureScreenshot = false;
                await delay(this.config.settleMs || 100, undefined, { signal: pollSignal });
            }
            observation = await this.recordObservation(latest, false, context, 'computer_action', pollSignal);
            if (observation.screenshot !== undefined)
                screenshotPath = undefined;
        }
        catch (error) {
            if (deadline.aborted && !signal.aborted) {
                throw new ComputerUseError('COMPUTER_TIMEOUT', 'wait condition was not met before the configured deadline', { cause: error });
            }
            throw error;
        }
        finally {
            if (screenshotPath !== undefined)
                await rm(screenshotPath, { force: true });
        }
        return {
            action: 'wait',
            channel: 'wait',
            activation: 'not-requested',
            effect: {
                observedStateChanged: latest.stateHash !== stored.backend.stateHash,
                observedForMs: Date.now() - started,
                ...(previouslyMatched && latest.stateHash === stored.backend.stateHash
                    ? { note: 'the wait condition was already satisfied by the referenced observation' }
                    : {}),
            },
            pointerInput: false,
            pointerRouting: 'none',
            observation,
        };
    }
    clearState() {
        this.agents.clear();
        this.confirmations.clear();
    }
}
export default ComputerUseService;
//# sourceMappingURL=service.js.map