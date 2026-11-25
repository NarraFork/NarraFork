import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProviderKeyStore, type ProviderKey } from "../../provider-keys";
import { requestSourceName } from "../../request-source";
import { saveSettings, settings } from "../../settings";
import {
	classifyKeyFault,
	keyCooldown,
	PooledProvider,
	reportKeyFault,
	resetProviderKeyRuntimeForTests,
	selectProviderKey,
	withProviderKey,
} from "../pooled-provider";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../provider";
import { resolveProviderAndModel } from "../provider";
import { ApiError } from "../types";

const PROVIDER = "poolP";
const store = () => getProviderKeyStore();
let saved: typeof settings.customApiProviders;

beforeEach(() => {
	resetProviderKeyRuntimeForTests();
	saved = structuredClone(settings.customApiProviders);
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: PROVIDER,
				name: "Pool Test",
				prefix: "pooltest",
				apiKey: "sk-one",
				baseUrl: "https://api.example.com/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
	});
});

afterEach(() => {
	saveSettings({ ...settings, customApiProviders: saved });
	store().removeProvider(PROVIDER);
});

/** An adapter whose chat answers per key: a list of events, or an error to throw. */
function fakeBuild(behaviour: Record<string, Array<ParsedStreamEvent | Error>>) {
	const calls: string[] = [];
	const build = (key: ProviderKey): ProviderAdapter => ({
		formatTools: () => [],
		buildHistory: async () => ({ history: [] }) as never,
		injectSystemPrompt: () => {},
		async *chat(params: ChatParams) {
			calls.push(key.apiKey);
			params.onRequestStart?.();
			for (const step of behaviour[key.apiKey] ?? []) {
				if (step instanceof Error) throw step;
				yield step;
			}
		},
		generate: async () => key.apiKey,
		generateWithMeta: async () => ({ text: key.apiKey }) as never,
		generateWithHistory: async () => key.apiKey,
	});
	return { build, calls };
}

const params = (session: string): ChatParams =>
	({
		signal: new AbortController().signal,
		conversationId: session,
		stickySessionKey: session,
	}) as unknown as ChatParams;

