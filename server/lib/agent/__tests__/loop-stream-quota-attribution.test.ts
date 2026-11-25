import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	getCustomApiCachedQuota,
	updateCustomApiQuotaByPrefix,
} from "../../custom-api-quota-cache";
import { streamQuotaIdentityForRequest } from "../../provider-key-subjects";
import { getProviderKeyStore, type ProviderKey } from "../../provider-keys";
import { saveSettings, settings } from "../../settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../../sourcing/quota-store";
import {
	PooledProvider,
	reportKeyFault,
	resetProviderKeyRuntimeForTests,
} from "../pooled-provider";
import type { ParsedStreamEvent, ProviderAdapter } from "../provider";
import { type AgentEvent, ApiError } from "../types";

const id = "stream-quota-pool";
const prefix = "stream-quota";
const originalSettings = structuredClone(settings);
const store = getProviderKeyStore();
let adapter: ProviderAdapter;
let steps: Record<string, Array<ParsedStreamEvent | Error>>;
let starts: Array<{ id: string; identity?: string }>;
let afterStart: ((key: ProviderKey) => void) | undefined;

function build(key: ProviderKey): ProviderAdapter {
	return {
		formatTools: (tools) => tools,
		buildHistory: async () => ({ history: [] }),
		injectSystemPrompt: () => {},
		async *chat(params) {
			params.onRequestStart?.();
			starts.push({
				id: key.id,
				identity: streamQuotaIdentityForRequest(prefix, { credentialId: key.id }),
			});
			afterStart?.(key);
			for (const step of steps[key.id] ?? []) {
				if (step instanceof Error) throw step;
				yield step;
			}
		},
		generate: async () => "",
		generateWithMeta: async () => ({ text: "" }),
		generateWithHistory: async () => "",
	};
}
const originalProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	...originalProvider,
	getProvider: () => adapter,
	resolveProviderAndModel: () => ({ adapter, provider: prefix, model: `${prefix}:m` }),
}));
const { agentLoop } = await import("../loop");

beforeEach(() => {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id,
				prefix,
				name: "Quota pool",
				apiKey: "key-A",
				baseUrl: "https://quota.example/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
	});
	steps = {};
	starts = [];
	afterStart = undefined;
	adapter = new PooledProvider(id, build);
});
afterEach(() => {
	for (const key of store.listGroup(id)) {
		quotaStore.remove(key.id);
		quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
	}
	store.removeGroup(id);
	resetProviderKeyRuntimeForTests();
	saveSettings(structuredClone(originalSettings));
});
afterAll(() => mock.module("../provider", () => originalProvider));

async function run() {
	const quotas: Array<Extract<AgentEvent, { type: "quota_balance" }>> = [];
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		{
			narratorId: "stream-quota-narrator",
			conversationId: "stream-quota-session",
			provider: prefix,
			model: `${prefix}:m`,
			cwd: ".",
			signal: AbortSignal.timeout(10_000),
			permissionHandler: async () => ({ behavior: "deny", message: "no tools" }),
			maxTurns: 1,
		},
		"hello",
		{ rows: [] },
	)) {
		events.push(event);
		if (event.type === "quota_balance") {
			quotas.push(event);
			updateCustomApiQuotaByPrefix(
				prefix,
				event.quotaBalance,
				event.detailedQuotaBalance,
				event.providerIdentity,
			);
		}
	}
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	return quotas;
}
const done: ParsedStreamEvent = { text: "finished", stopReason: "stop" };

test("a real pool selecting B while A is first attributes the stream quota only to B", async () => {
	const first = store.listGroup(id)[0];
	if (!first) throw new Error("missing first key");
	const second = store.add(id, { apiKey: "key-B" });
	reportKeyFault(first, new ApiError(429, "rate limited"));
	steps[second.id] = [{ quotaBalance: "0" }, done];
	const quotas = await run();
	expect(store.listGroup(id)[0]?.id).toBe(first.id);
	expect(starts.map((start) => start.id)).toEqual([second.id]);
	expect(quotas).toMatchObject([
		{
			providerIdentity: starts[0]?.identity,
			quotaBalance: "0",
		},
	]);
	expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(0);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	expect(getCustomApiCachedQuota(id)).toBeUndefined();
});

