import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keyQuotaBlockedUntil } from "@server/lib/provider-key-quota";
import { type CustomApiProviderConfig, settings } from "@server/lib/settings";
import {
	providerQuotaSourceSchema,
	type QuotaQueryResult,
	quotaQueryResultSchema,
} from "@shared/provider-quota";
import {
	ProviderQuotaService,
	type ProviderQuotaSource,
	providerQuotaService,
	selectQuotaSources,
} from "../provider-quota-service";
import { CustomApiQuotaTargetDirectory } from "../provider-quota-targets";
import {
	deferred,
	quotaProvider,
	quotaResult,
	quotaSource,
	required,
	settle,
} from "./provider-quota-fixtures";

const owned: ProviderQuotaService[] = [];
afterEach(() => {
	for (const service of owned.splice(0)) service.dispose();
});

function fixture(count = 1, options: { roundTimeoutMs?: number; maxQueued?: number } = {}) {
	let providers = Array.from({ length: count }, (_, i) =>
		quotaProvider({ id: `custom-${String(i).padStart(3, "0")}` }),
	);
	let sources: ProviderQuotaSource[] = [quotaSource()];
	let globalProxy: unknown = { mode: "direct" };
	let now = 1_700_000_000_000;
	let query: (targetId: string) => Promise<QuotaQueryResult> = async () => quotaResult();
	const requests = mock(async (_source: ProviderQuotaSource, target: { providerId: string }) =>
		query(target.providerId),
	);
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => providers,
		globalProxy: () => globalProxy,
		userAgent: () => "fixture",
	});
	const changes = mock((_ids: string[], _version: number) => {});
	const service = new ProviderQuotaService({
		directory,
		driver: { listSources: () => sources, query: requests },
		now: () => now,
		onChanged: changes,
		...options,
	});
	owned.push(service);
	return {
		service,
		directory,
		requests,
		changes,
		get providers() {
			return providers;
		},
		setProviders: (value: CustomApiProviderConfig[]) => {
			providers = value;
		},
		setSources: (value: ProviderQuotaSource[]) => {
			sources = value;
			service.invalidateSources();
		},
		setProxy: (value: unknown) => {
			globalProxy = value;
		},
		setQuery: (value: typeof query) => {
			query = value;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

async function warm(f: ReturnType<typeof fixture>) {
	f.service.start();
	await settle(
		() => f.service.getDiagnostics().active === 0 && f.service.getDiagnostics().queued === 0,
	);
}

describe("generic Custom API quota cache", () => {
	test("unready discovery is pending, absent plugin becomes unavailable without legacy probing", async () => {
		const f = fixture();
		f.setSources([]);
		expect(f.service.peek("custom-000")?.status).toBe("pending");
		await warm(f);
		expect(f.service.peek("custom-000")?.status).toBe("unavailable");
		expect(await f.service.refresh("custom-000")).toMatchObject({
			status: "unavailable",
			data: null,
		});
		expect(f.requests).not.toHaveBeenCalled();
		expect(f.service.getDiagnostics().hasTimer).toBe(false);
	});

	test("read is nonblocking, one target is single-flight and manual attempts are throttled", async () => {
		const f = fixture();
		const held = deferred<QuotaQueryResult>();
		f.setQuery(() => held.promise);
		f.service.start();
		const first = f.service.refresh("custom-000");
		expect(f.service.refresh("custom-000")).toBe(first);
		expect(f.service.list().snapshots[0]?.status).toBe("probing");
		expect(f.requests).toHaveBeenCalledTimes(1);
		held.resolve(quotaResult(0));
		expect((await first)?.data?.amounts[0]?.remaining).toBe(0);
		await f.service.refresh("custom-000");
		expect(f.requests).toHaveBeenCalledTimes(1);
		expect(f.service.manualRetryAfterMs("custom-000")).toBe(10_000);
	});

	test("third party source displays unknown, explicit unlimited and real windows without enums", async () => {
		const f = fixture();
		f.setQuery(async () => ({
			status: "supported",
			error: null,
			data: {
				amounts: [{ id: "unknown", unit: "CREDITS", remaining: null }],
				unlimited: true,
				windows: [
					{
						id: "custom-window",
						used: 8,
						limit: 10,
						remaining: 2,
						resetAt: "2030-01-01T00:00:00Z",
					},
				],
			},
		}));
		await warm(f);
		expect(f.service.peek("custom-000")).toMatchObject({
			sourceId: "third.party.quota/generic",
			status: "supported",
			data: {
				unlimited: true,
				amounts: [{ remaining: null }],
				windows: [{ id: "custom-window", remaining: 2 }],
			},
		});
	});

	test("failure keeps same-identity last good value, fixed error and exponential backoff", async () => {
		const f = fixture();
		await warm(f);
		f.setQuery(async () => {
			throw new Error("raw-response-with-api-key");
		});
		f.advance(61_000);
		await f.service.refresh("custom-000");
		expect(f.service.peek("custom-000")).toMatchObject({
			status: "error",
			error: "request_failed",
			stale: true,
			data: { amounts: [{ remaining: 42 }] },
		});
		expect(JSON.stringify(f.service.peek("custom-000"))).not.toContain("raw-response");
		f.service.list();
		await f.service.refreshStale();
		expect(f.requests).toHaveBeenCalledTimes(2);
		f.advance(60_001);
		await f.service.refreshStale();
		await settle(() => f.service.getDiagnostics().active === 0);
		f.advance(60_001);
		await f.service.refreshStale();
		expect(f.requests).toHaveBeenCalledTimes(3);
	});

	test("unsupported is not hot-looped by repeated reads or activities", async () => {
		const f = fixture();
		f.setQuery(async () => ({ status: "unsupported", data: null, error: null }));
		await warm(f);
		for (let i = 0; i < 20; i++) f.service.list();
		await f.service.refreshStale();
		expect(f.requests).toHaveBeenCalledTimes(1);
		expect(f.service.peek("custom-000")?.status).toBe("unsupported");
	});

	test.each([
		[
			"key",
			(p: CustomApiProviderConfig) => {
				p.apiKey = "replacement-key";
			},
		],
		[
			"url",
			(p: CustomApiProviderConfig) => {
				p.baseUrl = "https://new.test/v1";
			},
		],
		[
			"protocol",
			(p: CustomApiProviderConfig) => {
				p.protocol = "anthropic-messages";
			},
		],
		[
			"proxy",
			(p: CustomApiProviderConfig) => {
				p.proxy = { mode: "direct" };
			},
		],
		[
			"TLS",
			(p: CustomApiProviderConfig) => {
				p.tlsRejectUnauthorized = false;
			},
		],
		[
			"headers",
			(p: CustomApiProviderConfig) => {
				p.extraHeaders = { Authorization: "alternate" };
			},
		],
		[
			"UA",
			(p: CustomApiProviderConfig) => {
				p.userAgentMode = "custom";
				p.customUserAgent = "other";
			},
		],
	] as const)("%s change rejects old values and an old finally cannot clear the replacement task", async (_name, mutate) => {
		const f = fixture();
		const old = deferred<QuotaQueryResult>();
		const fresh = deferred<QuotaQueryResult>();
		f.setQuery(() => old.promise);
		f.service.start();
		const previous = f.service.refresh("custom-000");
		const generation = f.service.peek("custom-000")?.generation;
		mutate(required(f.providers[0]));
		f.service.sync();
		expect(f.service.peek("custom-000")?.generation).not.toBe(generation);
		expect(f.service.peek("custom-000")?.data).toBeNull();
		f.setQuery(() => fresh.promise);
		const current = f.service.refresh("custom-000");
		old.resolve(quotaResult(999));
		expect(await previous).toBeNull();
		expect(f.service.refresh("custom-000")).toBe(current);
		fresh.resolve(quotaResult(5));
		expect((await current)?.data?.amounts[0]?.remaining).toBe(5);
	});

	test("global proxy, disabling and deletion invalidate; cosmetic edits keep generation", async () => {
		const f = fixture();
		await warm(f);
		const generation = f.service.peek("custom-000")?.generation;
		Object.assign(required(f.providers[0]), {
			name: "renamed",
			prefix: "renamed",
			defaultModel: "new-model",
		});
		expect(f.service.peek("custom-000")?.generation).toBe(generation);
		f.setProxy({ mode: "custom", url: "http://proxy.test:8080" });
		expect(f.service.peek("custom-000")?.generation).not.toBe(generation);
		required(f.providers[0]).disabled = true;
		expect(f.service.peek("custom-000")).toBeNull();
		required(f.providers[0]).disabled = false;
		f.service.sync();
		f.setProviders([]);
		expect(f.service.peek("custom-000")).toBeNull();
	});

	test("revoked source cancels in-flight query, expires data and leaves no refresh timer", async () => {
		const f = fixture();
		await warm(f);
		f.advance(61_000);
		const held = deferred<QuotaQueryResult>();
		f.setQuery(() => held.promise);
		const pending = f.service.refresh("custom-000");
		f.service.list();
		f.setSources([]);
		expect(await pending).toBeNull();
		held.resolve(quotaResult(100));
		await settle(() => f.service.getDiagnostics().active === 0);
		expect(f.service.peek("custom-000")).toMatchObject({
			status: "unavailable",
			stale: true,
			data: null,
		});
		expect(f.service.getDiagnostics()).toMatchObject({ queued: 0, hasTimer: false });
	});

	test("4 running and bounded backlog eventually service all warmup targets", async () => {
		const f = fixture(145, { maxQueued: 8 });
		const pending: ReturnType<typeof deferred<QuotaQueryResult>>[] = [];
		f.setQuery(async () => {
			const held = deferred<QuotaQueryResult>();
			pending.push(held);
			return held.promise;
		});
		f.service.start();
		expect(f.service.getDiagnostics()).toMatchObject({ active: 4, queued: 8 });
		for (let i = 0; i < 145; i++) {
			await settle(() => pending.length > i);
			required(pending[i]).resolve(quotaResult());
		}
		await settle(() => f.service.getDiagnostics().active === 0);
		expect(f.requests).toHaveBeenCalledTimes(145);
		expect(f.service.getDiagnostics().queued).toBe(0);
	});

	test("round timeout releases capacity even when the driver ignores abort", async () => {
		const f = fixture(5, { roundTimeoutMs: 10 });
		f.setQuery(() => new Promise(() => {}));
		await warm(f);
		expect(f.requests).toHaveBeenCalledTimes(5);
		expect(f.service.peek("custom-000")).toMatchObject({ status: "error", error: "timeout" });
	});

	test("deterministic invalid payload clears last good data and cannot be revived by a network failure", async () => {
		const f = fixture();
		await warm(f);
		f.advance(61_000);
		f.setQuery(async () => ({
			...quotaResult(),
			data: { amounts: [], windows: [], details: "<script>upstream</script>" },
		}));
		await f.service.refresh("custom-000");
		expect(f.service.peek("custom-000")).toMatchObject({ error: "invalid_response", data: null });
		f.advance(61_000);
		f.setQuery(async () => ({ status: "error", error: "request_failed", data: null }));
		await f.service.refresh("custom-000");
		expect(f.service.peek("custom-000")).toMatchObject({ error: "request_failed", data: null });
		expect(quotaQueryResultSchema.safeParse({ ...quotaResult(), apiKey: "leak" }).success).toBe(
			false,
		);
		expect(
			quotaQueryResultSchema.safeParse({
				...quotaResult(),
				data: { amounts: [], windows: [], details: "x".repeat(20_000) },
			}).success,
		).toBe(false);
	});

	test("pagination enforces both 100-item and 256KiB page budgets with visibility filtering", async () => {
		const f = fixture(60);
		f.setQuery(async () => ({
			status: "supported",
			error: null,
			data: {
				amounts: Array.from({ length: 32 }, (_, i) => ({
					id: String(i),
					label: "a".repeat(100),
					unit: "CREDITS",
					remaining: 1,
				})),
				windows: [],
				details: "d".repeat(4_000),
			},
		}));
		await warm(f);
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = f.service.list({ cursor, limit: 100, visible: (id) => id !== "custom-010" });
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
			expect(page.snapshots.length).toBeLessThanOrEqual(100);
			seen.push(...page.snapshots.map((snapshot) => snapshot.providerId));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen.length).toBe(59);
		expect(new Set(seen).size).toBe(59);
		expect(seen).not.toContain("custom-010");
	});

	test("source preference is deterministic, explicit before relay, and transient never falls through", async () => {
		const f = fixture();
		const specific = quotaSource({
			id: "vendor.example/special",
			declaration: providerQuotaSourceSchema.parse({
				...quotaSource().declaration,
				match: { hosts: ["relay.test"] },
			}),
		});
		const target = required(f.directory.list()[0]).target;
		expect(selectQuotaSources([quotaSource(), specific], target).map((s) => s.id)).toEqual([
			specific.id,
			quotaSource().id,
		]);
		f.setSources([quotaSource(), specific]);
		f.setQuery(async () => {
			throw new Error("temporary");
		});
		await warm(f);
		expect(f.requests).toHaveBeenCalledTimes(1);
		expect(f.requests.mock.calls[0]?.[0].id).toBe(specific.id);
	});
});

test("activity refresh is debounced, throttled and reset-boundary refresh is one-shot", async () => {
	const f = fixture();
	await warm(f);
	for (let i = 0; i < 30; i++) f.service.noteActivity("custom-000");
	expect(f.requests).toHaveBeenCalledTimes(1);
	// Successful warmup also counts toward the source's 20s activity budget.
	f.advance(20_001);
	f.service.list();
	await settle(() => f.requests.mock.calls.length === 2);
	await settle(() => f.service.getDiagnostics().active === 0);
	for (let i = 0; i < 30; i++) f.service.noteActivity("custom-000");
	expect(f.requests).toHaveBeenCalledTimes(2);
	f.advance(20_001);
	f.service.list();
	await settle(() => f.requests.mock.calls.length === 3);
	await settle(() => f.service.getDiagnostics().active === 0);
	f.service.stop();
	expect(f.service.getDiagnostics().hasTimer).toBe(false);

	const g = fixture();
	g.setQuery(async () => ({
		status: "supported",
		error: null,
		data: {
			amounts: [],
			windows: [
				{
					id: "limit",
					used: 10,
					limit: 10,
					remaining: 0,
					resetAt: new Date(1_700_000_001_000).toISOString(),
				},
			],
		},
	}));
	await warm(g);
	g.advance(1_001);
	g.service.list();
	await settle(() => g.requests.mock.calls.length === 2);
	await settle(() => g.service.getDiagnostics().active === 0);
	g.service.list();
	expect(g.requests).toHaveBeenCalledTimes(2);
});

test("a catalog readiness barrier never records unsupported and wakes after ready notification", async () => {
	const f = fixture();
	let ready = false;
	let notify: (() => void) | undefined;
	const query = mock(async () => quotaResult());
	f.service.configureDriver({
		isReady: () => ready,
		listSources: () => [quotaSource()],
		query,
		onChanged: (listener) => {
			notify = listener;
			return () => {
				notify = undefined;
			};
		},
	});
	f.service.start();
	expect(f.service.peek("custom-000")).toMatchObject({ status: "pending", error: null });
	await f.service.refresh("custom-000");
	f.service.list();
	expect(query).not.toHaveBeenCalled();
	ready = true;
	notify?.();
	await settle(() => f.service.getDiagnostics().active === 0);
	expect(query).toHaveBeenCalledTimes(1);
	expect(f.service.peek("custom-000")?.status).toBe("supported");
});

test("expired live grants are reconciled even without a lifecycle notification", async () => {
	const f = fixture();
	let granted = true;
	const query = mock(async () => quotaResult());
	f.service.configureDriver({ listSources: () => (granted ? [quotaSource()] : []), query });
	await warm(f);
	granted = false;
	expect(f.service.peek("custom-000")).toMatchObject({
		status: "unavailable",
		stale: true,
		data: null,
	});
	f.service.list();
	expect(query).toHaveBeenCalledTimes(1);
	expect(f.service.getDiagnostics().hasTimer).toBe(false);
});

test("a live fallback cannot make a revoked source's reset evidence available", async () => {
	const f = fixture();
	const original = quotaSource({
		id: "first.party/source-a",
		declaration: providerQuotaSourceSchema.parse({
			...quotaSource().declaration,
			match: { hosts: ["relay.test"] },
		}),
	});
	f.setSources([original, quotaSource()]);
	f.setQuery(async () => ({
		status: "supported",
		error: null,
		data: {
			amounts: [],
			windows: [
				{ id: "fiveHour", used: 10, limit: 10, remaining: 0, resetAt: "2030-01-01T00:00:00Z" },
			],
		},
	}));
	await warm(f);
	const held = deferred<QuotaQueryResult>();
	f.setQuery(() => held.promise);
	f.setSources([quotaSource()]);
	expect(f.service.peek("custom-000")).toMatchObject({
		status: "probing",
		sourceId: null,
		data: null,
		fetchedAt: 0,
	});
	held.resolve(quotaResult(4));
	await settle(() => f.service.getDiagnostics().active === 0);
	expect(f.service.peek("custom-000")?.sourceId).toBe(quotaSource().id);
});

test("unsupported results cannot carry reset windows and bypass their retry interval", async () => {
	const f = fixture();
	const malformed = {
		status: "unsupported",
		error: null,
		data: {
			amounts: [],
			windows: [
				{
					id: "limit",
					used: 1,
					limit: 1,
					remaining: 0,
					resetAt: new Date(1_700_000_000_010).toISOString(),
				},
			],
		},
	};
	expect(quotaQueryResultSchema.safeParse(malformed).success).toBe(false);
	f.setQuery(async () => malformed as QuotaQueryResult);
	await warm(f);
	f.advance(1_000);
	f.service.list();
	await f.service.refreshStale();
	expect(f.requests).toHaveBeenCalledTimes(1);
	expect(f.service.peek("custom-000")).toMatchObject({ data: null, error: "invalid_response" });
});

test("hot reload preserves the actual quota driver and timer and replaces its key probe", async () => {
	const previous = settings.customApiProviders;
	const service = providerQuotaService;
	const query = mock(async () => quotaResult());
	const unsubscribe = mock(() => {});
	const onChanged = mock((_listener: () => void) => unsubscribe);
	const probe = spyOn(service, "peekKeyForSelection").mockReturnValue(null);
	try {
		settings.customApiProviders = [quotaProvider({ id: "hmr-quota-owner" })];
		service.configureDriver({ listSources: () => [quotaSource()], query, onChanged });
		service.start();
		await service.refresh("hmr-quota-owner");
		await settle(() => service.getDiagnostics().active === 0);
		expect(query).toHaveBeenCalledTimes(1);
		// Warmup alone is intentionally timer-free. An interested caller owns a refresh timer.
		service.noteActivity("hmr-quota-owner");
		expect(service.getDiagnostics()).toMatchObject({ running: true, hasTimer: true });
		const readTimer = () =>
			(service as unknown as { wakeTimer?: ReturnType<typeof setTimeout> }).wakeTimer;
		const timer = readTimer();
		expect(timer).toBeDefined();
		const url = new URL("../provider-quota-service.ts", import.meta.url);
		const file = Bun.file(url);
		if (file.size > 256 * 1024) throw new Error("Quota owner fixture exceeded input budget");
		const source = await file.text();
		const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
		let code = transpiler.transformSync(source);
		for (const entry of transpiler.scanImports(source)) {
			if (entry.path.startsWith("node:")) continue;
			const resolved = Bun.resolveSync(entry.path, dirname(fileURLToPath(url)));
			code = code.replaceAll(
				JSON.stringify(entry.path),
				JSON.stringify(pathToFileURL(resolved).href),
			);
		}
		for (let version = 0; version < 2; version++) {
			// A distinct module body forces reevaluation; query-string imports can hit Bun's cache.
			const instance = `\nexport const __ownerEvaluation = ${JSON.stringify(crypto.randomUUID())};`;
			const reloaded = await import(
				`data:text/javascript;base64,${Buffer.from(code + instance).toString("base64")}`
			);
			expect(reloaded.__ownerEvaluation).toBeString();
			expect(reloaded.providerQuotaService).toBe(service);
			reloaded.providerQuotaService.start();
			expect(readTimer()).toBe(timer);
			expect(onChanged).toHaveBeenCalledTimes(1);
			expect(unsubscribe).not.toHaveBeenCalled();
			probe.mockClear();
			expect(keyQuotaBlockedUntil("hmr-fixture-key")).toBeUndefined();
			expect(probe).toHaveBeenCalledTimes(1);
		}
		expect(query).toHaveBeenCalledTimes(1);
		service.stop();
		expect(service.getDiagnostics()).toMatchObject({ running: false, hasTimer: false });
	} finally {
		service.dispose();
		probe.mockRestore();
		settings.customApiProviders = previous;
	}
}, 15_000);
