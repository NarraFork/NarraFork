import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getProviderKeyStore, type ProviderKey } from "../../provider-keys";
import { requestSourceName } from "../../request-source";
import { saveSettings, settings } from "../../settings";
import {
	classifyKeyFault,
	PooledProvider,
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
