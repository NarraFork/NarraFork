import { expect, mock, test } from "bun:test";
import type { AuthReadOptions } from "../../lib/auth-read-admission";
import { SessionRevalidation } from "../session-revalidation";

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function socket(sessionId = "session", userId = "user") {
	return { readyState: 1, data: { sessionId, sessionUserId: userId }, role: "admin", exp: 1 };
}
type Socket = ReturnType<typeof socket>;
type Result = { role: string; exp: number } | null;
function setup(read: (sessionId: string, options: AuthReadOptions) => Promise<Result>) {
	const apply = mock(
		(ws: Socket, result: Result, _isCurrent: () => boolean): void | Promise<void> => {
			if (result) {
				ws.role = result.role;
				ws.exp = result.exp;
			} else ws.readyState = 3;
		},
	);
	const onError = mock(() => {});
	const withoutSession = mock((_ws: Socket, _isCurrent: () => boolean): void | Promise<void> => {});
	const onRoundError = mock((_error: unknown) => {});
	const afterReadFailure = mock(
		(_ws: Socket, _isCurrent: () => boolean): void | Promise<void> => {},
	);
	const scheduler = new SessionRevalidation({
		read,
		apply,
		onError,
		withoutSession,
		onRoundError,
		afterReadFailure,
	});
	return { scheduler, apply, onError, withoutSession, onRoundError, afterReadFailure };
}
const live = { role: "user", exp: 20 };

test("same-session sockets and overlapping heartbeats share one read, next round reads afresh", async () => {
	const held = gate<Result>();
	const read = mock(() => held.promise);
	const { scheduler, apply } = setup(read);
	const a = socket();
	const b = socket();
	const first = scheduler.revalidate([a, b]);
	const overlap = scheduler.revalidate([a, b]);
	expect(overlap).toBe(first);
	expect(read).toHaveBeenCalledTimes(1);
	held.resolve(live);
	await first;
	expect(apply).toHaveBeenCalledTimes(2);
	await scheduler.revalidate([a]);
	expect(read).toHaveBeenCalledTimes(2);
});

test("different sessions read sequentially, completed targets do not repeat under heartbeats", async () => {
	const aRead = gate<Result>();
	const bRead = gate<Result>();
	const reads: string[] = [];
	let active = 0;
	let maximum = 0;
	const { scheduler } = setup(async (id) => {
		reads.push(id);
		maximum = Math.max(maximum, ++active);
		try {
			return await (id === "a" ? aRead.promise : bRead.promise);
		} finally {
			active--;
		}
	});
	const a = socket("a");
	const b = socket("b");
	const first = scheduler.revalidate([a, b]);
	expect(reads).toEqual(["a"]);
	aRead.resolve(live);
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toEqual(["a", "b"]);
	const overlap = scheduler.revalidate([a, b]);
	bRead.resolve(live);
	await overlap;
	await first;
	expect(reads).toEqual(["a", "b"]);
	expect(maximum).toBe(1);
});

test("user-scoped auth changes suppress stale grant and merge many events into one tail round", async () => {
	const stale = gate<Result>();
	const read = mock(async () => (read.mock.calls.length === 1 ? stale.promise : live));
	const { scheduler, apply } = setup(read);
	const a = socket();
	const run = scheduler.revalidate([a]);
	for (let index = 0; index < 20; index++) {
		expect(scheduler.invalidate([], (ws) => ws.data.sessionUserId === "user")).toBe(run);
	}
	stale.resolve({ role: "admin", exp: 10 });
	await run;
	expect(read).toHaveBeenCalledTimes(2);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(a.role).toBe("user");
	expect(a.exp).toBe(20);
});