async function drain(stream: AsyncGenerator<ParsedStreamEvent>) {
	const events: ParsedStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("pooled provider", () => {
	test("one plain key keeps the direct adapter; a second key turns on the pool", () => {
		expect(resolveProviderAndModel("pooltest:m").adapter).not.toBeInstanceOf(PooledProvider);
		store().add(PROVIDER, { apiKey: "sk-two" });
		expect(resolveProviderAndModel("pooltest:m").adapter).toBeInstanceOf(PooledProvider);
	});

	test("a used-up key hands the session to the next key and cools down", async () => {
		const second = store().add(PROVIDER, { apiKey: "sk-two", label: "backup" });
		const { build, calls } = fakeBuild({
			"sk-one": [new ApiError(429, "Weekly usage limit reached")],
			"sk-two": [{ text: "hi" } as ParsedStreamEvent],
		});
		const pool = new PooledProvider(PROVIDER, build);
		const started: Array<string | undefined> = [];
		const events = await drain(
			pool.chat({ ...params("s1"), onRequestStart: (info) => started.push(info?.credentialId) }),
		);
		expect(calls).toEqual(["sk-one", "sk-two"]);
		expect(events.map((e) => e.credentialId)).toEqual([second.id]);
		expect(started).toEqual([PROVIDER, second.id]);
		// Cooling down: new sessions start on the second key too.
		expect(selectProviderKey(PROVIDER, "s2")?.id).toBe(second.id);
		expect(requestSourceName(second.id)).toBe("Pool Test · backup");
	});

	test("a session stays on its key while that key is healthy", () => {
		const second = store().add(PROVIDER, { apiKey: "sk-two" });
		const first = selectProviderKey(PROVIDER, "s1");
		expect(first?.id).toBe(PROVIDER);
		store().reorder(PROVIDER, [second.id]);
		expect(selectProviderKey(PROVIDER, "s1")?.id).toBe(PROVIDER);
		expect(selectProviderKey(PROVIDER, "s-new")?.id).toBe(second.id);
	});

	test("a rejected key is turned off; output already streamed is never replayed", async () => {
		store().add(PROVIDER, { apiKey: "sk-two" });
		const { build } = fakeBuild({
			"sk-one": [new ApiError(401, "invalid api key")],
			"sk-two": [{ text: "partial" } as ParsedStreamEvent, new ApiError(429, "slow down")],
		});
		const pool = new PooledProvider(PROVIDER, build);
		await expect(drain(pool.chat(params("s1")))).rejects.toThrow("slow down");
		expect(store().get(PROVIDER)?.disabledReason).toBe("invalid");
	});

	test("when all keys rest, choose the earliest reset and keep exclusions", () => {
		const [first] = store().list(PROVIDER);
		const second = store().add(PROVIDER, { apiKey: "sk-two" });
		const now = 100_000;
		reportKeyFault(first, new ApiError(429, "rate limited, retry-after: 60"), now);
		reportKeyFault(second, new ApiError(429, "rate limited, retry-after: 7"), now);
		expect(selectProviderKey(PROVIDER, "s1", undefined, now)?.id).toBe(second.id);
		expect(selectProviderKey(PROVIDER, "s1", new Set([second.id]), now)?.id).toBe(first.id);
		expect(selectProviderKey(PROVIDER, "s1", undefined, now + 60_000)?.id).toBe(first.id);
	});

	test("one request tries each rejected key at most once", async () => {
		store().add(PROVIDER, { apiKey: "sk-two" });
		const { build, calls } = fakeBuild({
			"sk-one": [new ApiError(401, "first rejected")],
			"sk-two": [new ApiError(401, "second rejected")],
		});
		await expect(drain(new PooledProvider(PROVIDER, build).chat(params("s1")))).rejects.toThrow(
			"second rejected",
		);
		expect(calls).toEqual(["sk-one", "sk-two"]);
	});

	test("cancellation does not penalize a key or rotate to another", async () => {
		store().add(PROVIDER, { apiKey: "sk-two" });
		const controller = new AbortController();
		const { build, calls } = fakeBuild({
			"sk-one": [new ApiError(401, "cancelled")],
			"sk-two": [{ text: "must not retry" } as ParsedStreamEvent],
		});
		controller.abort();
		await expect(
			drain(
				new PooledProvider(PROVIDER, build).chat({ ...params("s1"), signal: controller.signal }),
			),
		).rejects.toThrow("cancelled");
		expect(calls).toEqual(["sk-one"]);
		expect(store().get(PROVIDER)?.disabled).not.toBe(true);
	});

	for (const operation of ["chat", "generateWithMeta"] as const) {
		for (const replacement of ["secret", "network"] as const) {
			for (const outcome of ["401", "429", "success"] as const) {
				test(`${operation}: late ${outcome} cannot change a same-id ${replacement} replacement`, async () => {
					const started = Promise.withResolvers<void>();
					const finish = Promise.withResolvers<void>();
					const first = store().list(PROVIDER)[0];
					store().add(PROVIDER, { apiKey: "sk-backup" });
					const calls: string[] = [];
					const { build } = fakeBuild({});
					const pool = new PooledProvider(PROVIDER, (key) => {
						const secret = key.apiKey;
						const result = async () => {
							calls.push(secret);
							started.resolve();
							await finish.promise;
							if (outcome !== "success") throw new ApiError(Number(outcome), "old attempt failed");
							return { text: secret };
						};
						return {
							...build(key),
							generateWithMeta: result,
							async *chat() {
								yield await result();
							},
						};
					});
					const pending =
						operation === "chat"
							? drain(pool.chat({ ...params("late-attempt"), model: "m" }))
							: pool.generateWithMeta("hello", "m");
					const observed = pending.then(
						(value) => ({ value }),
						(error: unknown) => ({ error }),
					);
					await started.promise;
					const live = store().update(
						first.id,
						replacement === "secret"
							? { apiKey: "sk-replacement" }
							: { network: { extraHeaders: { "X-Identity": "replacement" } } },
					);
					reportKeyFault(live, new ApiError(429, "retry-after: 7"));
					const newCooldown = keyCooldown(first.id);
					expect(newCooldown).toBeDefined();
					finish.resolve();
					const completed = await observed;
					if (outcome === "success") expect(completed).toHaveProperty("value");
					else expect(completed).toMatchObject({ error: { status: Number(outcome) } });
					expect(store().get(first.id)?.disabled).not.toBe(true);
					expect(store().get(first.id)?.apiKey).toBe(
						replacement === "secret" ? "sk-replacement" : "sk-one",
					);
					expect(keyCooldown(first.id)).toEqual(newCooldown);
					expect(calls).toEqual(["sk-one"]);
				});
			}
		}
	}

	test("root connection replacement shields an unchanged key from a late stream 401 and non-stream success", async () => {
		const { setOutboundFetchOverrideForTest } = await import("../../net/outbound-fetch");
		store().add(PROVIDER, { apiKey: "sk-backup" });
		const first = store().list(PROVIDER)[0];
		const originalKeys = structuredClone(store().list(PROVIDER));
		const { adapter, model } = resolveProviderAndModel("pooltest:m");
		expect(adapter).toBeInstanceOf(PooledProvider);
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let sends = 0;
		let validateDiagnosticCredential: (() => boolean) | undefined;
		let settled: Promise<unknown> | undefined;
		setOutboundFetchOverrideForTest(async (_input, init) => {
			const succeeds = String(init?.body).includes("root-nonstream-success");
			if (++sends === 2) started.resolve();
			await finish.promise;
			return !succeeds
				? Response.json({ error: { message: "old connection rejected this key" } }, { status: 401 })
				: Response.json({
						choices: [{ message: { content: "old connection success" }, finish_reason: "stop" }],
					});
		});
		try {
			const oldStream = drain(
				adapter.chat({
					...params("old-root"),
					model,
					content: "test",
					cwd: ".",
					history: [],
					tools: [],
					toolResults: [],
					onRequestStart: (info) => {
						validateDiagnosticCredential = info?.validateDiagnosticCredential;
					},
				}),
			).catch((error: unknown) => error);
			const oldSuccess = adapter.generateWithMeta("root-nonstream-success", model);
			settled = Promise.allSettled([oldStream, oldSuccess]);
			await started.promise;
			expect(adapter.isDiagnosticConnectionCurrent?.()).toBe(true);
			const root = settings.customApiProviders?.find((entry) => entry.id === PROVIDER);
			if (!root) throw new Error("missing root connection");
			saveSettings({
				...settings,
				customApiProviders: settings.customApiProviders?.map((entry) =>
					entry.id === root.id
						? { ...entry, baseUrl: "https://replacement.example.com/v1" }
						: entry,
				),
			});
			expect(adapter.isDiagnosticConnectionCurrent?.()).toBe(false);
			expect(validateDiagnosticCredential?.()).toBe(false);
			reportKeyFault(first, new ApiError(429, "retry-after: 7"));
			const newCooldown = keyCooldown(first.id);
			expect(newCooldown).toBeDefined();
			finish.resolve();
			expect(await oldStream).toMatchObject({ status: 401 });
			expect(await oldSuccess).toMatchObject({ text: "old connection success" });
			expect(store().list(PROVIDER)).toEqual(originalKeys);
			expect(keyCooldown(first.id)).toEqual(newCooldown);
			expect(sends).toBe(2);
		} finally {
			finish.resolve();
			await settled;
			setOutboundFetchOverrideForTest(null);
		}
	});

	test("a real TokenDance 401 body finishing after OAuth slot replacement cannot disable the new login", async () => {
		const { setOutboundFetchOverrideForTest } = await import("../../net/outbound-fetch");
		const { tokenDanceLoginAccount, TOKENDANCE_KEY_OWNER } = await import("../../provider-keys");
		const { registerTokenDanceRuntime } = await import("../../tokendance-runtime");
		const { TokenDanceProvider } = await import("../tokendance-provider");
		const bodyReading = Promise.withResolvers<void>();
		const finishBody = Promise.withResolvers<void>();
		let connection = { apiKey: "old-oauth-login", generation: 1, disabled: false };
		const first = store().add(TOKENDANCE_KEY_OWNER, { apiKey: connection.apiKey });
		store().update(first.id, { account: tokenDanceLoginAccount(connection.apiKey) });
		const unregister = registerTokenDanceRuntime({
			getTokenDanceRuntimeConfig: () => connection,
			getTokenDanceCatalogModels: () => [
				{
					id: "opaque-model",
					name: "M",
					context_length: 8192,
					supported_protocols: ["openai:chat-completions"],
				},
			],
			assertTokenDanceConnection: (generation, apiKey) => {
				if (generation !== connection.generation || apiKey !== connection.apiKey)
					throw new Error("login changed");
			},
			registerTokenDanceRequest: () => () => {},
		});
		const sent: string[] = [];
		setOutboundFetchOverrideForTest(async (_input, init) => {
			sent.push(new Headers(init?.headers).get("Authorization") ?? "");
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						async pull(sink) {
							bodyReading.resolve();
							await finishBody.promise;
							sink.enqueue(new TextEncoder().encode("old OAuth key rejected"));
							sink.close();
						},
					},
					{ highWaterMark: 0 },
				),
				{ status: 401 },
			);
		});
		try {
			const pool = new PooledProvider(
				TOKENDANCE_KEY_OWNER,
				(key) => new TokenDanceProvider(key.apiKey, { ...connection, proxy: { mode: "direct" } }),
			);
			const pending = pool
				.generateWithMeta("hello", "tokendance:opaque-model")
				.catch((error: unknown) => error);
			await bodyReading.promise;
			// Same in-place login slot update as OAuth completion, while the old error body is pending.
			connection = { apiKey: "new-oauth-login", generation: 2, disabled: false };
			const live = store().update(first.id, {
				apiKey: connection.apiKey,
				account: tokenDanceLoginAccount(connection.apiKey),
				disabled: false,
			});
			reportKeyFault(live, new ApiError(429, "retry-after: 7"));
			const newCooldown = keyCooldown(first.id);
			finishBody.resolve();
			expect(await pending).toMatchObject({ status: 401 });
			expect(store().get(first.id)).toMatchObject({
				apiKey: "new-oauth-login",
				account: tokenDanceLoginAccount("new-oauth-login"),
			});
			expect(store().get(first.id)?.disabled).not.toBe(true);
			expect(keyCooldown(first.id)).toEqual(newCooldown);
			expect(sent).toEqual(["Bearer old-oauth-login"]);
		} finally {
			finishBody.resolve();
			setOutboundFetchOverrideForTest(null);
			unregister();
			store().remove(first.id);
		}
	});

	test("synchronously prepares each selected adapter on first use, model change and key/network replacement", async () => {
		const second = store().add(PROVIDER, { apiKey: "sk-two" });
		const order: string[] = [];
		const { build } = fakeBuild({
			"sk-one": [new ApiError(402, "exhausted")],
			"sk-two": [{ text: "ok" } as ParsedStreamEvent],
		});
		const pool = new PooledProvider(PROVIDER, (key) => {
			const adapter = build(key);
			let prepared: string | undefined;
			adapter.prepareForModel = (model) => {
				order.push(`prepare:${key.apiKey}:${model}`);
				prepared = model;
			};
			const chat = adapter.chat.bind(adapter);
			adapter.chat = async function* (params) {
				expect(prepared).toBe(params.model);
				order.push(`chat:${key.apiKey}`);
				yield* chat(params);
			};
			adapter.generateWithMeta = async (_text, model) => {
				expect(prepared).toBe(model);
				return { text: key.apiKey };
			};
			return adapter;
		});
		pool.prepareForModel("pooltest:m");
		await drain(pool.chat({ ...params("prepared"), model: "pooltest:m" }));
		expect(order).toEqual([
			"prepare:sk-one:pooltest:m",
			"chat:sk-one",
			"prepare:sk-two:pooltest:m",
			"chat:sk-two",
		]);
		store().update(second.id, { network: { extraHeaders: { "X-Key": "replacement" } } });
		expect((await pool.generateWithMeta("hi", "pooltest:m")).credentialId).toBe(second.id);
		expect(order.at(-1)).toBe("prepare:sk-two:pooltest:m");
		const preparations = order.length;
		await pool.generateWithMeta("hi", "pooltest:m");
		expect(order).toHaveLength(preparations);
		await pool.generateWithMeta("hi", "pooltest:other");
		expect(order.at(-1)).toBe("prepare:sk-two:pooltest:other");
		store().update(second.id, { apiKey: "sk-replaced" });
		await pool.generateWithMeta("hi", "pooltest:other");
		expect(order.at(-1)).toBe("prepare:sk-replaced:pooltest:other");
	});

	test("a synchronous preparation error prevents resolution and upstream requests", async () => {
		const { build, calls } = fakeBuild({ "sk-one": [] });
		const pool = new PooledProvider(PROVIDER, (key) => ({
			...build(key),
			prepareForModel: () => {
				throw new Error("model preparation failed");
			},
		}));
		expect(() => pool.prepareForModel("m")).toThrow("model preparation failed");
		await expect(pool.generateWithMeta("hi", "m")).rejects.toThrow("model preparation failed");
		expect(calls).toEqual([]);
	});

	test("a diagnostic fork prepares only its pinned key without affinity changes or fault penalties", async () => {
		const second = store().add(PROVIDER, { apiKey: "sk-two" });
		const { build, calls } = fakeBuild({ "sk-two": [new ApiError(402, "diagnostic failure")] });
		const prepared: string[] = [];
		const pool = new PooledProvider(PROVIDER, (key) => {
			const adapter = build(key);
			let model: string | undefined;
			adapter.prepareForModel = (value) => {
				model = value;
				prepared.push(key.id);
			};
			adapter.supportsDiagnosticFork = (value, id) => model === value && id === key.id;
			return adapter;
		});
		expect(selectProviderKey(PROVIDER, "parent")?.id).toBe(PROVIDER);
		expect(pool.supportsDiagnosticFork("m", second.id)).toBe(true);
		await expect(
			drain(
				pool.chat({
					...params("parent"),
					model: "m",
					diagnosticFork: { suffix: "probe", credentialId: second.id },
				}),
			),
		).rejects.toThrow("diagnostic failure");
		expect(prepared).toEqual([second.id]);
		expect(calls).toEqual(["sk-two"]);
		expect(selectProviderKey(PROVIDER, "parent")?.id).toBe(PROVIDER);
		expect(keyCooldown(second.id)).toBeUndefined();
		expect(store().get(second.id)?.disabled).not.toBe(true);
	});

	test("server errors say nothing about the key", () => {
		expect(classifyKeyFault(new ApiError(500, "boom"))).toBeNull();
		expect(classifyKeyFault(new Error("network"))).toBeNull();
		expect(classifyKeyFault(new ApiError(429, "rate limited, retry-after: 7"))).toEqual({
			kind: "cooldown",
			ms: 7000,
			reason: "rate_limited",
		});
	});

	test("a key's network identity overrides the provider's", () => {
		const config: Parameters<typeof withProviderKey>[0] = {
			apiKey: "sk-one",
			proxy: { mode: "direct" },
			extraHeaders: { A: "provider", B: "provider" },
		};
		expect(
			withProviderKey(config, {
				apiKey: "sk-two",
				network: {
					proxy: { mode: "custom", url: "http://proxy:1" },
					userAgentMode: "narrafork",
					extraHeaders: { B: "key" },
				},
			}),
		).toEqual({
			apiKey: "sk-two",
			proxy: { mode: "custom", url: "http://proxy:1" },
			userAgentMode: "narrafork",
			customUserAgent: undefined,
			extraHeaders: { A: "provider", B: "key" },
		});
	});
});
