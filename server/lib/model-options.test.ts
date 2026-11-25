import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectedWorker } from "./compiled-worker";
import { connectCompiledWorker } from "./compiled-worker";
import type { ModelOptionsSnapshot } from "./model-options";
import {
	captureModelOptionsArray,
	type ModelOptionInput,
	ModelOptionsError,
} from "./model-options-contract";
import { WorkerHandle } from "./worker-runtime/lifecycle";

const home = mkdtempSync(join(tmpdir(), "nf-options-test-"));
const previousHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { ModelOptionsClient, captureModelOptionsSnapshot } = await import("./model-options");
const { decodeBundledCatalog } = await import("./model-catalog/source");
const { CodexManager, __setCodexManagerForTests } = await import("./codex-manager");
const clients: InstanceType<typeof ModelOptionsClient>[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});
const query = { q: "", scope: "concrete" as const, limit: 40 };
const rows = (count: number): ModelOptionInput[] =>
	Array.from({ length: count }, (_, i) => ({
		value: `test:model-${i.toString().padStart(5, "0")}`,
		label: `Model ${i.toString().padStart(5, "0")}`,
		provider: "test",
		upstreamModelId: `model-${i}`,
	}));
function snapshot(input: ModelOptionInput[], revision = "r1"): ModelOptionsSnapshot {
	return {
		revision,
		catalog: {
			version: decodeBundledCatalog().catalogVersion,
			source: "builtin" as const,
			path: "unused",
		},
		captures: [captureModelOptionsArray(input, (row) => row)],
		hidden: [],
		excluded: [],
		codex: false,
	};
}
function fakeConnection(
	behavior: (message: Record<string, unknown>, worker: EventEmitter) => void,
) {
	const posted: Record<string, unknown>[] = [];
	let stopped = 0;
	let finish!: (code: number) => void;
	const worker = Object.assign(new EventEmitter(), {
		unref() {},
		postMessage(message: Record<string, unknown>) {
			posted.push(message);
			queueMicrotask(() => behavior(message, worker));
		},
	});
	const handle = new WorkerHandle(
		worker,
		new Promise<number>((resolve) => {
			finish = resolve;
		}),
		() => {
			stopped++;
			finish(0);
			worker.emit("exit", 0);
		},
	);
	return {
		connection: { worker, handle, specifier: "fixture" } as unknown as ConnectedWorker,
		posted,
		stopped: () => stopped,
	};
}
function client(
	capture = () => snapshot(rows(1)),
	connect = connectCompiledWorker,
	budgets?: { buildMs?: number; queryMs?: number; coldMs?: number },
) {
	const instance = new ModelOptionsClient({ capture, connect, budgets });
	clients.push(instance);
	return instance;
}

test("no startup/capture before actual demand; real worker builds 10k rows once and returns bounded pages", async () => {
	let captures = 0;
	let connects = 0;
	const data = snapshot(rows(10_000));
	const instance = client(
		() => {
			captures++;
			return data;
		},
		async (...args) => {
			connects++;
			return connectCompiledWorker(...args);
		},
	);
	expect(captures).toBe(0);
	expect(connects).toBe(0);
	const first = await instance.query(query);
	expect(first.items).toHaveLength(40);
	expect(first.hasMore).toBe(true);
	const next = await instance.query({ ...query, cursor: first.nextCursor ?? undefined });
	expect(next.items[0]?.value).not.toBe(first.items[0]?.value);
	const searched = await instance.query({ ...query, q: "09999" });
	expect(searched.items).toHaveLength(1);
	expect(connects).toBe(1);
	expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1024);
}, 20_000);

test("production cache captures are stable and Codex catalog variants load inside the real Worker", async () => {
	const managerHome = join(home, "production-codex-fixture");
	const directory = join(managerHome, ".narrafork");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "codex-credentials.json"),
		JSON.stringify([
			{
				id: "production-codex",
				refreshToken: "fixture-refresh",
				accessToken: "fixture-access",
				accountId: "fixture-account",
				expiresAt: Date.now() + 60 * 60_000,
				priority: 0,
				disabled: false,
			},
		]),
	);
	__setCodexManagerForTests(
		new CodexManager({ homeDir: managerHome, registerProcessHooks: false }),
	);
	try {
		const before = captureModelOptionsSnapshot();
		const again = captureModelOptionsSnapshot();
		expect(before.revision).toBe(again.revision);
		const instance = client(captureModelOptionsSnapshot);
		const page = await instance.query({ ...query, limit: 100 });
		expect(page.items.some((row) => row.provider === "codex")).toBe(true);
		const auto = await instance.query({ ...query, scope: "auto", limit: 1 });
		expect(auto.items[0]?.sourceCount).toBeGreaterThan(0);
		const sources = await instance.query({
			...query,
			sourceModelId: auto.items[0]?.modelId,
			limit: 1,
		});
		expect(sources.items[0]?.provider).toBe("codex");
		expect(sources.items[0]).not.toHaveProperty("credentialLabel");
		expect(sources.items[0]).toHaveProperty("subscription", true);
		const value = sources.items[0]?.value;
		if (!value) throw new Error("Missing source fixture");
		const catalogModule = await import("./model-catalog");
		const restore = catalogModule.replaceModelOverridesForTests({
			connections: { [value]: { prices: { input: "3", output: "4" } } },
		});
		const card = spyOn(catalogModule, "getEffectiveModelCard");
		const profile = spyOn(catalogModule, "getEffectiveModelProfile");
		try {
			const repriced = await instance.query({
				...query,
				sourceModelId: auto.items[0]?.modelId,
				limit: 1,
			});
			expect(repriced.items[0]?.referencePrice).toBe(7);
			expect(card).not.toHaveBeenCalled();
			expect(profile).not.toHaveBeenCalled();
		} finally {
			card.mockRestore();
			profile.mockRestore();
			restore();
		}
	} finally {
		__setCodexManagerForTests(undefined);
	}
});

