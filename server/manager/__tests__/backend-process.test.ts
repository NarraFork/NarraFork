import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { HANDOFF_COMPLETE_MESSAGE } from "../../lib/restart-handoff";
import { BackendProcess, type BackendState, SLOW_START_HINT_MS } from "../backend-process";
import { t } from "../manager-i18n";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flush() {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function output() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(next) {
			controller = next;
		},
	});
	return {
		stream,
		write(text: string) {
			controller.enqueue(new TextEncoder().encode(text));
		},
		close() {
			controller.close();
		},
	};
}

function fakeChild(pid: number, autoExit = true) {
	const exited = deferred<number>();
	const stdout = output();
	const stderr = output();
	const kill = mock(() => {
		if (autoExit) exited.resolve(0);
	});
	const child = {
		pid,
		stdout: stdout.stream,
		stderr: stderr.stream,
		exited: exited.promise,
		kill,
	} as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
	return { child, exited, stdout, stderr, kill };
}

/** 只推进真正注册的等待，不缩减生产预算，也不触发真实服务或进程信号。 */
function fakeClock() {
	let now = 1_000_000;
	let nextId = 0;
	const timers = new Map<number, { due: number; callback: () => void }>();
	spyOn(Date, "now").mockImplementation(() => now);
	spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms = 0) => {
		const id = ++nextId;
		timers.set(id, { due: now + ms, callback });
		return id;
	}) as unknown as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timers.delete(Number(id));
	}) as typeof clearTimeout);
	return {
		get pending() {
			return timers.size;
		},
		async advance(ms: number) {
			const end = now + ms;
			await flush();
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
				if (!next || next[1].due > end) break;
				now = next[1].due;
				timers.delete(next[0]);
				next[1].callback();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}

const ADDRESS = "running on http://127.0.0.1:7780\n";
const LOCK = "Another NarraFork process (pid 12345) is already using this data directory\n";

describe("BackendProcess lifecycle ownership", () => {
	let clock: ReturnType<typeof fakeClock>;
	let backend: BackendProcess;
	let states: Array<{ state: BackendState; detail?: string }>;
	let lines: string[];
	let children: ReturnType<typeof fakeChild>[];
	let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>;

	beforeEach(() => {
		clock = fakeClock();
		states = [];
		lines = [];
		children = [];
		backend = new BackendProcess({
			host: "127.0.0.1",
			port: 7779,
			tls: false,
			managerToken: "test-manager-token",
			onLine: (line) => lines.push(line),
			onState: (state, detail) => states.push({ state, detail }),
		});
		spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child spawn");
			return next.child;
		});
		// 纵使测试在 Windows 运行也不得真的调用 taskkill 或给真实 PID 发信号。
		spyOn(Bun, "spawnSync").mockImplementation(() => {
			return {} as ReturnType<typeof Bun.spawnSync>;
		});
		spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("No such process"), { code: "ESRCH" });
		});
	});

	afterEach(async () => {
		backend.dispose();
		await flush();
		mock.restore();
	});

	async function beginProbe(autoExit = true) {
		const child = fakeChild(101, autoExit);
		children.push(child);
		child.stdout.write(ADDRESS);
		const health = deferred<boolean>();
		const probe = spyOn(backend, "checkHealth").mockReturnValue(health.promise);
		const started = backend.start();
		await clock.advance(700);
		expect(probe).toHaveBeenCalledTimes(1);
		return { child, health, probe, started };
	}

	for (const healthy of [true, false]) {
		test(`late health=${healthy} cannot override an in-flight stop`, async () => {
			const { child, health, probe, started } = await beginProbe(false);
			const stopped = backend.stop();
			expect(backend.current).toBe("stopping");
			expect(probe.mock.calls[0]?.[0]?.aborted).toBe(true);
			health.resolve(healthy);
			await started;
			await clock.advance(2_100);
			expect(backend.current).toBe("stopping");
			expect(probe).toHaveBeenCalledTimes(1);
			expect(states.some(({ state }) => state === "running")).toBe(false);
			child.exited.resolve(0);
			await stopped;
			expect(backend.current).toBe("stopped");
		});
	}

	test("stop aborts the actual pending health request", async () => {
		const child = fakeChild(101);
		children.push(child);
		child.stdout.write(ADDRESS);
		const signals: AbortSignal[] = [];
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				(_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						if (!signal) throw new Error("Health request did not provide a signal");
						signals.push(signal);
						signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
					}),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const started = backend.start();
		await clock.advance(700);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(signals[0]?.aborted).toBe(false);
		await backend.stop();
		await started;
		expect(signals[0]?.aborted).toBe(true);
		expect(backend.current).toBe("stopped");
	});

	test("late health cannot resurrect a child that exited", async () => {
		const { child, health, started } = await beginProbe();
		child.exited.resolve(3);
		await flush();
		expect(backend.current).toBe("stopped");
		expect(states.at(-1)?.detail).toBe(t("error.exitedWithCode", { code: 3 }));
		health.resolve(true);
		await started;
		expect(backend.current).toBe("stopped");
		expect(backend.pid).toBeUndefined();
	});

	test("dispose silences late health and child exit callbacks", async () => {
		const { child, health, started } = await beginProbe();
		backend.dispose();
		const count = states.length;
		health.resolve(true);
		await started;
		await backend.start();
		expect(states).toHaveLength(count);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(backend.pid).toBeUndefined();
	});

	test("restart's new child is not marked ready by the old probe", async () => {
		const { child, health, started } = await beginProbe(false);
		const replacement = fakeChild(102);
		replacement.stdout.write("running on https://new.example:8890\n");
		children.push(replacement);
		const nextHealth = deferred<boolean>();
		const probe = spyOn(backend, "checkHealth").mockReturnValue(nextHealth.promise);
		const restarted = backend.restart();
		child.exited.resolve(0);
		await clock.advance(700);
		expect(backend.pid).toBe(102);
		expect(backend.current).toBe("starting");
		expect(probe).toHaveBeenCalledTimes(2);
		health.resolve(true);
		await started;
		expect(backend.current).toBe("starting");
		expect(backend.listeningHost).toBe("new.example");
		expect(backend.listeningPort).toBe(8890);
		expect(backend.listeningTls).toBe(true);
		nextHealth.resolve(true);
		await restarted;
		expect(backend.current).toBe("running");
		expect(clock.pending).toBe(0);
	});

	test("a later stop cancels restart's pending relaunch", async () => {
		const { child, health, started } = await beginProbe(false);
		const restarted = backend.restart();
		const stopped = backend.stop();
		child.exited.resolve(0);
		health.resolve(true);
		await Promise.all([started, restarted, stopped]);
		expect(backend.current).toBe("stopped");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(clock.pending).toBe(0);
	});

	test("graceful stop waits its budget and concurrent calls share one child shutdown", async () => {
		const { child, health, started } = await beginProbe(false);
		const stopped = backend.stop({ graceful: true });
		expect(backend.stop()).toBe(stopped);
		await backend.start();
		await clock.advance(14_999);
		expect(child.kill).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledTimes(1);
		await clock.advance(1);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(backend.current).toBe("stopping");
		child.exited.resolve(0);
		health.resolve(false);
		await Promise.all([started, stopped]);
		expect(backend.current).toBe("stopped");
		expect(clock.pending).toBe(0);
	});

	test("dispose during graceful stop emits no final stopped state or relaunch", async () => {
		const { child, health, started } = await beginProbe(false);
		const restarted = backend.restart();
		backend.dispose();
		const count = states.length;
		child.exited.resolve(0);
		health.resolve(true);
		await Promise.all([started, restarted]);
		expect(states).toHaveLength(count);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(clock.pending).toBe(0);
	});

	test("stop cancels the address wait without waiting for a timer or health", async () => {
		const child = fakeChild(101);
		children.push(child);
		const probe = spyOn(backend, "checkHealth");
		const started = backend.start();
		expect(clock.pending).toBe(1);
		await backend.stop();
		await started;
		expect(clock.pending).toBe(0);
		expect(probe).not.toHaveBeenCalled();
		expect(backend.current).toBe("stopped");
	});

	test("queued old stdout and stderr cannot change a fresh child's address or lock state", async () => {
		const { child, health, started } = await beginProbe();
		// read() 已完成，但 continuation 尚未执行：这是取消 reader 仍需归属检查的窗口。
		child.stdout.write("running on https://old.example:9999\nold queued log\n");
		child.stderr.write(LOCK);
		const stopped = backend.stop();
		health.resolve(true);
		await Promise.all([started, stopped]);
		const next = fakeChild(102);
		children.push(next);
		next.stdout.write(ADDRESS);
		spyOn(backend, "checkHealth").mockResolvedValue(true);
		const restarted = backend.start();
		await clock.advance(700);
		await restarted;
		expect(backend.current).toBe("running");
		expect(backend.listeningHost).toBe("127.0.0.1");
		expect(backend.listeningPort).toBe(7780);
		expect(backend.listeningTls).toBe(false);
		expect(lines.some((line) => line.includes("old queued log"))).toBe(false);
		expect(lines.some((line) => line.includes("pid 12345"))).toBe(false);
	});

	test("stop while a conflicting child exits cancels lock retry and its logs", async () => {
		const child = fakeChild(101, false);
		children.push(child);
		child.stderr.write(LOCK);
		const started = backend.start();
		await clock.advance(700);
		const stopped = backend.stop();
		child.exited.resolve(1);
		await Promise.all([started, stopped]);
		expect(backend.current).toBe("stopped");
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(lines).not.toContain(t("log.waitingLockHolder", { pid: 12345 }));
	});

	test("stop during holder polling cannot revive an old round after another start", async () => {
		spyOn(process, "kill").mockReturnValue(true);
		const first = fakeChild(101);
		children.push(first);
		first.stderr.write(LOCK);
		const started = backend.start();
		first.exited.resolve(1);
		await clock.advance(700);
		expect(lines).toContain(t("log.waitingLockHolder", { pid: 12345 }));
		await backend.stop();
		const next = fakeChild(102);
		next.stdout.write(ADDRESS);
		children.push(next);
		spyOn(backend, "checkHealth").mockResolvedValue(true);
		const restarted = backend.start();
		await clock.advance(700);
		await Promise.all([started, restarted]);
		expect(backend.current).toBe("running");
		expect(backend.pid).toBe(102);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(states.some(({ state }) => state === "error")).toBe(false);
	});

	test("lock retry retains handoff env and ignores the previous child's late logs", async () => {
		const first = fakeChild(101);
		const second = fakeChild(102);
		children.push(first, second);
		first.stderr.write(LOCK);
		const probe = spyOn(backend, "checkHealth").mockResolvedValue(true);
		const handoffEnv = { NARRAFORK_TEST_HANDOFF: "retained" };
		const started = backend.start({ handoffEnv });
		await flush();
		first.exited.resolve(1);
		await clock.advance(700);
		expect(backend.pid).toBe(102);
		first.stdout.write(`${HANDOFF_COMPLETE_MESSAGE}\nrunning on https://old.example:9999\n`);
		first.stderr.write(LOCK);
		await clock.advance(700);
		expect(probe).not.toHaveBeenCalled();
		expect(backend.listeningHost).toBe("127.0.0.1");
		expect(backend.listeningPort).toBe(7779);
		second.stdout.write(`${HANDOFF_COMPLETE_MESSAGE}\n${ADDRESS}`);
		await clock.advance(700);
		await started;
		expect(backend.current).toBe("running");
		expect(backend.listeningPort).toBe(7780);
		expect(spawn).toHaveBeenCalledTimes(2);
		for (const call of spawn.mock.calls) {
			expect(call[1]?.env).toMatchObject(handoffEnv);
		}
		expect(lines.some((line) => line.includes("old.example"))).toBe(false);
	});

	test("a lock reported during health probing takes precedence over a late success", async () => {
		const { child, health, started } = await beginProbe();
		const replacement = fakeChild(102);
		children.push(replacement);
		child.stderr.write(LOCK);
		await flush();
		child.exited.resolve(1);
		health.resolve(true);
		await flush();
		expect(backend.current).toBe("starting");
		expect(backend.pid).toBe(102);
		expect(states.some(({ state }) => state === "running")).toBe(false);
		replacement.stdout.write(ADDRESS);
		await clock.advance(700);
		await started;
		expect(backend.current).toBe("running");
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	test("a live lock holder gets a bounded wait rather than an unbounded retry", async () => {
		spyOn(process, "kill").mockReturnValue(true);
		const child = fakeChild(101);
		children.push(child);
		child.stderr.write(LOCK);
		const started = backend.start();
		await flush();
		child.exited.resolve(1);
		await clock.advance(61_600);
		await started;
		expect(backend.current).toBe("error");
		expect(states.at(-1)?.detail).toBe(t("error.instanceLockConflict", { pid: 12345 }));
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test("a second instance-lock conflict fails once rather than starting a third child", async () => {
		const first = fakeChild(101);
		const second = fakeChild(102);
		children.push(first, second);
		first.stderr.write(LOCK);
		const started = backend.start();
		await flush();
		first.exited.resolve(1);
		await clock.advance(700);
		second.stderr.write(LOCK);
		await flush();
		second.exited.resolve(1);
		await clock.advance(700);
		await started;
		expect(backend.current).toBe("error");
		expect(states.at(-1)?.detail).toBe(t("error.instanceLockConflict", { pid: 12345 }));
		expect(backend.pid).toBeUndefined();
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	test("an alive child has no startup deadline and gets only one slow-start hint", async () => {
		const child = fakeChild(101);
		children.push(child);
		child.stdout.write(ADDRESS);
		const probe = spyOn(backend, "checkHealth").mockResolvedValue(false);
		const started = backend.start();
		await clock.advance(SLOW_START_HINT_MS + 1_000);
		expect(backend.current).toBe("starting");
		expect(lines.filter((line) => line === t("log.slowStart"))).toHaveLength(1);
		await clock.advance(SLOW_START_HINT_MS * 2);
		expect(backend.current).toBe("starting");
		expect(child.kill).not.toHaveBeenCalled();
		expect(lines.filter((line) => line === t("log.slowStart"))).toHaveLength(1);
		probe.mockResolvedValue(true);
		await clock.advance(700);
		await started;
		expect(backend.current).toBe("running");
	});

	test("missing listener output falls back to the configured target after the address budget", async () => {
		children.push(fakeChild(101));
		const probe = spyOn(backend, "checkHealth").mockResolvedValue(true);
		const started = backend.start();
		await clock.advance(14_700);
		expect(probe).not.toHaveBeenCalled();
		await clock.advance(700);
		await started;
		expect(probe).toHaveBeenCalledTimes(1);
		expect(backend.listeningPort).toBe(7779);
		expect(backend.current).toBe("running");
	});
});