for (const oldResult of [{ role: "admin", exp: 10 }, null]) {
	test(`new socket after auth change never inherits dispatched ${oldResult ? "admin" : "missing-session"} result`, async () => {
		const stale = gate<Result>();
		let calls = 0;
		const { scheduler, apply } = setup(async () => (++calls === 1 ? stale.promise : live));
		const a = socket();
		const run = scheduler.revalidate([a]);
		void scheduler.invalidate([], () => true);
		const b = socket();
		b.role = "user";
		expect(scheduler.revalidate([b])).toBe(run);
		stale.resolve(oldResult);
		await run;
		expect(calls).toBe(2);
		expect(apply).toHaveBeenCalledTimes(2);
		expect(apply.mock.calls.every(([, result]) => result === live)).toBe(true);
		expect([a.role, b.role]).toEqual(["user", "user"]);
		expect([a.readyState, b.readyState]).toEqual([1, 1]);
	});
}

for (const oldResult of [{ role: "admin", exp: 10 }, null]) {
	test(`a socket arriving after dispatch only receives the next ${oldResult ? "role" : "session"} result`, async () => {
		const stale = gate<Result>();
		let calls = 0;
		const { scheduler, apply } = setup(async () => (++calls === 1 ? stale.promise : live));
		const a = socket();
		const first = scheduler.revalidate([a]);
		const b = socket();
		b.role = "user";
		expect(scheduler.revalidate([b])).toBe(first);
		stale.resolve(oldResult);
		await first;
		expect(calls).toBe(2);
		expect(apply.mock.calls.map(([ws, result]) => [ws, result])).toEqual([
			[a, oldResult],
			[b, live],
		]);
		expect(b.role).toBe("user");
		expect(b.readyState).toBe(1);
	});
}

test("stale missing-session result cannot close a changed target, unrelated user still applies", async () => {
	const stale = gate<Result>();
	const reads: string[] = [];
	const { scheduler, apply } = setup(async (id) => {
		reads.push(id);
		return reads.length === 1 ? stale.promise : live;
	});
	const a = socket("a", "alice");
	const b = socket("b", "bob");
	const run = scheduler.revalidate([a, b]);
	void scheduler.invalidate([], (ws) => ws.data.sessionUserId === "alice");
	stale.resolve(null);
	await run;
	expect(reads).toEqual(["a", "b", "a"]);
	expect(a.readyState).toBe(1);
	expect(apply.mock.calls.map(([ws]) => ws)).toEqual([b, a]);
});

test("auth change at the last result application schedules a yielding tail instead of losing dirty", async () => {
	const reads = mock(async () => live);
	const a = socket();
	const { scheduler, apply } = setup(reads);
	let yielded = false;
	setTimeout(() => {
		yielded = true;
	}, 0);
	apply.mockImplementationOnce(() => {
		void scheduler.invalidate([], () => true);
	});
	apply.mockImplementationOnce(() => {
		expect(yielded).toBe(true);
	});
	await scheduler.revalidate([a]);
	expect(reads).toHaveBeenCalledTimes(2);
	expect(apply).toHaveBeenCalledTimes(2);
});

test("close and session/user identity changes during read prevent application", async () => {
	const held = gate<Result>();
	const { scheduler, apply } = setup(() => held.promise);
	const closed = socket();
	const sessionChanged = socket();
	const userChanged = socket();
	const run = scheduler.revalidate([closed, sessionChanged, userChanged]);
	closed.readyState = 3;
	sessionChanged.data.sessionId = "other";
	userChanged.data.sessionUserId = "other";
	held.resolve(null);
	await run;
	expect(apply).not.toHaveBeenCalled();
});

test("storage failure preserves sockets and later explicit calls retry the live read", async () => {
	const read = mock(async (): Promise<Result> => {
		throw new Error("unavailable");
	});
	const { scheduler, apply, onError } = setup(read);
	const a = socket();
	await scheduler.revalidate([a]);
	expect(onError).toHaveBeenCalledTimes(1);
	expect(apply).not.toHaveBeenCalled();
	expect(a.readyState).toBe(1);
	read.mockResolvedValue(live);
	await scheduler.revalidate([a]);
	expect(apply).toHaveBeenCalledTimes(1);
});

