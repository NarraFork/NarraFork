/**
 * Background Bash on a remote device, in a durable executor session
 * (`session.exec.v1`, see docs/GENERAL_EXECUTOR-DESIGN.md).
 *
 * Unlike `exec.start`, the command belongs to the executor process: a lost device
 * connection or a NarraFork restart only detaches, and reading resumes at the next
 * unread byte. The session is stopped and released only from a durable intent
 * (`executor-session-cleanup`): on kill, or once the task's terminal state is
 * committed, so the executor keeps the output and exit until NarraFork no longer
 * needs them.
 */
import type { ExecHandle, ExecutorSessionBinding } from "../lib/agent/execution/backend";
import {
	type RemoteExecOpen,
	type RemoteSessionDependencies,
	type RemoteSessionRuntime,
	spawnRemoteSession,
} from "../terminal/remote-session";
import { stopExecutorSession } from "./executor-session-cleanup";

/** Executor session id for a background task: deterministic, so a restart finds it. */
export function backgroundSessionId(taskId: string): string {
	return `nf-bash-${taskId}`;
}

export interface RemoteSessionExecOptions {
	/** Present to start the command; absent to re-attach after a restart. */
	open?: RemoteExecOpen;
	/** Stops the command when aborted (cancellation of a fresh launch). */
	signal?: AbortSignal;
}

export class RemoteSessionExecHandle implements ExecHandle {
	readonly pid = undefined;
	readonly exited: Promise<number | null>;
	/** Settles once the executor confirmed the start (immediately when re-attaching). */
	readonly ready: Promise<void>;
	private readonly runtime: RemoteSessionRuntime;
	private readonly callbacks: Array<(chunk: Uint8Array) => void> = [];
	private pending: Uint8Array[] = [];
	private incomplete = false;
	private exitedFlag = false;
	private stopRequested = false;

	constructor(
		readonly binding: ExecutorSessionBinding,
		options: RemoteSessionExecOptions,
		deps: RemoteSessionDependencies = {},
	) {
		this.runtime = spawnRemoteSession(
			binding.deviceId,
			binding.sessionId,
			{
				...(options.open ? { open: options.open } : {}),
				// The task's output lives in memory only, so a re-attach replays everything the
				// executor still retains; anything older arrives as a gap notice.
				since: 0,
				onBytes: (chunk) => this.deliver(chunk),
				onGap: () => {
					this.incomplete = true;
				},
				onLost: (reason) => {
					this.incomplete = true;
					this.deliver(
						new TextEncoder().encode(
							`\n[NarraFork: the device no longer has this command's session: ${reason}]\n`,
						),
					);
				},
			},
			deps,
		);
		this.ready = this.runtime.ready ?? Promise.resolve();
		this.exited = this.runtime.exited.then((code) => {
			this.exitedFlag = true;
			return code;
		});
		const signal = options.signal;
		if (signal) {
			const onAbort = () => void this.kill();
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				void this.exited.finally(() => signal.removeEventListener("abort", onAbort));
			}
		}
	}

	private deliver(chunk: Uint8Array): void {
		if (this.callbacks.length === 0) {
			this.pending.push(chunk);
			return;
		}
		for (const cb of this.callbacks) cb(chunk);
	}

	onData(cb: (chunk: Uint8Array) => void): void {
		this.callbacks.push(cb);
		if (this.callbacks.length !== 1) return;
		const queued = this.pending;
		this.pending = [];
		for (const chunk of queued) cb(chunk);
	}

	isExited(): boolean {
		return this.exitedFlag;
	}

	/** True after a gap or a lost session: some of the command's output never arrived. */
	outputIncomplete(): boolean {
		return this.incomplete;
	}

	/**
	 * Stop the command. The intent is durable before anything else happens, so a
	 * device that is away (or a restart) cannot leave it running; reading stops at
	 * once instead of waiting for the device to confirm.
	 */
	async kill(): Promise<void> {
		if (this.stopRequested) return;
		this.stopRequested = true;
		try {
			await stopExecutorSession(this.binding.deviceId, this.binding.sessionId);
		} finally {
			this.runtime.kill();
		}
	}

	/** The task's result is persisted: the executor may forget the session now. */
	async afterTerminalCommitted(): Promise<void> {
		if (this.stopRequested) return;
		this.stopRequested = true;
		this.runtime.detach();
		await stopExecutorSession(this.binding.deviceId, this.binding.sessionId);
	}

	/** Stop reading without touching the command (handover to a later process). */
	detach(): void {
		this.runtime.detach();
	}
}
