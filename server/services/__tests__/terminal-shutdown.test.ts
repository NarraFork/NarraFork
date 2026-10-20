import { afterAll, expect, mock, test } from "bun:test";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
let dtach = false;
let exit = deferred<number>();
let dispose = () => Promise.resolve();
let socketAlive = () => Promise.resolve(false);
let persist = () => Promise.resolve();
const runtime = {
	exited: exit.promise,
	close: mock(() => {}),
	kill: mock(() => exit.resolve(0)),
	write() {},
	resize() {},
};
const writes: unknown[] = [];
mock.module("../../db", () => ({
	db: {
		insert: () => ({ values: (row: unknown) => ({ returning: async () => [row] }) }),
		update: () => ({
			set: (row: unknown) => ({
				where: async () => {
					writes.push(row);
					await persist();
				},
			}),
		}),
		query: {
			terminals: { findFirst: () => Promise.resolve({ narratorId: null, chapterId: null }) },
		},
	},
}));
mock.module("../../db/worker-read", () => ({ readQuery: (query: unknown) => query }));
mock.module("../../lib/agent/shell", () => ({ detectShell: () => ({ path: "/mock/sh" }) }));
mock.module("../../lib/agent/tools/terminal", () => ({ resetCursorForTerminal() {} }));
mock.module("../../lib/event-bus", () => ({ eventBus: { emit() {} } }));
mock.module("../../terminal/buffer-manager", () => ({
	BufferManager: class {
		startPeriodicFlush() {}
		stopPeriodicFlush() {}
		saveToDisk() {
			return Promise.resolve();
		}
		dispose() {
			return dispose();
		}
	},
}));
mock.module("../../terminal/dtach-service", () => ({
	dtachService: {
		isAvailable: async () => dtach,
		createSession: async () => {},
		getSocketPath: () => "/mock/socket",
		attachSession: () => runtime,
		isSocketAlive: () => socketAlive(),
	},
	findProcessesByArg() {},
	getDescendantPids() {},
	ProcessSnapshot: class {},
}));
mock.module("../../terminal/runtime-bun", () => ({ spawnBunTerminal: () => runtime }));
mock.module("../../terminal/runtime-pty", () => ({ spawnPortablePty: () => runtime }));
mock.module("../../terminal/runtime-remote", () => ({
	REMOTE_PTY_READY_FEATURE: "mock",
	spawnRemotePty() {},
}));
mock.module("../../websocket/terminal-ws", () => ({ sendToTerminal() {} }));
mock.module("../device-connection-service", () => ({
	getConnectedDeviceHello() {},
	isDeviceOnline() {},
}));
mock.module("../device-service", () => ({
	DeviceScopeError: Error,
	deviceHasFeature() {},
	requireAuthorizedDeviceForProject() {},
}));
mock.module("../worktree-resource-owner", () => ({ assertLegacyRuntimeOwner() {} }));
const { terminalService: service } = await import("../terminal-service");
afterAll(() => mock.restore());

async function create(useDtach = false) {
	dtach = useDtach;
	exit = deferred<number>();
	runtime.exited = exit.promise;
	dispose = () => Promise.resolve();
	socketAlive = () => Promise.resolve(false);
	runtime.close.mockClear();
	runtime.kill.mockClear();
	return service.create({});
}

test("shutdown waits for an exit observer already inside buffer disposal", async () => {
	await create();
	const entered = deferred<void>();
	const held = deferred<void>();
	let calls = 0;
	dispose = () => {
		if (++calls === 1) {
			entered.resolve();
			return held.promise;
		}
		return Promise.resolve();
	};
	exit.resolve(0);
	await entered.promise;
	let done = false;
	const shutdown = service.shutdownAll().then(() => {
		done = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const premature = done;
	held.resolve();
	await shutdown;
	expect(premature).toBe(false);
});

test("shutdown waits for the observer triggered by killing a direct terminal", async () => {
	await create();
	const held = deferred<void>();
	const entered = deferred<void>();
	let calls = 0;
	dispose = () => {
		if (++calls === 2) {
			entered.resolve();
			return held.promise;
		}
		return Promise.resolve();
	};
	let done = false;
	const shutdown = service.shutdownAll().then(() => {
		done = true;
	});
	await entered.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(done).toBe(false);
	held.resolve();
	await shutdown;
	expect(runtime.kill).toHaveBeenCalledTimes(1);
});

test("dtach monitor is drained while the detached shell is preserved", async () => {
	await create(true);
	const held = deferred<boolean>();
	const entered = deferred<void>();
	socketAlive = () => {
		entered.resolve();
		return held.promise;
	};
	exit.resolve(0);
	await entered.promise;
	let done = false;
	const shutdown = service.shutdownAll().then(() => {
		done = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(done).toBe(false);
	held.resolve(true);
	await shutdown;
	expect(runtime.kill).not.toHaveBeenCalled();
});

test("dormant dtach observer cannot write after shutdown unregisters the terminal", async () => {
	await create(true);
	await service.shutdownAll();
	const count = writes.length;
	exit.resolve(0);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(writes).toHaveLength(count);
	expect(runtime.kill).not.toHaveBeenCalled();
});

test("cancelled drain retains the running observer for a subsequent drain", async () => {
	await create();
	const held = deferred<void>();
	const entered = deferred<void>();
	let calls = 0;
	dispose = () => {
		if (++calls === 1) {
			entered.resolve();
			return held.promise;
		}
		return Promise.resolve();
	};
	exit.resolve(0);
	await entered.promise;
	const controller = new AbortController();
	const shutdown = service.shutdownAll(controller.signal);
	controller.abort(new Error("fixture deadline"));
	await expect(shutdown).rejects.toThrow("fixture deadline");
	let done = false;
	const retry = service.shutdownAll().then(() => {
		done = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(done).toBe(false);
	held.resolve();
	await retry;
});

test("observer remains owned after unregistering its active terminal until persistence finishes", async () => {
	await create();
	const held = deferred<void>();
	const entered = deferred<void>();
	persist = () => {
		entered.resolve();
		return held.promise;
	};
	exit.resolve(0);
	await entered.promise;
	let done = false;
	const shutdown = service.shutdownAll().then(() => {
		done = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(done).toBe(false);
	held.resolve();
	await shutdown;
	persist = () => Promise.resolve();
	expect(runtime.kill).not.toHaveBeenCalled();
	// The settled observer has unregistered: another drain completes without work.
	await service.shutdownAll();
});

test("observer persistence failure makes shutdown tracker unclean", async () => {
	const { ShutdownActivityTracker, shutdownStep } = await import("../../lib/shutdown-activity");
	await create();
	const held = deferred<void>();
	const entered = deferred<void>();
	persist = () => {
		entered.resolve();
		return held.promise;
	};
	exit.resolve(0);
	await entered.promise;
	const tracker = new ShutdownActivityTracker();
	tracker.markDrainComplete();
	const shutdown = shutdownStep(tracker, "terminalService.shutdownAll", (signal) =>
		service.shutdownAll(signal),
	);
	held.reject(new Error("fixture observer failure"));
	expect(await shutdown).toBe("failed");
	expect(tracker.isCleanShutdown()).toBe(false);
});