test("session read failures await each current socket's independent authorization in one round", async () => {
	const entered = gate<void>();
	const held = gate<void>();
	const read = mock(async (): Promise<Result> => {
		throw new Error("session read failed");
	});
	const { scheduler, apply, onError, afterReadFailure } = setup(read);
	const a = socket();
	const b = socket();
	afterReadFailure.mockImplementationOnce(async (_ws, isCurrent) => {
		entered.resolve();
		await held.promise;
		expect(isCurrent()).toBe(true);
	});
	const first = scheduler.revalidate([a, b]);
	await entered.promise;
	expect(scheduler.revalidate([a, b])).toBe(first);
	held.resolve();
	await first;
	expect(read).toHaveBeenCalledTimes(1);
	expect(onError).toHaveBeenCalledTimes(1);
	expect(afterReadFailure.mock.calls.map(([ws]) => ws)).toEqual([a, b]);
	expect(apply).not.toHaveBeenCalled();
});

test("a read failure cannot authorize an identity replaced before its completion", async () => {
	const held = gate<void>();
	const { scheduler, afterReadFailure } = setup(async () => {
		await held.promise;
		throw new Error("session read failed");
	});
	const a = socket();
	const first = scheduler.revalidate([a]);
	a.data.sessionId = "replacement";
	held.resolve();
	await first;
	expect(afterReadFailure).not.toHaveBeenCalled();
});

test("independent authorization cleanup failures reject and retain only already-dirty tail work", async () => {
	const entered = gate<void>();
	const held = gate<void>();
	const applied = gate<void>();
	const read = mock(async (): Promise<Result> => {
		throw new Error("session read failed");
	});
	const { scheduler, afterReadFailure } = setup(read);
	const failure = new Error("authorization cleanup failed");
	afterReadFailure.mockImplementationOnce(async () => {
		entered.resolve();
		await held.promise;
		throw failure;
	});
	afterReadFailure.mockImplementationOnce(() => applied.resolve());
	const a = socket();
	const failed = scheduler.revalidate([a]).catch((error: unknown) => error);
	await entered.promise;
	void scheduler.invalidate([], () => true);
	held.resolve();
	expect(await failed).toBe(failure);
	await applied.promise;
	await scheduler.revalidate([]);
	expect(read).toHaveBeenCalledTimes(2);
	expect(afterReadFailure).toHaveBeenCalledTimes(2);
	expect(a.readyState).toBe(1);
});

test("stop aborts current read, discards dirty targets and prevents late application or restart", async () => {
	const held = gate<Result>();
	let signal: AbortSignal | undefined;
	const read = mock((_id: string, options: AuthReadOptions) => {
		signal = options.signal;
		return held.promise;
	});
	const { scheduler, apply } = setup(read);
	const a = socket();
	const run = scheduler.revalidate([a]);
	void scheduler.invalidate([], () => true);
	scheduler.stop();
	expect(signal?.aborted).toBe(true);
	held.resolve(null);
	await run;
	await scheduler.revalidate([a]);
	expect(apply).not.toHaveBeenCalled();
	expect(read).toHaveBeenCalledTimes(1);
	scheduler.start();
	await scheduler.revalidate([a]);
	expect(read).toHaveBeenCalledTimes(2);
});

test("stop during inter-round yield clears the timer and pending round", async () => {
	const read = mock(async () => live);
	const { scheduler, apply } = setup(read);
	apply.mockImplementationOnce(() => {
		void scheduler.invalidate([], () => true);
		queueMicrotask(() => scheduler.stop());
	});
	await scheduler.revalidate([socket()]);
	expect(read).toHaveBeenCalledTimes(1);
});

