import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { registerTaskAlias, restoreTaskAlias } from "./subagent-alias";
import { WATCH_COMMAND_PREFIX } from "./terminal-watch-constants";

export const DEFAULT_WATCH_TIMEOUT_MS = 600_000;
export const MAX_WATCH_TIMEOUT_MS = 86_400_000;
export const MAX_WATCHES_PER_NARRATOR = 20;
export const PUBLISH_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
export const MAX_PUBLISH_RETRY_DELAY_MS = 30_000;
/** How long a delivered result keeps fulfilling the same watcher's later observations. */
export const COALESCED_DELIVERY_TTL_MS = 60_000;

export interface ObservationResult {
	status: "completed" | "timeout" | "failed";
	output: string;
	/** The target's own completion notice fulfils this observation. */
	silent?: boolean;
	/**
	 * Results with the same key (scoped to the watcher) describe one outcome of one
	 * target run: only the first is published; the rest settle silently once it is.
	 */
	coalesceKey?: string;
}

export interface WatchObservation {
	taskId: string;
	alias: string;
	narratorId: string;
	signal: AbortSignal;
	finish(result: ObservationResult): Promise<void>;
	/** Release observation resources, without stopping the target or changing its task. */
	release(): void;
	/**
	 * Move the deadline to `timeoutMs` from now when that is later. Returns the remaining
	 * time, or `undefined` once the observation has ended and can no longer be reused.
	 */
	extendDeadline(timeoutMs: number): number | undefined;
}

export interface WatchObservationInput {
	narratorId: string;
	title: string;
	command: string;
	toolUseId?: string;
	/** Release source resources once, independently of pending result delivery. */
	onObservationEnd?: () => void;
	/** Deadline owned by the observation, so a merged registration can extend it. */
	timeoutMs?: number;
	onDeadline?: () => void;
	/**
	 * Re-attach to a watch row left `running` by the previous server process instead
	 * of creating a new one. The original absolute deadline is kept: a restart never
	 * grants the observation extra time.
	 */
	adopt?: AdoptedWatchRow;
	/** Who registers this watch; restart re-attachment re-authorizes as this identity. */
	principal?: { userId: string | null };
}

export interface AdoptedWatchRow {
	taskId: string;
	alias?: string | null;
	/** Epoch ms: the row's creation time plus its recorded timeout. */
	deadlineAt: number;
}

/** A cancelled admission must not strand a task before its source observer exists. */
export async function cancelWatchRegistration(observation: WatchObservation): Promise<void> {
	try {
		const { backgroundTaskService } = await import("./background-task-service");
		await backgroundTaskService.cancel(observation.taskId);
	} catch (error) {
		await observation.finish({
			status: "failed",
			output: `Watch registration was interrupted, but its cancellation could not be saved: ${String(error)}. No target was stopped.`,
		});
		throw error;
	}
}

const observations = hotSafe(
	"narrafork:watch-observations",
	() => new Map<string, WatchObservation>(),
);
const state = hotSafe("narrafork:watch-shutdown", () => ({ suspended: false }));

interface Registration {
	ready: Promise<WatchObservation>;
}
/** Live observations by watcher + registration key, including ones still being created. */
const registrations = hotSafe(
	"narrafork:watch-registrations",
	() => new Map<string, Registration>(),
);

interface DeliveryFollower {
	/** The holder's notice landed: settle without publishing another one. */
	fulfil(): void;
	/** The holder ended unpublished: publish this observation's own result instead. */
	promote(): void;
}
interface Delivery {
	holder: string;
	published: boolean;
	followers: Map<string, DeliveryFollower>;
}
/** One published result per watcher + outcome key; later duplicates settle silently. */
const deliveries = hotSafe("narrafork:watch-deliveries", () => new Map<string, Delivery>());

function scopedKey(narratorId: string, key: string): string {
	return `${narratorId}\u0000${key}`;
}

if (hotOnce("narrafork:watch-owner-cleanup")) {
	eventBus.on("narrator:deleted", ({ narratorId }) => {
		for (const observation of [...observations.values()]) {
			if (observation.narratorId === narratorId) observation.release();
		}
	});
}

export function suspendWatchObservationsForShutdown(): void {
	state.suspended = true;
	for (const observation of [...observations.values()]) observation.release();
}

