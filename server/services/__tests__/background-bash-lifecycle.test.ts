import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BackgroundBashLifecycle } from "../background-bash-lifecycle";

test("collector ownership includes exit, terminal publication and cleanup", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const exit = Promise.withResolvers<void>();
	const publishing = Promise.withResolvers<void>();
	const published = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const cleaning = Promise.withResolvers<void>();
	const work = lifecycle.trackCollector(
		"bash-fixture",
		(async () => {
			await exit.promise;
			publishing.resolve();
			await lifecycle.trackTerminal(published.promise);
			cleaning.resolve();
			await cleanup.promise;
		})(),
	);
	lifecycle.stop();
	let drained = false;
	const drain = lifecycle.drain().then(() => {
		drained = true;
	});
	try {
		expect(lifecycle.getSnapshot()).toMatchObject({ stopped: true, pending: 1 });
		exit.resolve();
		await publishing.promise;
		expect(drained).toBe(false);
		published.resolve();
		await cleaning.promise;
		expect(drained).toBe(false);
		cleanup.resolve();
		await drain;
		expect(lifecycle.getSnapshot()).toMatchObject({ collectors: 0, terminals: 0, pending: 0 });
	} finally {
		exit.resolve();
		published.resolve();
		cleanup.resolve();
		await Promise.allSettled([work, drain]);
	}
});

test("settled rejections remain bounded audit failures before a later drain", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const work = lifecycle.trackCollector(
		"bash-failure",
		Promise.reject(new Error("terminal failed")),
	);
	await work.catch(() => {});
	lifecycle.stop();
	expect(lifecycle.getSnapshot()).toMatchObject({ pending: 0, failed: 1 });
	await expect(lifecycle.drain()).rejects.toThrow("Background Bash lifecycle failed");
});

test("expired drains keep ownership and observe a later rejection", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const gate = Promise.withResolvers<void>();
	const work = lifecycle.trackCollector("bash-late-failure", gate.promise);
	lifecycle.stop();
	await expect(lifecycle.drain({ deadlineAt: Date.now() })).rejects.toThrow("did not drain");
	expect(lifecycle.getSnapshot()).toMatchObject({ pending: 1, failed: 0 });
	gate.reject(new Error("late persistence failure"));
	await work.catch(() => {});
	expect(lifecycle.getSnapshot()).toMatchObject({ pending: 0, failed: 1 });
	await expect(lifecycle.drain()).rejects.toThrow("lifecycle failed");
});

test("preserve freezes new database tails while draining admitted startup and terminal work", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const startup = Promise.withResolvers<void>();
	const terminal = Promise.withResolvers<void>();
	const exit = Promise.withResolvers<void>();
	let lateWrites = 0;
	lifecycle.trackTerminal(startup.promise);
	lifecycle.trackTerminal(terminal.promise);
	const collector = lifecycle.trackCollector(
		"bash-preserved",
		exit.promise.then(() => {
			if (lifecycle.canStartTerminal("bash-preserved")) lateWrites++;
		}),
	);
	lifecycle.stop({ preserveProcesses: true });
	let drained = false;
	const drain = lifecycle.drain().then(() => {
		drained = true;
	});
	try {
		expect(() => lifecycle.assertAdmission()).toThrow("admission is stopped");
		expect(lifecycle.canStartTerminal("bash-preserved")).toBe(false);
		expect(lifecycle.getSnapshot()).toMatchObject({ collectors: 1, terminals: 2, pending: 2 });
		startup.resolve();
		await startup.promise;
		expect(drained).toBe(false);
		terminal.resolve();
		await drain;
		expect(lifecycle.getSnapshot()).toMatchObject({ collectors: 1, pending: 0 });
		exit.resolve();
		await collector;
		expect(lateWrites).toBe(0);
	} finally {
		startup.resolve();
		terminal.resolve();
		exit.resolve();
		await Promise.allSettled([collector, drain]);
	}
});

test("preserve drains a dispatched startup without waiting for the process exit", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const started = Promise.withResolvers<void>();
	const exit = Promise.withResolvers<void>();
	lifecycle.trackTerminal(started.promise);
	const collector = lifecycle.trackCollector(
		"bash-starting",
		started.promise.then(async () => {
			lifecycle.markCollectorStarted("bash-starting");
			await exit.promise;
		}),
		false,
	);
	lifecycle.stop({ preserveProcesses: true });
	const drain = lifecycle.drain();
	try {
		expect(lifecycle.getSnapshot().pending).toBe(2);
		started.resolve();
		await drain;
		expect(lifecycle.getSnapshot()).toMatchObject({ collectors: 1, pending: 0 });
		expect(lifecycle.canStartTerminal("bash-starting")).toBe(false);
	} finally {
		started.resolve();
		exit.resolve();
		await Promise.allSettled([collector, drain]);
	}
});

test.each([
	false,
	true,
])("stopped output callbacks stay frozen after collector removal, broadcastPending=%s", async (broadcastPending) => {
	// Execute the production output callback without importing the database-backed singleton.
	const source = readFileSync(new URL("../background-task-service.ts", import.meta.url), "utf8");
	const start = source.indexOf("\tappendOutput(");
	const end = source.indexOf("\n\tgetOutputBuffer(", start);
	if (start < 0 || end < start) throw new Error("Cannot locate production Bash output callback");
	const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
		`const service = { ${source.slice(start, end)} };`,
	);
	let timer: (() => void) | undefined;
	const append = new Function(
		"MAX_MEMORY_OUTPUT_BYTES",
		"eventBus",
		"setTimeout",
		`${compiled}\nreturn service.appendOutput;`,
	)(1024, { emit() {} }, (callback: () => void) => {
		timer = callback;
		return 1;
	}) as (this: unknown, id: string, chunk: string) => void;
	const lifecycle = new BackgroundBashLifecycle();
	const exit = Promise.withResolvers<void>();
	const collector = lifecycle.trackCollector("bash-output", exit.promise);
	const broadcast = Promise.withResolvers<(id: string) => void>();
	const delivered: string[] = [];
	const service = {
		bashLifecycle: lifecycle,
		outputByteCounts: new Map(),
		outputChunks: new Map(),
		parentNarratorCache: new Map([["bash-output", "parent"]]),
		outputBroadcastTimers: new Map(),
		getBroadcastFn: () => broadcast.promise,
	};
	append.call(service, "bash-output", "chunk");
	expect(timer).toBeDefined();
	if (broadcastPending) timer?.();
	lifecycle.stop({ preserveProcesses: true });
	exit.resolve();
	await collector;
	expect(lifecycle.getSnapshot().collectors).toBe(0);
	if (!broadcastPending) timer?.();
	broadcast.resolve((id) => delivered.push(id));
	await broadcast.promise;
	expect(delivered).toEqual([]);
});

test("only the same cancellation owner joins the full terminal operation", async () => {
	const lifecycle = new BackgroundBashLifecycle();
	const gate = Promise.withResolvers<boolean>();
	const owner = new AbortController();
	let writes = 0;
	const start = () => {
		writes++;
		return gate.promise;
	};
	const first = lifecycle.runCancellation("bash-cancel", owner, start);
	const duplicate = lifecycle.runCancellation("bash-cancel", owner, start);
	expect(writes).toBe(1);
	const replacement = lifecycle.runCancellation("bash-cancel", new AbortController(), start);
	expect(writes).toBe(2);
	gate.resolve(true);
	expect(await first).toBe(true);
	expect(await duplicate).toBe(false);
	expect(await replacement).toBe(true);
	await lifecycle.drain();
	expect(lifecycle.getSnapshot().pending).toBe(0);
});