for (const latest of [live, null]) {
	test(`dirty ${latest ? "downgrade" : "revocation"} survives another session's cleanup failure`, async () => {
		const stale = gate<Result>();
		const applied = gate<void>();
		const reads: string[] = [];
		let active = 0;
		let maximum = 0;
		let aReads = 0;
		let yielded = false;
		const { scheduler, apply, onError } = setup(async (id) => {
			reads.push(id);
			maximum = Math.max(maximum, ++active);
			try {
				if (id === "a" && ++aReads === 1) return await stale.promise;
				if (id === "a") {
					expect(yielded).toBe(true);
					return latest;
				}
				return null;
			} finally {
				active--;
			}
		});
		const a = socket("a", "alice");
		const b = socket("b", "bob");
		const failure = new Error("bob channel cleanup failed");
		apply.mockImplementation((ws, result) => {
			if (ws === b) throw failure;
			if (result) {
				ws.role = result.role;
				ws.exp = result.exp;
			} else ws.readyState = 3;
			applied.resolve();
		});
		const failed = scheduler.revalidate([a, b]).catch((error: unknown) => error);
		void scheduler.invalidate([], (ws) => ws === a);
		setTimeout(() => {
			yielded = true;
		}, 0);
		stale.resolve({ role: "admin", exp: 10 });
		expect(await failed).toBe(failure);
		// No heartbeat or revalidate call triggers the tail: the dirty handoff owns it.
		await applied.promise;
		expect(reads).toEqual(["a", "b", "a"]);
		expect(maximum).toBe(1);
		expect(onError).not.toHaveBeenCalled();
		expect(a.readyState).toBe(latest ? 1 : 3);
		if (latest) expect(a.role).toBe("user");
		await scheduler.revalidate([]);
		expect(reads).toEqual(["a", "b", "a"]);
	});
}

test("an automatic tail cleanup error is reported once and does not retry without new dirty work", async () => {
	const stale = gate<Result>();
	const reported = gate<void>();
	const reads: string[] = [];
	let aReads = 0;
	const { scheduler, apply, onRoundError } = setup(async (id) => {
		reads.push(id);
		return id === "a" && ++aReads === 1 ? stale.promise : null;
	});
	const a = socket("a");
	const b = socket("b");
	const failure = new Error("channel cleanup failed");
	apply.mockImplementation(() => {
		throw failure;
	});
	onRoundError.mockImplementation((error) => {
		expect(error).toBe(failure);
		reported.resolve();
		throw new Error("diagnostic callback failed");
	});
	const failed = scheduler.revalidate([a, b]).catch((error: unknown) => error);
	void scheduler.invalidate([], (ws) => ws === a);
	stale.resolve(live);
	expect(await failed).toBe(failure);
	await reported.promise;
	await scheduler.revalidate([]);
	expect(reads).toEqual(["a", "b", "a"]);
	expect(onRoundError).toHaveBeenCalledTimes(1);
});

test("stop cancels an automatic dirty handoff before its yielding tail dispatches", async () => {
	const stale = gate<Result>();
	const reads: string[] = [];
	const { scheduler, apply } = setup(async (id) => {
		reads.push(id);
		return id === "a" ? stale.promise : null;
	});
	const a = socket("a");
	const failure = new Error("channel cleanup failed");
	apply.mockImplementation(() => {
		throw failure;
	});
	const failed = scheduler.revalidate([a, socket("b")]).catch((error: unknown) => error);
	void scheduler.invalidate([], (ws) => ws === a);
	stale.resolve(live);
	expect(await failed).toBe(failure);
	scheduler.stop();
	await Promise.resolve();
	await Promise.resolve();
	expect(reads).toEqual(["a", "b"]);
});

test("ended-session channel cleanup errors reject without becoming storage failures", async () => {
	const read = mock(async (): Promise<Result> => null);
	const { scheduler, apply, onError } = setup(read);
	const a = socket();
	const failure = new Error("channel cleanup failed");
	apply.mockImplementationOnce(() => {
		throw failure;
	});
	expect(await scheduler.revalidate([a]).catch((error: unknown) => error)).toBe(failure);
	expect(onError).not.toHaveBeenCalled();
	await scheduler.revalidate([a]);
	expect(read).toHaveBeenCalledTimes(2);
	expect(a.readyState).toBe(3);
});

test("a legacy socket needs no lookup, and cleanup failure rejects its awaitable round", async () => {
	const read = mock(async () => live);
	const { scheduler, withoutSession } = setup(read);
	const a = socket("");
	const failure = new Error("channel cleanup failed");
	withoutSession.mockImplementationOnce(() => {
		throw failure;
	});
	expect(await scheduler.revalidate([a]).catch((error: unknown) => error)).toBe(failure);
	await scheduler.revalidate([a]);
	expect(withoutSession).toHaveBeenCalledTimes(2);
	expect(read).not.toHaveBeenCalled();
});

