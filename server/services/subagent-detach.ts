import { and, eq, inArray, like } from "drizzle-orm";
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
import { appendSubagentFileChanges } from "./subagent-file-changes";
import { agentResultTag, resolveAgentLabel } from "./subagent-label";
import {
	abandonManualOverride,
	claimManualOverride,
	interruptManualOverride,
	isManualOverride,
	releaseManualOverrideClaim,
	settleManualOverrideClaim,
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
 * Abort a subagent's own session loop, awaited so the abort lands BEFORE the
 * caller writes idle[interrupted].
 *
 * `interruptNarrator` is synchronous (it aborts the controller and fans out; the
 * loop's own unwinding is not awaited), so the only thing awaited here is the
 * dynamic import — the cost is a resolved module, not the loop's convergence.
 * The import stays dynamic to keep the narrator-session ↔ subagent cycle out of
 * the module graph.
 *
 * Awaiting matters because both sides write status. Fire-and-forget let
 * `markInterrupted` persist idle[interrupted] first and the loop's
 * `finalizeInterruptedRun` run afterwards, so the card could flash back to
 * working in between — the final state converged, but the intermediate one was
 * decided by scheduling order. A failure to abort is logged and does NOT skip
 * the status write: an un-aborted loop is a worse outcome when the card also
 * stays stuck on "working".
 */
async function abortIndependentLoop(subagentId: string, parentNarratorId: string): Promise<void> {
	try {
		const { interruptNarrator } = await import("./narrator-session");
		interruptNarrator(subagentId);
	} catch (err) {
		logger.warn("Failed to abort a subagent's own session loop", {
			parentNarratorId,
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Interrupt the foreground subagents that the parent's *just-cancelled* Agent
 * tool calls own.
 *
 * Scope is deliberately narrow: stopping a parent narrator cancels the Agent
 * tool calls of its current turn, and stopping their subagents is a consequence
 * of that cancellation — not of the parent's identity. A subagent the user is
 * driving themselves from its own panel (a `resumeSubagent` continuation, whose
 * run signal is independent of the parent by construction) is nobody's pending
 * tool call, and interrupting it would kill work the user never asked to stop.
 *
 * So membership is decided per entry, by two facts rather than by
 * `parentNarratorId`:
 * - `entry.parentSignal.aborted` — the Agent tool call that owns this subagent
 *   was itself cancelled. This is the signal the parent loop hands to the Task
 *   tool, so it covers a turn that started several subagents at once: aborting
 *   the parent marks every one of their entries at the same instant, with no
 *   need to count them here.
 * - `explicitSubagentIds` — the planned-update recovery path re-drives a
 *   foreground Agent through `resumeSubagent`, whose signal is deliberately NOT
 *   the parent's, so the aborted-signal test cannot see it. Its owner passes the
 *   ids it is waiting on.
 *
 * Entries whose parent signal is still live are left alone: their tool call is
 * running, and if the parent is being interrupted right now, its abort reaches
 * them through ProxyAbortController anyway.
 *
 * The DB/UI writes remain because the abort alone is not observable: a child
 * card would stay "working" if the parent loop unwinds before the child's own
 * finalizer broadcasts.
 */
export async function interruptForegroundSubagentsForParent(
	parentNarratorId: string,
	explicitSubagentIds?: Iterable<string>,
): Promise<number> {
	const explicit = new Set(explicitSubagentIds ?? []);
	const entries = [...getDetachableMap().values()].filter(
		(entry) =>
			entry.parentNarratorId === parentNarratorId &&
			(entry.parentSignal.aborted || explicit.has(entry.subagentId)),
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
				await abortIndependentLoop(subagentId, parentNarratorId);
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

	// An explicitly named subagent may have no detach entry at all: the recovery
	// path drives it through its own engine (session loop / resume run) rather
	// than the foreground runner. Its owner still declared it, so stop it and
	// settle its card. Ownership is verified against the DB — an id handed in by
	// mistake must not let one parent interrupt another parent's child.
	const unhandledExplicit = [...explicit].filter((id) => !touched.has(id));
	if (unhandledExplicit.length > 0) {
		const owned = await db.query.narrators.findMany({
			where: and(
				inArray(narrators.id, unhandledExplicit),
				eq(narrators.parentNarratorId, parentNarratorId),
				eq(narrators.isBackground, false),
				like(narrators.variant, "subagent:%"),
			),
			columns: { id: true, status: true },
		});
		for (const child of owned) {
			const childTakenOver = isTakenOver(child.id);
			if (!childTakenOver && child.status !== "working" && child.status !== "waiting") continue;
			try {
				if (childTakenOver) {
					// Clear takeover state first so preserveTakenOverSubstatus does not
					// re-add taken_over, and abort the subagent's independent loop.
					clearTakenOver(child.id);
				}
				// The subagent may be running on the generic session engine (a takeover,
				// or a recovery-driven continuation); that loop is only reachable here.
				await abortIndependentLoop(child.id, parentNarratorId);
				await markInterrupted(child.id);
			} catch (err) {
				logger.warn("Failed to interrupt declared foreground subagent", {
					parentNarratorId,
					subagentId: child.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	return interrupted;
}

export interface DetachSetupResult {
	alias: string;
	subagentType: string;
}

export interface DetachEntry {
	/** Stable identity of the foreground run that registered this detach entry. */
	runId: string;
	/** Called to set the detached flag inside runLoop and hand it the setup barrier. */
	markDetached: (setup: Promise<DetachSetupResult>) => void;
	/** Publish a one-time foreground handoff without settling the terminal promise. */
	publishHandoff: (result: string) => boolean;
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
// that the resumed foreground primitive can await.

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

	const manualClaim = isManualOverride(subagentId)
		? claimManualOverride(subagentId, "detach")
		: null;
	if (isManualOverride(subagentId) && !manualClaim) return false;
	const setupPromise = prepareDetachedBackgroundTask(subagentId, entry);

	// Mark as detached before any await/override resolution so runForegroundLoop cannot
	// race into the normal foreground finalizer while detach setup is in flight.
	entry.markDetached(setupPromise);
	if (getDetachableMap().get(subagentId) === entry) getDetachableMap().delete(subagentId);

	let setup: DetachSetupResult;
	try {
		setup = await setupPromise;
	} catch (err) {
		if (manualClaim) releaseManualOverrideClaim(manualClaim);
		logger.warn("Failed to detach subagent to background", {
			subagentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}

	if (manualClaim) {
		const { getSubagentFinalText } = await import("./narrator-session");
		const finalText = await getSubagentFinalText(subagentId);
		settleManualOverrideClaim(manualClaim, {
			action: "finish",
			finalText,
			hasError: false,
		});
	}

	// Immediately publish a foreground handoff (unblocks parent narrator) while the
	// terminal promise remains pending until the detached run truly completes.
	// The tag holds the alias: it is the selector the following sentence tells the
	// model to use, and a raw nanoid here is what it would otherwise memorize.
	const resultPrefix = `<background_task_id>${setup.alias}</background_task_id>\n\n`;
	entry.publishHandoff(
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
 * Called by the resumed subagent primitive when the target is a running background task.
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
		const label = await resolveAgentLabel(parentNarratorId, subagentId);
		return (
			`<background_task_id>${label}</background_task_id>\n\n` +
			`Attach interrupted. The subagent is still running in background. Use Await({ type: "agent", ` +
			`id: "${label}" }) to get results or Send({ id: "${label}", message }) to continue it.`
		);
	}

	const resultPrefix = agentResultTag(await resolveAgentLabel(parentNarratorId, subagentId));
	return appendSubagentFileChanges(
		parentNarratorId,
		null,
		resultPrefix + (result.finalText || "(no output)"),
	);
}
