/**
 * A space's lane: everything that changes a space while one of its pages is live runs here, one
 * task at a time, in arrival order: participants' frames, the sessions' own commits, writes made
 * outside the sessions (behind the barrier, `live-barrier.ts`) and pushing outside commits into
 * the sessions.
 *
 * Commits of one space are serialized by its seq counter anyway, so the lane costs no
 * parallelism; it gives the sessions a consistent picture: between two tasks the sessions'
 * mirrors match the database, and a frame is applied against the state its sender last saw
 * from the server, never against a half-applied outside write.
 *
 * Tasks run inside an async context that records the lane as held, so code a task calls
 * (`writeOutline` reaching the barrier) does not queue behind its own task.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@server/lib/logger";

interface LaneContext {
	/** Spaces whose lane this async context holds. */
	held: ReadonlySet<string>;
	/** Set while a live session writes its own commit: the commit listener skips it. */
	ownWrite: boolean;
}

const context = new AsyncLocalStorage<LaneContext>();

/** Whether the current async context runs inside a task of `spaceId`'s lane. */
export function holdsLane(spaceId: string): boolean {
	return context.getStore()?.held.has(spaceId) ?? false;
}

/** Whether the current async context is a live session writing its own commit. */
export function isOwnLiveWrite(): boolean {
	return context.getStore()?.ownWrite ?? false;
}

/** Run `fn` marked as a live session's own write (see {@link isOwnLiveWrite}). */
export async function asOwnLiveWrite<T>(fn: () => Promise<T>): Promise<T> {
	const current = context.getStore();
	return await context.run({ held: current?.held ?? new Set(), ownWrite: true }, fn);
}

type Task = () => Promise<void> | void;

export class SpaceLane {
	private readonly queue: Task[] = [];
	private running = false;
	/** Tasks queued or running; the registry drops an idle lane with no sessions. */
	private pending = 0;

	constructor(
		readonly spaceId: string,
		/** Runs after every task, inside the lane (the registry pushes outside commits here). */
		private readonly afterTask: () => Promise<void>,
	) {}

	get busy(): boolean {
		return this.pending > 0;
	}

	get queued(): number {
		return this.queue.length;
	}

	/** Queue a task; resolves with its result once it ran. */
	run<T>(task: () => Promise<T> | T): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.pending++;
			this.queue.push(async () => {
				try {
					resolve(await task());
				} catch (error) {
					reject(error);
				}
			});
			if (!this.running) void this.pump();
		});
	}

	private async pump(): Promise<void> {
		this.running = true;
		// Only this lane: whoever queued a task, it runs as this lane's task.
		const held = new Set([this.spaceId]);
		try {
			await context.run({ held, ownWrite: false }, async () => {
				for (let task = this.queue.shift(); task; task = this.queue.shift()) {
					try {
						await task();
						await this.afterTask();
					} catch (error) {
						logger.warn("Outline live lane task failed", {
							spaceId: this.spaceId,
							error: String(error),
						});
					} finally {
						this.pending--;
					}
				}
			});
		} finally {
			this.running = false;
			// A task queued after the loop saw the queue empty, while this pump was still ending,
			// found it running and did not start one: it must not wait for the next task.
			if (this.queue.length > 0) void this.pump();
		}
	}
}