export function resumeWatchObservationsForTests(): void {
	state.suspended = false;
	registrations.clear();
	deliveries.clear();
}

/**
 * Store an extension so a restart re-attaches with it. A failed write only loses the
 * extension across a restart; the live observation already uses it.
 */
async function persistExtendedDeadline(taskId: string, deadlineAt: number): Promise<void> {
	try {
		const { backgroundTaskService } = await import("./background-task-service");
		await backgroundTaskService.extendWatchDeadline(taskId, deadlineAt);
	} catch (error) {
		logger.warn("Watch deadline extension was not persisted", { taskId, error: String(error) });
	}
}

/**
 * Admit a watch, reusing this watcher's live observation with the same key. Only the
 * watcher's own repeats merge: other watchers of the same target stay independent.
 */
export async function registerWatchObservation(
	input: WatchObservationInput & { dedupKey: string; timeoutMs: number },
): Promise<{ observation: WatchObservation; reused: boolean; remainingMs: number }> {
	const key = scopedKey(input.narratorId, input.dedupKey);
	for (;;) {
		const current = registrations.get(key);
		if (!current) break;
		const existing = await current.ready.catch(() => undefined);
		const remainingMs = existing?.extendDeadline(input.timeoutMs);
		if (existing && remainingMs !== undefined) {
			await persistExtendedDeadline(existing.taskId, Date.now() + remainingMs);
			return { observation: existing, reused: true, remainingMs };
		}
		if (registrations.get(key) === current) registrations.delete(key);
	}
	const registration: Registration = {
		ready: createWatchObservation({
			...input,
			onObservationEnd: () => {
				if (registrations.get(key) === registration) registrations.delete(key);
				input.onObservationEnd?.();
			},
		}),
	};
	registrations.set(key, registration);
	try {
		const observation = await registration.ready;
		const remainingMs = input.adopt
			? Math.max(0, input.adopt.deadlineAt - Date.now())
			: input.timeoutMs;
		return { observation, reused: false, remainingMs };
	} catch (error) {
		if (registrations.get(key) === registration) registrations.delete(key);
		throw error;
	}
}

