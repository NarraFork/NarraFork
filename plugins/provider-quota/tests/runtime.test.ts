import { expect, test } from "bun:test";
import { join } from "node:path";
import { ContentLengthDecoder, encodeFrame } from "../src/framing";
import { FEATURES, PLUGIN_ID, record } from "../src/protocol";

test("framing is incremental, supports coalesced Unicode frames and rejects invalid size headers", () => {
	const received: unknown[] = [];
	const parser = new ContentLengthDecoder((value) => received.push(value));
	const first = encodeFrame({ text: "中文 quota" });
	for (const byte of first) parser.feed(Uint8Array.of(byte));
	parser.feed(encodeFrame({ id: 2 }));
	parser.finish();
	expect(received).toEqual([{ text: "中文 quota" }, { id: 2 }]);
	for (const header of [
		"Content-Length: 0\r\n\r\n",
		"Content-Length: 999999999\r\n\r\n",
		"Content-Length: 1\r\nContent-Length: 1\r\n\r\n",
		"Content-Length: -1\r\n\r\n",
	])
		expect(() =>
			new ContentLengthDecoder(() => {}).feed(new TextEncoder().encode(header)),
		).toThrow();
});
test("framing caps partial headers, incomplete bodies and UTF-8 output bytes", () => {
	expect(() => new ContentLengthDecoder(() => {}).feed(new Uint8Array(8196).fill(65))).toThrow();
	const parser = new ContentLengthDecoder(() => {});
	parser.feed(new TextEncoder().encode("Content-Length: 10\r\n\r\n{}"));
	expect(() => parser.finish()).toThrow();
	expect(() => encodeFrame({ text: "界".repeat(10) }, 24)).toThrow();
});