test("ACK backpressure batches <=128 rows/64KiB and source drift rejects publication", async () => {
	let revision = "r1";
	const fixture = fakeConnection((message, worker) => {
		if (message.type === "batch") {
			expect((message.rows as unknown[]).length).toBeLessThanOrEqual(128);
			expect(Buffer.byteLength(JSON.stringify(message.rows))).toBeLessThanOrEqual(64 * 1024);
			revision = "r2";
		}
		worker.emit("message", { id: message.id, ok: true });
	});
	const instance = client(
		() => snapshot(rows(200), revision),
		async () => fixture.connection,
	);
	await expect(instance.query(query)).rejects.toThrow("changed during build");
	expect(fixture.posted.some((message) => message.type === "publish")).toBe(false);
	expect(fixture.stopped()).toBe(1);
});

test("creation failure/disabled worker has no inline computation", async () => {
	let slices = 0;
	const data = snapshot(rows(1));
	const capture = data.captures[0];
	if (!capture) throw new Error("Missing fixture capture");
	capture.readSlice = () => {
		slices++;
		throw new Error("must not run");
	};
	const instance = client(
		() => data,
		async () => {
			throw new Error("disabled");
		},
	);
	await expect(instance.query(query)).rejects.toThrow("worker is unavailable");
	expect(slices).toBe(0);
});

test("crash fails explicitly and terminates instead of local fallback", async () => {
	const fixture = fakeConnection((_message, worker) => worker.emit("error", new Error("crash")));
	const instance = client(
		() => snapshot(rows(2)),
		async () => fixture.connection,
	);
	await expect(instance.query(query)).rejects.toThrow("worker is unavailable");
	expect(fixture.stopped()).toBe(1);
});

test("build deadline terminates unresponsive worker", async () => {
	const fixture = fakeConnection(() => {});
	const instance = client(
		() => snapshot(rows(1)),
		async () => fixture.connection,
		{ buildMs: 15 },
	);
	await expect(instance.query(query)).rejects.toThrow("deadline exceeded");
	expect(fixture.stopped()).toBe(1);
});

test("query deadline and abort terminate dedicated worker, never return empty success", async () => {
	const fixture = fakeConnection((message, worker) => {
		if (message.type !== "query") worker.emit("message", { id: message.id, ok: true });
	});
	const instance = client(
		() => snapshot(rows(1)),
		async () => fixture.connection,
		{ queryMs: 15 },
	);
	await expect(instance.query(query)).rejects.toThrow("deadline exceeded");
	expect(fixture.stopped()).toBe(1);
	const aborted = fakeConnection(() => {});
	const second = client(
		() => snapshot(rows(1)),
		async () => aborted.connection,
	);
	const controller = new AbortController();
	const pending = second.query(query, controller.signal);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
});

test("queue <=8 and cold deadline includes queue wait", async () => {
	const fixture = fakeConnection(() => {});
	const instance = client(
		() => snapshot(rows(1)),
		async () => fixture.connection,
		{ coldMs: 20 },
	);
	const requests = Array.from({ length: 8 }, () =>
		instance.query(query).then(
			() => false,
			() => true,
		),
	);
	await expect(instance.query(query)).rejects.toThrow("queue is full");
	expect(await Promise.all(requests)).toEqual(Array(8).fill(true));
});

test("main capture enforces 20k rows, per-field and total 8MiB input; no publish on excess", async () => {
	const data = snapshot(rows(20_001));
	const instance = client(() => {
		if ((data.captures[0]?.count ?? 0) > 20_000)
			throw new ModelOptionsError("MODEL_OPTIONS_INPUT_LIMIT", "Too many model options");
		return data;
	});
	await expect(instance.query(query)).rejects.toThrow("Too many model options");
	const fixture = fakeConnection((message, worker) =>
		worker.emit("message", { id: message.id, ok: true }),
	);
	const hugeRows = rows(9000).map((row) => ({ ...row, label: "x".repeat(1000) }));
	const huge = client(
		() => snapshot(hugeRows),
		async () => fixture.connection,
	);
	await expect(huge.query(query)).rejects.toThrow("input exceeds budget");
	expect(fixture.posted.some((message) => message.type === "publish")).toBe(false);
	const aggregationFixture = fakeConnection((message, worker) =>
		worker.emit("message", { id: message.id, ok: true }),
	);
	const malformed = client(
		() =>
			snapshot([
				{
					value: "__agg__:large",
					label: "Large",
					provider: "__agg__",
					upstreamModelId: "large",
					aggregationMembers: Array(21).fill("provider:member"),
				},
			]),
		async () => aggregationFixture.connection,
	);
	await expect(malformed.query(query)).rejects.toThrow("Aggregation members exceed budget");
	expect(aggregationFixture.posted.some((message) => message.type === "batch")).toBe(false);
	expect(aggregationFixture.posted.some((message) => message.type === "publish")).toBe(false);
});
