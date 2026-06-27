import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getSubagentType, parseTraits } from "../lib/narrator-utils";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import { registerAndPersistSubagentAlias, registerTaskAlias } from "./subagent-alias";
import {
	abandonManualOverride,
	interruptManualOverride,
	isManualOverride,
	resolveManualOverride,
} from "./subagent-manual-override";
import { clearTakenOver, isTakenOver } from "./subagent-takeover";

// === In-memory state ===
// Use `let` + lazy getter to avoid TDZ issues under Bun --hot reload,
// where a stale dynamic-import resolution can reference the module binding
// before the const initializer has executed.

let _backgroundTaskAbortControllers: Map<string, AbortController> | undefined;
export function getBackgroundAbortControllers() {
	if (!_backgroundTaskAbortControllers) _backgroundTaskAbortControllers = new Map();
	return _backgroundTaskAbortControllers;
}

let _foregroundSubagentAbortControllers: Map<string, AbortController> | undefined;
export function getForegroundAbortControllers() {
	if (!_foregroundSubagentAbortControllers) _foregroundSubagentAbortControllers = new Map();
	return _foregroundSubagentAbortControllers;
}

let _hardInterruptedForegroundSubagents: Set<string> | undefined;
function getHardInterruptedForegroundSubagents() {
	if (!_hardInterruptedForegroundSubagents) _hardInterruptedForegroundSubagents = new Set();
	return _hardInterruptedForegroundSubagents;
}

export function consumeForegroundSubagentHardInterrupt(subagentId: string): boolean {
	const hardInterrupted = getHardInterruptedForegroundSubagents();
	if (!hardInterrupted.has(subagentId)) return false;
	hardInterrupted.delete(subagentId);
	return true;
}

// === ProxyAbortController for detach/attach ===

/**
 * A proxy AbortController that forwards abort signals from one or more sources.
 * The key feature: sources can be swapped at runtime (detach removes parent signal,
 * adds independent background signal) without the consumer (agent loop) noticing.
 */
export class ProxyAbortController {
	private _ctrl = new AbortController();
	private _listeners: Array<[AbortSignal, () => void]> = [];

	get signal(): AbortSignal {
		return this._ctrl.signal;
	}

	get aborted(): boolean {
		return this._ctrl.signal.aborted;
	}

	/** Listen to one or more abort signal sources. */
	listenTo(...signals: AbortSignal[]): void {
		for (const s of signals) {
			if (s.aborted) {
				this._ctrl.abort(s.reason);
				break;
			}
			const handler = () => this._ctrl.abort(s.reason);
			s.addEventListener("abort", handler, { once: true });
			this._listeners.push([s, handler]);
		}
	}

	/** Remove listener for a specific signal source. */
	unlisten(signal: AbortSignal): void {
		this._listeners = this._listeners.filter(([s, h]) => {
			if (s === signal) {
				s.removeEventListener("abort", h);
				return false;
			}
			return true;
		});
	}

	/** Replace one signal source with another (used during detach). */
	replaceSource(oldSignal: AbortSignal, newSignal: AbortSignal): void {
		this.unlisten(oldSignal);
		this.listenTo(newSignal);
	}

	abort(reason?: string): void {
		this._ctrl.abort(reason);
	}

	/** Clean up all listeners and reset the internal AbortController. */
	dispose(): void {
		for (const [s, h] of this._listeners) {
			s.removeEventListener("abort", h);
		}
		this._listeners = [];
		// Reset the internal controller so the proxy can be reused after an abort.
		// Without this, once _ctrl is aborted it stays aborted forever and
		// subsequent listenTo() calls hand out a permanently-aborted signal.
		if (this._ctrl.signal.aborted) {
			this._ctrl = new AbortController();
		}
	}
}

// === Detach infrastructure ===

/**
 * Interrupt a running foreground subagent.
 *
 * Soft interrupts (default) are used by Send({ doInterrupt: true }) to stop the
 * current turn and continue with a buffered message/manual override. Hard
 * interrupts are used by the UI Stop button and must fully end the subagent so
 * the parent tool call cannot remain blocked while the subagent appears idle.
 */