async function program() {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts")], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: join(import.meta.dir, ".."),
	});
	const messages: Array<Record<string, unknown>> = [];
	const waiters: Array<{
		predicate: (message: Record<string, unknown>) => boolean;
		resolve: (message: Record<string, unknown>) => void;
	}> = [];
	let closed = false;
	let bytes = 0;
	let stderrBytes = 0;
	const timer = setTimeout(() => child.kill(), 10_000);
	const reader = child.stdout.getReader();
	const errors = child.stderr.getReader();
	const send = (message: unknown) => {
		child.stdin.write(encodeFrame(message, 256 * 1024));
		child.stdin.flush();
	};
	const parser = new ContentLengthDecoder((value) => {
		if (!record(value)) throw new Error("Invalid test RPC message");
		const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(value));
		if (waiterIndex !== -1) {
			waiters.splice(waiterIndex, 1)[0]?.resolve(value);
			return;
		}
		if (messages.length >= 64) throw new Error("Test message budget exceeded");
		messages.push(value);
	});
	const pump = (async () => {
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) break;
				bytes += item.value.byteLength;
				if (bytes > 2 * 1024 * 1024) throw new Error("Test stdout budget exceeded");
				parser.feed(item.value);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	const stderr = (async () => {
		try {
			while (true) {
				const item = await errors.read();
				if (item.done) break;
				stderrBytes += item.value.byteLength;
				if (stderrBytes > 16 * 1024) throw new Error("Test stderr budget exceeded");
			}
		} finally {
			errors.releaseLock();
		}
	})();
	let serial = 0;
	const wait = (predicate: (message: Record<string, unknown>) => boolean) => {
		const index = messages.findIndex(predicate);
		if (index !== -1)
			return Promise.resolve(messages.splice(index, 1)[0] as Record<string, unknown>);
		return new Promise<Record<string, unknown>>((resolve) => waiters.push({ predicate, resolve }));
	};
	const request = (method: string, params: unknown = {}) => {
		const id = ++serial;
		const response = wait((message) => message.id === id);
		send({ jsonrpc: "2.0", id, method, params });
		return response;
	};
	async function close() {
		if (closed) return;
		closed = true;
		child.stdin.end();
		try {
			await child.exited;
			await Promise.all([pump, stderr]);
		} finally {
			clearTimeout(timer);
			child.kill();
		}
	}
	return { child, request, send, wait, close };
}
const queryParams = {
	protocolVersion: "1.0",
	contributionId: "deepseek",
	target: {
		kind: "custom-api",
		id: "custom-api/smoke",
		providerId: "smoke",
		generation: "generation",
		baseUrl: "https://api.deepseek.com",
	},
	reference: "opaque-reference",
	mode: "probe",
};
async function initialize(child: Awaited<ReturnType<typeof program>>) {
	const hello = await child.wait((message) => message.method === "hello");
	expect(hello.params).toMatchObject({
		pluginId: PLUGIN_ID,
		version: "1.0.4",
		rpcProtocol: "narrafork.rpc/1",
		features: [...FEATURES],
	});
	expect(
		(
			await child.request("initialize", {
				protocol: "narrafork.rpc/1",
				pluginId: PLUGIN_ID,
				hostApiVersion: "1.0",
				features: [...FEATURES],
				capabilities: ["quota.provide", "provider.connection.request"],
				runtimeId: "smoke-runtime",
				generation: 1,
			})
		).result,
	).toMatchObject({ initialized: true });
	expect((await child.request("activate")).result).toEqual({ activated: true });
	expect((await child.request("health")).result).toMatchObject({
		healthy: true,
		runtimeId: "smoke-runtime",
		generation: 1,
	});
}
test("real stdio hello/initialize/activate/health, bidirectional quota query and shutdown", async () => {
	const child = await program();
	try {
		await initialize(child);
		const running = child.request("quota.query", { ...queryParams, deadlineAt: Date.now() + 5000 });
		const host = await child.wait((message) => message.method === "provider.connection.request");
		expect(host.params).toEqual({
			reference: "opaque-reference",
			method: "GET",
			path: "/user/balance",
			headers: { accept: "application/json" },
		});
		const body = JSON.stringify({
			is_available: true,
			balance_infos: [
				{
					currency: "USD",
					total_balance: "1.2500",
					granted_balance: "0.0",
					topped_up_balance: "1.25",
				},
			],
		});
		child.send({
			jsonrpc: "2.0",
			id: host.id,
			result: {
				status: 200,
				contentType: "application/json",
				body,
				bytes: new TextEncoder().encode(body).byteLength,
			},
		});
		expect((await running).result).toMatchObject({
			status: "supported",
			data: {
				amounts: [
					{
						id: "balance:USD",
						display: "summary",
						quota: "alternative",
						remaining: 1.25,
						remainingText: "1.2500",
					},
					{
						id: "granted:USD",
						display: "detail",
						quota: "none",
						remaining: 0,
						remainingText: "0.0",
					},
					{
						id: "topped-up:USD",
						display: "detail",
						quota: "none",
						remaining: 1.25,
						remainingText: "1.25",
					},
				],
			},
			error: null,
		});
		expect((await child.request("deactivate")).result).toEqual({ deactivated: true });
		expect((await child.request("shutdown")).result).toEqual({ shutdown: true });
		expect(await child.child.exited).toBe(0);
	} finally {
		await child.close();
	}
}, 15_000);
test("real stdio relay query preserves subscription windows, exact expiry and legacy amount hints", async () => {
	const child = await program();
	try {
		await initialize(child);
		const running = child.request("quota.query", {
			...queryParams,
			contributionId: "relay",
			target: { ...queryParams.target, baseUrl: "https://relay.example/v1" },
			deadlineAt: Date.now() + 5000,
		});
		const host = await child.wait((message) => message.method === "provider.connection.request");
		expect(host.params).toEqual({
			reference: "opaque-reference",
			method: "GET",
			path: "/v1/usage",
			headers: { accept: "application/json" },
		});
		const body = JSON.stringify({
			mode: "unrestricted",
			isValid: true,
			unit: "USD",
			planName: "Team plan",
			subscription: {
				daily_limit_usd: 10,
				daily_usage_usd: 1,
				weekly_limit_usd: 50,
				weekly_usage_usd: 5,
				monthly_limit_usd: 100,
				monthly_usage_usd: 10,
				weekly_window_start: "2026-11-09T00:00:00+08:00",
				expires_at: "2027-01-01T00:00:00+08:00",
			},
		});
		child.send({
			jsonrpc: "2.0",
			id: host.id,
			result: {
				status: 200,
				contentType: "application/json",
				body,
				bytes: new TextEncoder().encode(body).byteLength,
			},
		});
		expect((await running).result).toMatchObject({
			status: "supported",
			error: null,
			data: {
				format: "sub2api",
				scope: "subscription",
				planName: "Team plan",
				expiresAt: "2026-12-31T16:00:00.000Z",
				amounts: [
					{
						id: "amount:0",
						window: "daily",
						display: "detail",
						quota: "none",
						used: 1,
						total: 10,
						remaining: 9,
					},
					{
						id: "amount:1",
						window: "weekly",
						display: "detail",
						quota: "none",
						used: 5,
						total: 50,
						remaining: 45,
						windowStart: "2026-11-08T16:00:00.000Z",
					},
					{
						id: "amount:2",
						window: "monthly",
						display: "detail",
						quota: "none",
						used: 10,
						total: 100,
						remaining: 90,
					},
				],
				windows: [
					{ id: "daily", used: 1, limit: 10, remaining: 9, resetAt: null },
					{ id: "weekly", used: 5, limit: 50, remaining: 45, resetAt: null },
					{ id: "monthly", used: 10, limit: 100, remaining: 90, resetAt: null },
				],
			},
		});
		await child.request("shutdown");
		expect(await child.child.exited).toBe(0);
	} finally {
		await child.close();
	}
}, 15_000);

test("real stdio cancellation aborts the child-to-host request and never publishes its late data", async () => {
	const child = await program();
	try {
		await initialize(child);
		const id = "query-to-cancel";
		const done = child.wait((message) => message.id === id);
		child.send({
			jsonrpc: "2.0",
			id,
			method: "quota.query",
			params: { ...queryParams, deadlineAt: Date.now() + 5000 },
		});
		const host = await child.wait((message) => message.method === "provider.connection.request");
		child.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
		expect((await child.wait((message) => message.method === "$/cancelRequest")).params).toEqual({
			id: host.id,
		});
		expect((await done).result).toEqual({ status: "error", data: null, error: "unavailable" });
		child.send({
			jsonrpc: "2.0",
			id: host.id,
			result: { status: 200, contentType: "application/json", body: "{}", bytes: 2 },
		});
		expect((await child.request("health")).result).toMatchObject({ healthy: true });
		await child.request("shutdown");
		expect(await child.child.exited).toBe(0);
	} finally {
		await child.close();
	}
}, 15_000);
