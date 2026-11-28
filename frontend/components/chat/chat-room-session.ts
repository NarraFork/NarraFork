import { ApiError } from "../../lib/api/client";
import { narratorWSManager } from "../../lib/narrator-ws-manager";

export interface ChatRoomLease {
	epoch: number;
	tailSeq: number;
}

/** One room join owner. ACKs and all REST results belong to an active epoch. */
export class ChatRoomSession {
	private epoch = 0;
	private lease: ChatRoomLease | undefined;
	private denied: ApiError | undefined;
	private waiters = new Set<() => void>();
	private dispose: (() => void) | undefined;

	constructor(
		readonly roomId: string,
		readonly permissionNarratorId?: string,
	) {}

	activate(onReconnect: () => void, onFrame?: (data: Record<string, unknown>) => void): () => void {
		this.deactivate();
		const handle = narratorWSManager.allocateId();
		let requestId = "";
		let stopped = false;
		let rejoinScheduled = false;
		const invalidate = () => {
			this.epoch++;
			this.lease = undefined;
			this.denied = undefined;
			this.notify();
		};
		const subscribe = () => {
			invalidate();
			requestId = `chat-${handle}-${this.epoch}`;
			narratorWSManager.joinChatRoom(this.roomId, handle, requestId);
		};
		const recover = () => {
			if (rejoinScheduled || stopped) return;
			rejoinScheduled = true;
			queueMicrotask(() => {
				rejoinScheduled = false;
				if (stopped) return;
				subscribe();
				onReconnect();
			});
		};
		const listener = narratorWSManager.addListener(
			{
				narratorIds: "*",
				types: [
					"chat:subscribed",
					"chat:subscription_denied",
					"chat:message",
					"chat:message_deleted",
					"narrator_access_changed",
					"project_access_changed",
					"workspace_context_changed",
				],
			},
			(data) => {
				if (
					data.type === "narrator_access_changed" ||
					data.type === "project_access_changed" ||
					data.type === "workspace_context_changed"
				) {
					if (
						this.permissionNarratorId &&
						(!data.narratorId || data.narratorId === this.permissionNarratorId)
					)
						recover();
					return;
				}
				if (data.roomId !== this.roomId) return;
				if (data.type === "chat:message_deleted" || data.type === "chat:message") {
					onFrame?.(data);
					return;
				}
				if (data.requestId !== requestId) return;
				if (data.type === "chat:subscription_denied") {
					this.denied = new ApiError("Chat room access denied", 403);
				} else if (Number.isSafeInteger(data.tailSeq) && (data.tailSeq as number) >= 0) {
					this.lease = { epoch: this.epoch, tailSeq: data.tailSeq as number };
				}
				this.notify();
			},
		);
		const connection = narratorWSManager.onConnectionChange((connected, reconnect) => {
			if (!connected) {
				invalidate();
				return;
			}
			subscribe();
			if (reconnect) onReconnect();
		});
		const stopRecovery = narratorWSManager.onControlPlaneRecovery?.(recover);
		subscribe();
		this.dispose = () => {
			stopped = true;
			stopRecovery?.();
			connection();
			narratorWSManager.removeListener(listener);
			narratorWSManager.leaveChatRoom(this.roomId, handle);
			invalidate();
		};
		return () => this.deactivate();
	}

	deactivate(): void {
		const dispose = this.dispose;
		this.dispose = undefined;
		dispose?.();
	}

	assertCurrent(lease: ChatRoomLease, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (!this.dispose || lease.epoch !== this.epoch) {
			throw new DOMException("Chat room epoch retired", "AbortError");
		}
	}

	waitReady(signal: AbortSignal): Promise<ChatRoomLease> {
		return new Promise((resolve, reject) => {
			const finish = (error?: unknown, lease?: ChatRoomLease) => {
				clearTimeout(timer);
				this.waiters.delete(check);
				signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else if (lease) resolve(lease);
			};
			const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
			const check = () => {
				if (signal.aborted) abort();
				else if (this.denied) finish(this.denied);
				else if (this.lease) finish(undefined, this.lease);
			};
			const timer = setTimeout(
				() => finish(new Error("Chat subscription acknowledgement timed out")),
				10_000,
			);
			this.waiters.add(check);
			signal.addEventListener("abort", abort, { once: true });
			check();
		});
	}

	private notify(): void {
		for (const waiter of this.waiters) waiter();
	}
}