export function interruptForegroundSubagent(
	subagentId: string,
	options?: { hard?: boolean },
): boolean {
	const hard = options?.hard === true;
	const ctrl = getForegroundAbortControllers().get(subagentId);
	if (ctrl) {
		if (hard) getHardInterruptedForegroundSubagents().add(subagentId);
		ctrl.abort(hard ? "Hard interrupted by user" : "Interrupted by user");
		return true;
	}

	if (hard && interruptManualOverride(subagentId)) {
		getHardInterruptedForegroundSubagents().delete(subagentId);
		return true;
	}

	if (hard) getHardInterruptedForegroundSubagents().delete(subagentId);
	return false;
}

/**
 * Interrupt all foreground subagents currently owned by a parent narrator.
 * This is a defensive cleanup path for primary narrator interrupts: the parent
 * abort signal should normally propagate through ProxyAbortController, but this
 * also updates DB/UI state so child cards do not remain stuck as "working" if
 * the parent loop stops before the child finalizer can broadcast.
 */
export async function interruptForegroundSubagentsForParent(
	parentNarratorId: string,
): Promise<number> {
	const entries = [...getDetachableMap().values()].filter(
		(entry) => entry.parentNarratorId === parentNarratorId,
	);
	let interrupted = 0;
	const touched = new Set<string>();
	const markInterrupted = async (subagentId: string, toolUseId = "stale-interrupt") => {
		if (touched.has(subagentId)) return;
		touched.add(subagentId);
		await narratorService.updateStatus(subagentId, "idle", {
			substatus: ["interrupted"],
			skipErrorMessage: true,
		});
		broadcastToNarrator(parentNarratorId, {
			type: "subagent_status_changed",
			narratorId: parentNarratorId,
			subagentNarratorId: subagentId,
			status: "idle",
			substatus: ["interrupted"],
		});
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
		});
		interrupted++;
	};

	for (const entry of entries) {
		const { subagentId } = entry;
		try {
			entry.fgAbort.abort("Parent narrator interrupted");
			entry.proxy.abort("Parent narrator interrupted");
			abandonManualOverride(subagentId);
			// Clear any takeover state BEFORE markInterrupted so
			// preserveTakenOverSubstatus does not re-add the taken_over tag.
			const wasTakenOver = isTakenOver(subagentId);
			clearTakenOver(subagentId);
			getHardInterruptedForegroundSubagents().delete(subagentId);
			getForegroundAbortControllers().delete(subagentId);
			// If the user was operating this subagent via its own independent loop
			// (takeover), abort that loop too so it does not keep running orphaned.
			if (wasTakenOver) {
				import("./narrator-session")
					.then(({ interruptNarrator }) => interruptNarrator(subagentId))
					.catch(() => {});
			}
			await markInterrupted(subagentId, entry.toolUseId);
		} catch (err) {
			logger.warn("Failed to interrupt foreground subagent for parent", {
				parentNarratorId,
				subagentId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Reconcile any stale foreground children that no longer have an in-memory
	// controller but are still persisted as active. Background tasks are excluded:
	// they intentionally outlive the parent narrator. Taken-over children (any
	// status, isBackground already cleared) are also swept so their in-memory
	// takeover state and taken_over tag do not leak when the parent is interrupted.
	const reconcileChildren = await db.query.narrators.findMany({
		where: and(eq(narrators.parentNarratorId, parentNarratorId), eq(narrators.isBackground, false)),
		columns: { id: true, status: true },
	});
	for (const child of reconcileChildren) {
		const childTakenOver = isTakenOver(child.id);
		const childActive = child.status === "working" || child.status === "waiting";
		if (!childTakenOver && !childActive) continue;
		try {
			if (childTakenOver) {
				// Clear takeover state first so preserveTakenOverSubstatus does not
				// re-add taken_over, and abort the subagent's independent loop.
				clearTakenOver(child.id);
				import("./narrator-session")
					.then(({ interruptNarrator }) => interruptNarrator(child.id))
					.catch(() => {});
			}
			await markInterrupted(child.id);
		} catch (err) {
			logger.warn("Failed to mark stale foreground subagent interrupted", {
				parentNarratorId,
				subagentId: child.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return interrupted;
}

export interface DetachSetupResult {
	alias: string;
	subagentType: string;
}

export interface DetachEntry {
	/** Called to set the detached flag inside runLoop and hand it the setup barrier. */
	markDetached: (setup: Promise<DetachSetupResult>) => void;
	/** Resolve the foreground Promise (unblocks parent narrator immediately). */
	foregroundResolve: (result: string) => void;
	proxy: ProxyAbortController;
	parentSignal: AbortSignal;
	fgAbort: AbortController;
	toolUseId: string;
	parentNarratorId: string;
	subagentId: string;
}

let _detachableSubagents: Map<string, DetachEntry> | undefined;
export function getDetachableMap() {
	if (!_detachableSubagents) _detachableSubagents = new Map();
	return _detachableSubagents;
}

// === Attach infrastructure ===
// When a background task is attached (pulled to foreground), we store a Promise
// that the caller (continueSubagent) can await.

export interface AttachEntry {
	promise: Promise<{ finalText: string; hasError: boolean }>;
	resolve: (result: { finalText: string; hasError: boolean }) => void;
}

let _attachWaiters: Map<string, AttachEntry> | undefined;
export function getAttachWaitersMap() {
	if (!_attachWaiters) _attachWaiters = new Map();
	return _attachWaiters;
}

// === Detach / Attach ===

async function prepareDetachedBackgroundTask(
	subagentId: string,
	entry: DetachEntry,
): Promise<DetachSetupResult> {
	const { proxy, parentSignal, toolUseId } = entry;
	let bgAbort: AbortController | undefined;

	try {
		// 1. Create independent background AbortController.
		bgAbort = new AbortController();
		getBackgroundAbortControllers().set(subagentId, bgAbort);
		backgroundTaskService.registerAbortController(subagentId, bgAbort);

		// 2. Swap signal source: remove parent signal, add background signal.
		proxy.replaceSource(parentSignal, bgAbort.signal);

		// Also remove the fgAbort listener (it's no longer relevant).
		const fgCtrl = getForegroundAbortControllers().get(subagentId);
		if (fgCtrl) {
			proxy.unlisten(fgCtrl.signal);
			getForegroundAbortControllers().delete(subagentId);
		}

		// 3. Update DB.
		const now = new Date().toISOString();
		const subNarrator = await narratorService.getById(subagentId);
		const updatedTraits = [...new Set([...parseTraits(subNarrator.traits), "background"])];
		await db
			.update(narrators)
			.set({
				isBackground: true,
				backgroundStatus: "running",
				traits: updatedTraits,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));

		// 4. Register alias if not already registered (foreground tasks may not have one yet).
		let detachAlias: string;
		try {
			({ alias: detachAlias } = await registerAndPersistSubagentAlias(
				entry.parentNarratorId,
				subagentId,
				subNarrator.title ?? undefined,
			));
		} catch (err) {
			({ alias: detachAlias } = registerTaskAlias(
				entry.parentNarratorId,
				subagentId,
				subNarrator.title ?? undefined,
			));
			logger.warn("Failed to persist detached subagent alias", {
				subagentId,
				alias: detachAlias,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const subagentType = getSubagentType(subNarrator.variant) ?? "general";
		await backgroundTaskService
			.createAgentTask({
				id: subagentId,
				parentNarratorId: entry.parentNarratorId,
				subagentNarratorId: subagentId,
				subagentType,
				toolUseId,
				alias: detachAlias,
				title: subNarrator.title ?? undefined,
			})
			.catch((err) => {
				logger.warn("Failed to register detached background task in DB", {
					subagentId,
					error: err instanceof Error ? err.message : String(err),
				});
			});

		return { alias: detachAlias, subagentType };
	} catch (err) {
		if (bgAbort) {
			proxy.replaceSource(bgAbort.signal, parentSignal);
			if (!entry.fgAbort.signal.aborted) {
				proxy.listenTo(entry.fgAbort.signal);
				getForegroundAbortControllers().set(subagentId, entry.fgAbort);
			}
			getBackgroundAbortControllers().delete(subagentId);
			backgroundTaskService.unregisterAbortController(subagentId);
		}
		throw err;
	}
}

async function restoreAttachedSubagentToBackground(
	subagentId: string,
	bgAbort: AbortController,
): Promise<boolean> {
	getForegroundAbortControllers().delete(subagentId);

	const current = await narratorService.getById(subagentId).catch(() => null);
	if (!current) return false;
	if (current.backgroundStatus && current.backgroundStatus !== "running") return false;

	getBackgroundAbortControllers().set(subagentId, bgAbort);
	backgroundTaskService.registerAbortController(subagentId, bgAbort);

	const now = new Date().toISOString();
	const updatedTraits = [...new Set([...parseTraits(current.traits), "background"])];
	await db
		.update(narrators)
		.set({
			isBackground: true,
			backgroundStatus: "running",
			traits: updatedTraits,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));
	return true;
}

/**
 * Detach a foreground subagent to background mode (zero-interrupt).
 * The agent loop continues running; the parent narrator's blocking Promise resolves immediately.
 */
export async function detachSubagent(subagentId: string): Promise<boolean> {
	const entry = getDetachableMap().get(subagentId);
	if (!entry) return false;

	const wasManualOverride = isManualOverride(subagentId);
	const setupPromise = prepareDetachedBackgroundTask(subagentId, entry);

	// Mark as detached before any await/override resolution so runForegroundLoop cannot
	// race into the normal foreground finalizer while detach setup is in flight.
	entry.markDetached(setupPromise);
	getDetachableMap().delete(subagentId);

	let setup: DetachSetupResult;
	try {
		setup = await setupPromise;
	} catch (err) {
		logger.warn("Failed to detach subagent to background", {
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}

	if (wasManualOverride && isManualOverride(subagentId)) {
		const { getSubagentFinalText } = await import("./narrator-session");
		const finalText = await getSubagentFinalText(subagentId);
		resolveManualOverride(subagentId, finalText, false);
	}

	// Immediately resolve the foreground Promise (unblocks parent narrator).
	// Use raw subagentId in the tag — the Agent tool will replace it with the alias.
	const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
	entry.foregroundResolve(
		resultPrefix +
			`Subagent detached to background. Use Await({ type: "agent", id: "${setup.alias}" }) to get results, or Send({ id: "${setup.alias}", message }) to continue.`,
	);

	eventBus.emit({
		type: "narrator:background_task_started",
		narratorId: entry.parentNarratorId,
		parentNarratorId: entry.parentNarratorId,
		taskNarratorId: subagentId,
		toolUseId: entry.toolUseId,
		subagentType: setup.subagentType,
	});
	broadcastToNarrator(entry.parentNarratorId, {
		type: "subagent_detached",
		narratorId: entry.parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId: entry.toolUseId,
	});

	return true;
}

/**
 * Attach a running background subagent to foreground (blocks until completion).
 * Called from continueSubagent when the target is a running background task.
 * Returns the subagent result string.
 */
export async function attachSubagent(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	signal: AbortSignal,
): Promise<string> {
	// 1. Migrate abort controller: background → foreground waiter.
	const bgAbort = getBackgroundAbortControllers().get(subagentId);
	if (!bgAbort) {
		throw new ValidationError("Background task abort controller not found");
	}
	getBackgroundAbortControllers().delete(subagentId);
	getForegroundAbortControllers().set(subagentId, bgAbort);

	// 2. Update DB.
	const now = new Date().toISOString();
	const subNarrator = await narratorService.getById(subagentId);
	const updatedTraits = parseTraits(subNarrator.traits).filter((t) => t !== "background");
	await db
		.update(narrators)
		.set({
			isBackground: false,
			backgroundStatus: null,
			traits: updatedTraits,
			updatedAt: now,
		})
		.where(eq(narrators.id, subagentId));

	// 3. Create attach waiter — the running loop will resolve this when it completes.
	const { promise, resolve } = Promise.withResolvers<{ finalText: string; hasError: boolean }>();
	getAttachWaitersMap().set(subagentId, { promise, resolve });

	// 4. Broadcast.
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_attached",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
	});

	// 5. Wait for the loop to complete, or stop waiting if the caller is interrupted.
	type AttachWaitResult = { finalText: string; hasError: boolean; aborted?: boolean };
	const abortPromise = new Promise<AttachWaitResult>((res) => {
		if (signal.aborted) {
			res({ finalText: "Aborted", hasError: true, aborted: true });
			return;
		}
		const handler = () => res({ finalText: "Aborted", hasError: true, aborted: true });
		signal.addEventListener("abort", handler, { once: true });
		promise.then((result) => {
			signal.removeEventListener("abort", handler);
			res(result);
		});
	});

	const result = await abortPromise;
	getAttachWaitersMap().delete(subagentId);

	if (result.aborted) {
		const restored = await restoreAttachedSubagentToBackground(subagentId, bgAbort);
		if (restored) {
			broadcastToNarrator(parentNarratorId, {
				type: "subagent_detached",
				narratorId: parentNarratorId,
				subagentNarratorId: subagentId,
				toolUseId,
			});
		}
		const resultPrefix = `<background_task_id>${subagentId}</background_task_id>\n\n`;
		return (
			resultPrefix +
			"Attach interrupted. The subagent is still running in background. Use Await to get results or Send to continue it."
		);
	}

	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	return resultPrefix + (result.finalText || "(no output)");
}
