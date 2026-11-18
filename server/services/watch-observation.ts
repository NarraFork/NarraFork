import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { registerTaskAlias } from "./subagent-alias";
import { WATCH_COMMAND_PREFIX } from "./terminal-watch-constants";

export const DEFAULT_WATCH_TIMEOUT_MS = 600_000;
export const MAX_WATCH_TIMEOUT_MS = 86_400_000;
export const MAX_WATCHES_PER_NARRATOR = 20;
export const PUBLISH_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
export const MAX_PUBLISH_RETRY_DELAY_MS = 30_000;

export interface ObservationResult {
	status: "completed" | "timeout" | "failed";
	output: string;
	/** The target's own completion notice fulfils this observation. */
	silent?: boolean;
}

export interface WatchObservation {
	taskId: string;
	alias: string;
	narratorId: string;
	signal: AbortSignal;
	finish(result: ObservationResult): Promise<void>;
	/** Release observation resources, without stopping the target or changing its task. */
	release(): void;
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
}

/** One bounded lifecycle for terminal, Bash and agent observations. */
export async function createWatchObservation(input: {
	narratorId: string;
	title: string;
	command: string;
	toolUseId?: string;
	/** Release source resources once, independently of pending result delivery. */
	onObservationEnd?: () => void;
}): Promise<WatchObservation> {
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

	const taskId = `bash_${generateShortId()}`;
	const { alias } = registerTaskAlias(input.narratorId, taskId, input.title);
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
	let service: typeof import("./background-task-service")["backgroundTaskService"];
	const observation: WatchObservation = {
		taskId,
		alias,
		narratorId: input.narratorId,
		signal: controller.signal,
		async finish(result) {
			if (released || frozen || state.suspended) return;
			frozen = { ...result };
			endObservation();
			await publish();
		},
		release() {
			if (released) return;
			released = true;
			if (retryTimer) clearTimeout(retryTimer);
			observations.delete(taskId);
			controller.abort();
			endObservation();
		},
	};
	// Reserve the slot before asynchronous task creation, including parallel registrations.
	observations.set(taskId, observation);

	async function publish(): Promise<void> {
		if (released || !frozen || state.suspended) return;
		attempts++;
		try {
			if (frozen.silent) {
				await service.finishObservationSilently(taskId, frozen.output);
			} else if (frozen.status === "failed") {
				await service.markFailed(taskId, frozen.output);
			} else {
				// A deadline ends the observation normally. It never times out the target.
				await service.markCompleted(taskId, frozen.output);
			}
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
		await service.createBashTask({
			id: taskId,
			parentNarratorId: input.narratorId,
			command: `${WATCH_COMMAND_PREFIX} ${input.command}`,
			toolUseId: input.toolUseId,
			alias,
			title: input.title,
		});
		service.registerAbortController(taskId, controller);
		service.registerKillHandler(taskId, observation.release);
		controller.signal.addEventListener("abort", observation.release, { once: true });
		if (state.suspended) observation.release();
		return observation;
	} catch (error) {
		observation.release();
		throw error;
	}
}
