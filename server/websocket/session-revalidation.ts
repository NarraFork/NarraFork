import type { AuthReadOptions } from "../lib/auth-read-admission";

interface SessionSocket {
	readyState: number;
	data: { sessionId?: string; sessionUserId?: string };
}

interface Target {
	data: SessionSocket["data"];
	sessionId: string | undefined;
	userId: string | undefined;
	epoch: number;
}

interface RevalidationOptions<Socket, Result> {
	read(sessionId: string, options: AuthReadOptions): Promise<Result>;
	/** Async completions must check isCurrent again before applying any late effect. */
	apply(socket: Socket, result: Result, isCurrent: () => boolean): void | Promise<void>;
	withoutSession(socket: Socket, isCurrent: () => boolean): void | Promise<void>;
	/** Independent channel authorization still runs when the session lookup is unavailable. */
	afterReadFailure?(socket: Socket, isCurrent: () => boolean): void | Promise<void>;
	onError(socket: Socket, error: unknown): void;
	onRoundError(error: unknown): void;
}

/** One bounded live-target set, one sequential reader, and no retained auth results. */
export class SessionRevalidation<Socket extends SessionSocket, Result> {
	private readonly epochs = new WeakMap<Socket, number>();
	private readonly targets = new Set<Socket>();
	private readonly pending = new Set<Socket>();
	private round = new Map<string, Map<Socket, Target>>();
	private dispatched = new Set<string>();
	private inFlight: Promise<void> | null = null;
	private stopped = false;
	private generation = 0;
	private controller: AbortController | null = null;
	private yieldTimer: ReturnType<typeof setTimeout> | null = null;
	private resumeYield: (() => void) | null = null;

	constructor(private options: RevalidationOptions<Socket, Result>) {}

	configure(options: RevalidationOptions<Socket, Result>): void {
		this.options = options;
	}

	start(): void {
		this.stopped = false;
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		this.pending.clear();
		this.targets.clear();
		for (const group of this.round.values()) group.clear();
		this.round.clear();
		this.dispatched.clear();
		this.controller?.abort();
		if (this.yieldTimer !== null) clearTimeout(this.yieldTimer);
		this.yieldTimer = null;
		this.resumeYield?.();
		this.resumeYield = null;
	}

	forget(socket: Socket): void {
		this.epochs.set(socket, (this.epochs.get(socket) ?? 0) + 1);
		this.targets.delete(socket);
		this.pending.delete(socket);
		for (const group of this.round.values()) group.delete(socket);
	}

	/** Include explicit in-flight targets as well as current production connections. */
	invalidate(sockets: readonly Socket[], matches: (socket: Socket) => boolean): Promise<void> {
		if (this.stopped) return Promise.resolve();
		for (const socket of new Set([...this.targets, ...sockets])) {
			if (socket.readyState !== 1) {
				this.forget(socket);
				continue;
			}
			if (!matches(socket)) continue;
			this.epochs.set(socket, (this.epochs.get(socket) ?? 0) + 1);
			this.targets.add(socket);
			this.pending.add(socket);
		}
		return this.ensureRunning();
	}

	revalidate(sockets: readonly Socket[]): Promise<void> {
		if (this.stopped) return Promise.resolve();
		for (const socket of sockets) {
			if (socket.readyState !== 1) {
				this.forget(socket);
				continue;
			}
			this.targets.add(socket);
			const sessionId = socket.data.sessionId;
			const group = sessionId ? this.round.get(sessionId) : undefined;
			const target = group?.get(socket);
			if (
				target &&
				target.data === socket.data &&
				target.userId === socket.data.sessionUserId &&
				target.epoch === (this.epochs.get(socket) ?? 0)
			)
				continue;
			// A new socket can join a not-yet-dispatched read of the same session.
			if (
				group &&
				sessionId &&
				!target &&
				!this.dispatched.has(sessionId) &&
				!this.pending.has(socket)
			) {
				group.set(socket, this.snapshot(socket, sessionId));
				continue;
			}
			this.pending.add(socket);
		}
		return this.ensureRunning();
	}