test("async application owns the shared awaitable round and delays the next session read", async () => {
	const entered = gate<void>();
	const held = gate<void>();
	const reads: string[] = [];
	const { scheduler, apply } = setup(async (id) => {
		reads.push(id);
		return live;
	});
	const a = socket("a");
	const b = socket("b");
	apply.mockImplementationOnce(async (_ws, _result, isCurrent) => {
		entered.resolve();
		await held.promise;
		expect(isCurrent()).toBe(true);
	});
	const first = scheduler.revalidate([a, b]);
	await entered.promise;
	expect(scheduler.revalidate([a, b])).toBe(first);
	expect(reads).toEqual(["a"]);
	held.resolve();
	await first;
	expect(reads).toEqual(["a", "b"]);
});

for (const change of ["epoch", "session", "user", "data", "closed", "stop", "restart", "forget"]) {
	test(`async completion guard rejects a stale ${change} target`, async () => {
		const entered = gate<void>();
		const held = gate<void>();
		const effects = mock(() => {});
		const read = mock(async () => live);
		const { scheduler, apply } = setup(read);
		const a = socket();
		apply.mockImplementationOnce(async (_ws, _result, isCurrent) => {
			entered.resolve();
			await held.promise;
			if (isCurrent()) effects();
		});
		const first = scheduler.revalidate([a]);
		await entered.promise;
		if (change === "epoch") void scheduler.invalidate([], () => true);
		if (change === "session") a.data.sessionId = "replacement";
		if (change === "user") a.data.sessionUserId = "replacement";
		if (change === "data") a.data = { ...a.data };
		if (change === "closed") a.readyState = 3;
		if (change === "stop" || change === "restart") scheduler.stop();
		if (change === "restart") scheduler.start();
		if (change === "forget") {
			scheduler.forget(a);
			expect(scheduler.revalidate([a])).toBe(first);
		}
		held.resolve();
		await first;
		expect(effects).not.toHaveBeenCalled();
		expect(read).toHaveBeenCalledTimes(change === "epoch" || change === "forget" ? 2 : 1);
	});
}

test("async cleanup rejection preserves dirty work and remains an awaitable application error", async () => {
	const entered = gate<void>();
	const held = gate<void>();
	const applied = gate<void>();
	const reads: string[] = [];
	const { scheduler, apply, onError } = setup(async (id) => {
		reads.push(id);
		return live;
	});
	const a = socket("a");
	const failure = new Error("async cleanup failed");
	apply.mockImplementationOnce(async () => {
		entered.resolve();
		await held.promise;
		throw failure;
	});
	apply.mockImplementationOnce(() => applied.resolve());
	const failed = scheduler.revalidate([a]).catch((error: unknown) => error);
	await entered.promise;
	void scheduler.invalidate([], () => true);
	held.resolve();
	expect(await failed).toBe(failure);
	await applied.promise;
	await scheduler.revalidate([]);
	expect(reads).toEqual(["a", "a"]);
	expect(onError).not.toHaveBeenCalled();
});

test("legacy async checks share the round guard and awaitable completion", async () => {
	const entered = gate<void>();
	const held = gate<void>();
	const effects = mock(() => {});
	const read = mock(async () => live);
	const { scheduler, withoutSession } = setup(read);
	const a = socket("");
	withoutSession.mockImplementationOnce(async (_ws, isCurrent) => {
		entered.resolve();
		await held.promise;
		if (isCurrent()) effects();
	});
	const first = scheduler.revalidate([a]);
	await entered.promise;
	scheduler.stop();
	held.resolve();
	await first;
	expect(effects).not.toHaveBeenCalled();
	expect(read).not.toHaveBeenCalled();
});

test("forget drops an explicit target before its late result and auth event", async () => {
	const held = gate<Result>();
	const read = mock(() => held.promise);
	const { scheduler, apply } = setup(read);
	const a = socket();
	const run = scheduler.revalidate([a]);
	scheduler.forget(a);
	void scheduler.invalidate([], () => true);
	held.resolve(null);
	await run;
	expect(apply).not.toHaveBeenCalled();
	expect(read).toHaveBeenCalledTimes(1);
});