test("a direct single-plain-key adapter's group-id report maps to its distinct stored credential id", async () => {
	store.removeGroup(id);
	const key = store.add(id, { id: "stored-plain-key", apiKey: "key-plain" });
	adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
	expect(adapter).not.toBeInstanceOf(PooledProvider);
	const body =
		'event: quotaBalanceEvent\ndata: {"quotaBalance":"3"}\n\n' +
		'data: {"choices":[{"delta":{"content":"finished"},"finish_reason":null}]}\n\n' +
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
		"data: [DONE]\n\n";
	const network = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(body, {
			headers: { "content-type": "text/event-stream" },
		}),
	);
	try {
		const quotas = await run();
		expect(quotas[0]?.providerIdentity).toBe(
			streamQuotaIdentityForRequest(prefix, { credentialId: id }),
		);
		expect(quotaStore.peek(key.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(3);
		expect(quotaStore.peek(id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	} finally {
		network.mockRestore();
	}
});

test("in-pool failover refreshes both the credential id and identity on every attempt", async () => {
	const first = store.listGroup(id)[0];
	if (!first) throw new Error("missing first key");
	const second = store.add(id, { apiKey: "key-B" });
	steps[first.id] = [{ quotaBalance: "1" }, new ApiError(402, "payment required")];
	steps[second.id] = [{ quotaBalance: "7" }, done];
	const quotas = await run();
	expect(starts.map((start) => start.id)).toEqual([first.id, second.id]);
	expect(quotas.map((event) => event.providerIdentity)).toEqual(
		starts.map((start) => start.identity),
	);
	expect(starts[0]?.identity).not.toBe(starts[1]?.identity);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(1);
	expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
	expect(getCustomApiCachedQuota(id)?.quotaBalance).toBe("1");
});

test("a late stream cannot follow a deleted CID onto a newly created same-secret key", async () => {
	const first = store.listGroup(id)[0];
	if (!first) throw new Error("missing first key");
	const second = store.add(id, { apiKey: "key-B" });
	reportKeyFault(first, new ApiError(429, "rate limited"));
	steps[second.id] = [{ quotaBalance: "99" }, done];
	afterStart = (key) => {
		store.remove(key.id);
		store.add(id, { apiKey: key.apiKey });
	};
	const [event] = await run();
	const replacement = store.listGroup(id).find((key) => key.id !== first.id);
	if (!replacement) throw new Error("replacement key was not created");
	expect(replacement.id).not.toBe(second.id);
	expect(event?.providerIdentity).toBe(starts[0]?.identity);
	expect(event?.providerIdentity).not.toBe(
		streamQuotaIdentityForRequest(prefix, { credentialId: replacement.id }),
	);
	expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	expect(quotaStore.peek(replacement.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
});

for (const change of ["key", "network"] as const) {
	test(`a late pool quota after B's ${change} changes cannot write B or first A`, async () => {
		const first = store.listGroup(id)[0];
		if (!first) throw new Error("missing first key");
		const second = store.add(id, { apiKey: "key-B" });
		reportKeyFault(first, new ApiError(429, "rate limited"));
		steps[second.id] = [{ quotaBalance: "0" }, done];
		afterStart = (key) => {
			if (change === "key") store.update(key.id, { apiKey: "key-B-replaced" });
			else store.update(key.id, { network: { extraHeaders: { "X-Account": "replacement" } } });
		};
		const [event] = await run();
		expect(event?.providerIdentity).toBe(starts[0]?.identity);
		expect(event?.providerIdentity).not.toBe(
			streamQuotaIdentityForRequest(prefix, { credentialId: second.id }),
		);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	});
}