	private snapshot(socket: Socket, sessionId: string | undefined): Target {
		return {
			data: socket.data,
			sessionId,
			userId: socket.data.sessionUserId,
			epoch: this.epochs.get(socket) ?? 0,
		};
	}

	private isCurrent(socket: Socket, target: Target, generation: number): boolean {
		return (
			!this.stopped &&
			generation === this.generation &&
			this.targets.has(socket) &&
			socket.readyState === 1 &&
			socket.data === target.data &&
			socket.data.sessionId === target.sessionId &&
			socket.data.sessionUserId === target.userId &&
			(this.epochs.get(socket) ?? 0) === target.epoch
		);
	}

	private ensureRunning(yieldFirst = false): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (!this.pending.size) return Promise.resolve();
		let finish!: () => void;
		let fail!: (error: unknown) => void;
		const promise = new Promise<void>((resolve, reject) => {
			finish = resolve;
			fail = reject;
		});
		this.inFlight = promise;
		void this.run(yieldFirst).then(finish, fail);
		return promise;
	}

	private yieldRound(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.resumeYield = resolve;
			this.yieldTimer = setTimeout(() => {
				this.yieldTimer = null;
				this.resumeYield = null;
				resolve();
			}, 0);
		});
	}

	private async run(yieldFirst: boolean): Promise<void> {
		try {
			if (yieldFirst) await this.yieldRound();
			while (!this.stopped && this.pending.size) {
				const generation = this.generation;
				const round = new Map<string, Map<Socket, Target>>();
				this.round = round;
				this.dispatched = new Set();
				const pending = [...this.pending];
				this.pending.clear();
				for (const socket of pending) {
					if (this.stopped || generation !== this.generation) break;
					if (socket.readyState !== 1) continue;
					const sessionId = socket.data.sessionId;
					if (!sessionId) {
						const target = this.snapshot(socket, sessionId);
						const completion = this.options.withoutSession(socket, () =>
							this.isCurrent(socket, target, generation),
						);
						if (completion) await completion;
						continue;
					}
					let group = round.get(sessionId);
					if (!group) {
						group = new Map();
						round.set(sessionId, group);
					}
					group.set(socket, this.snapshot(socket, sessionId));
				}
				for (const [sessionId, group] of round) {
					if (this.stopped || generation !== this.generation) break;
					if (!group.size) continue;
					this.dispatched.add(sessionId);
					const controller = new AbortController();
					this.controller = controller;
					let result: Result;
					try {
						result = await this.options.read(sessionId, { signal: controller.signal });
					} catch (error) {
						const socket = group.keys().next().value;
						if (socket && !this.stopped) this.options.onError(socket, error);
						for (const [socket, target] of group) {
							const isCurrent = () => this.isCurrent(socket, target, generation);
							if (!isCurrent()) continue;
							const completion = this.options.afterReadFailure?.(socket, isCurrent);
							if (completion) await completion;
						}
						continue;
					} finally {
						this.controller = null;
					}
					for (const [socket, target] of group) {
						const isCurrent = () => this.isCurrent(socket, target, generation);
						if (!isCurrent()) continue;
						const completion = this.options.apply(socket, result, isCurrent);
						if (completion) await completion;
					}
					// Keep target snapshots until round end, never the query result.
				}
				this.round = new Map();
				for (const socket of this.targets) {
					if (!this.pending.has(socket)) this.targets.delete(socket);
				}
				if (!this.stopped && this.pending.size) await this.yieldRound();
			}
		} finally {
			// No await between the final dirty check and clearing in-flight ownership.
			this.round.clear();
			this.dispatched.clear();
			for (const socket of this.targets) {
				if (socket.readyState !== 1) this.pending.delete(socket);
				if (!this.pending.has(socket)) this.targets.delete(socket);
			}
			this.inFlight = null;
			// A failed cleanup must not swallow other targets dirtied during this round.
			// Only already-pending work is handed off; the failed target is not retried by itself.
			if (!this.stopped && this.pending.size) {
				void this.ensureRunning(true).catch((error: unknown) => {
					try {
						this.options.onRoundError(error);
					} catch {
						// Diagnostic callbacks cannot create an unhandled background rejection.
					}
				});
			}
		}
	}
}