/** One bounded lifecycle for terminal, Bash and agent observations. */
export async function createWatchObservation(
	input: WatchObservationInput,
): Promise<WatchObservation> {
	if (state.suspended) throw new Error("The server is shutting down; no watch was registered.");
	let active = 0;
	for (const observation of observations.values()) {
		if (observation.narratorId === input.narratorId) active++;
	}
	if (active >= MAX_WATCHES_PER_NARRATOR) {
		throw new Error(
			`This session already has ${active} active watches. Stop one before adding another.`,
		);
	}

	const taskId = input.adopt?.taskId ?? `bash_${generateShortId()}`;
	// An adopted row keeps the exact handle the session was given before the restart.
	const { alias } = input.adopt?.alias
		? restoreTaskAlias(input.narratorId, taskId, input.adopt.alias)
		: registerTaskAlias(input.narratorId, taskId, input.title);
	const controller = new AbortController();
	let released = false;
	let sourceReleased = false;
	const endObservation = () => {
		if (sourceReleased) return;
		sourceReleased = true;
		input.onObservationEnd?.();
	};
	let frozen: ObservationResult | undefined;
	let attempts = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let deadlineAt = input.adopt?.deadlineAt ?? Date.now() + (input.timeoutMs ?? 0);
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const clearDeadline = () => {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
	};
	const armDeadline = () => {
		clearDeadline();
		if (input.timeoutMs === undefined || !input.onDeadline || released || frozen) return;
		deadlineTimer = setTimeout(() => input.onDeadline?.(), Math.max(0, deadlineAt - Date.now()));
		deadlineTimer.unref?.();
	};
	let deliveryKey: string | undefined;
	let service: typeof import("./background-task-service")["backgroundTaskService"];
	const observation: WatchObservation = {
		taskId,
		alias,
		narratorId: input.narratorId,
		signal: controller.signal,
		async finish(result) {
			if (released || frozen || state.suspended) return;
			frozen = { ...result };
			clearDeadline();
			endObservation();
			if (result.coalesceKey && !joinDelivery(scopedKey(input.narratorId, result.coalesceKey)))
				return;
			await publish();
		},
		release() {
			if (released) return;
			released = true;
			clearDeadline();
			if (retryTimer) clearTimeout(retryTimer);
			observations.delete(taskId);
			leaveDelivery();
			controller.abort();
			endObservation();
		},
		extendDeadline(timeoutMs) {
			if (released || frozen || state.suspended || controller.signal.aborted) return undefined;
			deadlineAt = Math.max(deadlineAt, Date.now() + timeoutMs);
			armDeadline();
			return deadlineAt - Date.now();
		},
	};

	/** Returns whether this observation publishes now; otherwise it waits on the holder. */
	function joinDelivery(key: string): boolean {
		deliveryKey = key;
		const delivery = deliveries.get(key);
		if (!delivery) {
			deliveries.set(key, { holder: taskId, published: false, followers: new Map() });
			return true;
		}
		const fulfil = () => {
			if (!frozen) return;
			frozen = {
				...frozen,
				silent: true,
				output: `Observation fulfilled by an earlier notice from this session's watch of the same target and run.\n\n${frozen.output}`,
			};
			void publish();
		};
		if (delivery.published) fulfil();
		else delivery.followers.set(taskId, { fulfil, promote: () => void publish() });
		return false;
	}

	function settleDelivery(published: boolean): void {
		if (!deliveryKey) return;
		const key = deliveryKey;
		deliveryKey = undefined;
		const delivery = deliveries.get(key);
		if (!delivery) return;
		if (delivery.holder !== taskId) {
			delivery.followers.delete(taskId);
			return;
		}
		if (!published) {
			// The holder was cancelled before its notice landed: the next duplicate publishes.
			const next = delivery.followers.entries().next();
			if (next.done) {
				deliveries.delete(key);
				return;
			}
			const [nextId, follower] = next.value;
			delivery.followers.delete(nextId);
			delivery.holder = nextId;
			follower.promote();
			return;
		}
		delivery.published = true;
		const followers = [...delivery.followers.values()];
		delivery.followers.clear();
		for (const follower of followers) follower.fulfil();
		const expiry = setTimeout(() => {
			if (deliveries.get(key) === delivery) deliveries.delete(key);
		}, COALESCED_DELIVERY_TTL_MS);
		expiry.unref?.();
	}

	function leaveDelivery(): void {
		if (deliveryKey) settleDelivery(false);
	}
	// Reserve the slot before asynchronous task creation, including parallel registrations.
	observations.set(taskId, observation);

	async function publish(): Promise<void> {
		if (released || !frozen || state.suspended) return;
		attempts++;
		try {
			if (frozen.silent) {
				await service.finishObservationSilently(
					taskId,
					frozen.output,
					frozen.status === "failed" ? "failed" : "completed",
				);
			} else if (frozen.status === "failed") {
				await service.markFailed(taskId, frozen.output);
			} else {
				// A deadline ends the observation normally. It never times out the target.
				await service.markCompleted(taskId, frozen.output);
			}
			settleDelivery(true);
			observation.release();
		} catch (error) {
			if (released) return;
			// Retain this one frozen result until storage recovers or the watch is cancelled.
			// Pending delivery still occupies the existing per-narrator budget.
			const delay = PUBLISH_RETRY_DELAYS_MS[attempts - 1] ?? MAX_PUBLISH_RETRY_DELAY_MS;
			logger.warn("Watch result publication deferred", {
				taskId,
				attempts,
				error: String(error),
				retryInMs: delay,
			});
			retryTimer = setTimeout(() => void publish(), delay);
			retryTimer.unref?.();
		}
	}

	try {
		service = (await import("./background-task-service")).backgroundTaskService;
		// An adopted row already exists and is still `running`: restart recovery skipped
		// it so this process can finish it through the ordinary publication path.
		if (!input.adopt)
			await service.createBashTask({
				id: taskId,
				parentNarratorId: input.narratorId,
				command: `${WATCH_COMMAND_PREFIX} ${input.command}`,
				toolUseId: input.toolUseId,
				alias,
				title: input.title,
				principal: input.principal,
			});
		service.registerAbortController(taskId, controller);
		service.registerKillHandler(taskId, observation.release);
		controller.signal.addEventListener("abort", observation.release, { once: true });
		if (state.suspended) observation.release();
		else armDeadline();
		return observation;
	} catch (error) {
		observation.release();
		throw error;
	}
}
