import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { EventHandlerContext } from "../../../services/narrator-event-handler";
import { captureCustomApiQuotaPushTarget } from "../../../services/provider-quota-push";
import { customApiQuotaTargets } from "../../../services/provider-quota-targets";
import type { NarratorServerMessage } from "../../../websocket/narrator-ws";
import { legacyQuotaFixture, required } from "../../__tests__/provider-quota-legacy-fixture";
import { getCustomApiCachedQuota } from "../../custom-api-quota-cache";
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
let starts: Array<{ id: string; identity?: string; generation: string }>;
let quotaFixture: ReturnType<typeof legacyQuotaFixture>;
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
				generation: required(quotaFixture.directory.getKey(key.id)).target.generation,
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
const { processEvent } = await import("../../../services/narrator-event-handler");
const narratorWs = await import("../../../websocket/narrator-ws");
const published: NarratorServerMessage[] = [];

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
	quotaFixture = legacyQuotaFixture(settings.customApiProviders);
	spyOn(customApiQuotaTargets, "list").mockImplementation(() => quotaFixture.directory.list());
	spyOn(customApiQuotaTargets, "get").mockImplementation((id) => quotaFixture.directory.get(id));
	spyOn(customApiQuotaTargets, "getKey").mockImplementation((id) =>
		quotaFixture.directory.getKey(id),
	);
	steps = {};
	starts = [];
	published.length = 0;
	spyOn(narratorWs, "broadcastToNarrator").mockImplementation((_id, message) => {
		published.push(message);
	});
	afterStart = undefined;
	adapter = new PooledProvider(id, build);
});
afterEach(() => {
	quotaFixture.dispose();
	mock.restore();
	for (const key of store.listGroup(id)) {
		quotaStore.remove(key.id);
		quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
	}
	store.removeGroup(id);
	resetProviderKeyRuntimeForTests();
	saveSettings(structuredClone(originalSettings));
});
afterAll(() => mock.module("../provider", () => originalProvider));

async function run(beforeTransport?: () => void) {
	const quotas: Array<Extract<AgentEvent, { type: "quota_balance" }>> = [];
	const events: AgentEvent[] = [];
	const ctx: EventHandlerContext = {
		narratorId: "stream-quota-narrator",
		broadcastTargetId: "stream-quota-narrator",
		conversationId: "stream-quota-session",
		providerPrefix: prefix,
		customApiQuotaTarget: captureCustomApiQuotaPushTarget(prefix),
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getPartialMessageId: () => undefined,
		getTokenUsage: () => undefined,
		setPartialMessageId: () => {},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
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
			freezeContextComposition: beforeTransport
				? () => {
						beforeTransport();
						return null;
					}
				: undefined,
		},
		"hello",
		{ rows: [] },
	)) {
		events.push(event);
		if (event.type === "quota_balance") {
			quotas.push(event);
			await processEvent(event, ctx);
		}
	}
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	expect(quotas.length).toBeGreaterThan(0);
	return quotas;
}
const done: ParsedStreamEvent = { text: "finished", stopReason: "stop" };

function quotaResponse() {
	const body =
		'event: quotaBalanceEvent\ndata: {"quotaBalance":"3"}\n\n' +
		'data: {"choices":[{"delta":{"content":"finished"},"finish_reason":null}]}\n\n' +
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
		"data: [DONE]\n\n";
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

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
			customApiQuotaTarget: { providerId: id, keyId: second.id, generation: starts[0]?.generation },
			quotaBalance: "0",
		},
	]);
	expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(0);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	expect(getCustomApiCachedQuota(id)).toMatchObject({
		quotaBalance: "0",
		generation: starts[0]?.generation,
	});
});

test("a direct single-plain-key adapter's group-id report maps to its distinct stored credential id", async () => {
	store.removeGroup(id);
	const key = store.add(id, { id: "stored-plain-key", apiKey: "key-plain" });
	adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
	expect(adapter).not.toBeInstanceOf(PooledProvider);
	const network = spyOn(globalThis, "fetch").mockResolvedValue(quotaResponse());
	try {
		const quotas = await run();
		expect(quotas).toHaveLength(1);
		expect(quotas[0]?.credentialId).toBe(id);
		expect(quotas[0]?.providerIdentity).toBeString();
		expect(quotas[0]?.providerIdentity).toBe(
			streamQuotaIdentityForRequest(prefix, { credentialId: id }),
		);
		expect(quotas[0]?.customApiQuotaTarget).toMatchObject({
			providerId: id,
			keyId: key.id,
			generation: required(quotaFixture.service.peekKey(key.id)).generation,
		});
		expect(quotaStore.peek(key.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(3);
		expect(quotaStore.peek(id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(published).toMatchObject([
			{
				type: "quota_balance",
				quotaBalance: "3",
				customApiQuotaTarget: { providerId: id, keyId: key.id },
			},
		]);
		expect(network).toHaveBeenCalledTimes(1);
	} finally {
		network.mockRestore();
	}
});

test("a promoted plain backup keeps group billing but publishes quota only to its selected key", async () => {
	const first = required(store.listGroup(id)[0]);
	const backup = store.add(id, { apiKey: "key-backup" });
	store.update(first.id, { disabled: true });
	store.reorder(id, [backup.id, first.id]);
	adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
	expect(adapter).not.toBeInstanceOf(PooledProvider);
	const generation = required(quotaFixture.directory.getKey(backup.id)).target.generation;
	const network = spyOn(globalThis, "fetch").mockResolvedValue(quotaResponse());
	const quotas = await run();
	expect(quotas).toHaveLength(1);
	expect(quotas[0]).toMatchObject({
		credentialId: id,
		quotaBalance: "3",
		customApiQuotaTarget: { providerId: id, keyId: backup.id, generation },
	});
	expect(quotas[0]?.providerIdentity).toBeString();
	expect(quotas[0]?.providerIdentity).toBe(
		streamQuotaIdentityForRequest(prefix, { credentialId: backup.id }),
	);
	expect(published).toHaveLength(1);
	expect(quotaStore.peek(backup.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(3);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
	expect(network).toHaveBeenCalledTimes(1);
});

test("a plain adapter still owns its unchanged key after a same-secret backup moves first", async () => {
	const first = required(store.listGroup(id)[0]);
	adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
	expect(adapter).not.toBeInstanceOf(PooledProvider);
	const backup = store.add(id, { apiKey: first.apiKey });
	store.reorder(id, [backup.id, first.id]);
	expect(adapter.isDiagnosticConnectionCurrent?.()).toBe(true);
	const network = spyOn(globalThis, "fetch").mockResolvedValue(quotaResponse());
	const quotas = await run();
	expect(network).toHaveBeenCalledTimes(1);
	expect(quotas).toHaveLength(1);
	expect(quotas[0]).toMatchObject({
		credentialId: id,
		quotaBalance: "3",
		customApiQuotaTarget: { providerId: id, keyId: first.id },
	});
	expect(quotas[0]?.providerIdentity).toBeString();
	expect(published).toHaveLength(1);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(3);
	expect(quotaStore.peek(backup.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
});

for (const change of ["key", "network", "disabled", "replacement"] as const) {
	test(`a plain adapter created before its selected key's ${change} change cannot borrow another key's validity`, async () => {
		const first = required(store.listGroup(id)[0]);
		const originalSecret = first.apiKey;
		const configVersion = JSON.stringify(settings.customApiProviders?.[0]);
		adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
		expect(adapter).not.toBeInstanceOf(PooledProvider);
		expect(adapter.isDiagnosticConnectionCurrent?.()).toBe(true);
		if (change === "key") store.update(first.id, { apiKey: "rotated-key-A" });
		else if (change === "network")
			store.update(first.id, { network: { extraHeaders: { "X-Account": "rotated-account-A" } } });
		else if (change === "disabled") store.update(first.id, { disabled: true });
		else store.remove(first.id);
		const backup = store.add(id, { apiKey: originalSecret });
		store.reorder(id, [backup.id, ...(change === "replacement" ? [] : [first.id])]);
		// Restoring the group's projected config must not restore the selected key's identity.
		expect(JSON.stringify(settings.customApiProviders?.[0])).toBe(configVersion);
		const authorizations: Array<string | null> = [];
		const network = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					authorizations.push(
						new Headers(
							init?.headers ?? (input instanceof Request ? input.headers : undefined),
						).get("authorization"),
					);
					return quotaResponse();
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const quotas = await run();
		expect(network).toHaveBeenCalledTimes(1);
		expect(authorizations).toEqual([`Bearer ${originalSecret}`]);
		expect(quotas).toHaveLength(1);
		expect(quotas[0]?.credentialId).toBe(id);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(quotaStore.peek(backup.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		expect(published).toEqual([]);
		expect(quotas[0]?.customApiQuotaTarget).toBeNull();
		expect(quotas[0]?.providerIdentity).toBeUndefined();
		expect(adapter.isDiagnosticConnectionCurrent?.()).toBe(false);
	});
}

for (const phase of ["preparation", "response"] as const) {
	for (const change of ["key", "network", "baseUrl", "globalProxy", "replacement"] as const) {
		test(`a plain stream frozen before ${phase} rejects a later ${change} change`, async () => {
			store.removeGroup(id);
			const key = store.add(id, { id: "late-plain-key", apiKey: "plain-secret" });
			adapter = originalProvider.resolveProviderAndModel(`${prefix}:m`).adapter;
			expect(adapter).not.toBeInstanceOf(PooledProvider);
			const generation = required(quotaFixture.directory.getKey(key.id)).target.generation;
			const identity = streamQuotaIdentityForRequest(prefix, { credentialId: key.id });
			expect(identity).toBeString();
			const changeConnection = mock(() => {
				if (change === "key") store.update(key.id, { apiKey: "replaced-secret" });
				else if (change === "network")
					store.update(key.id, { network: { extraHeaders: { "X-Account": "replacement" } } });
				else if (change === "replacement") {
					store.remove(key.id);
					store.add(id, { apiKey: key.apiKey });
				} else if (change === "globalProxy") {
					saveSettings({
						...settings,
						proxy: { mode: "custom", url: "http://proxy.invalid:8080", noProxyRules: [] },
					});
				} else {
					saveSettings({
						...settings,
						customApiProviders: settings.customApiProviders?.map((config) => ({
							...config,
							baseUrl: "https://replacement.invalid/v1",
						})),
					});
				}
			});
			const network = spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async () => {
						if (phase === "response") changeConnection();
						return quotaResponse();
					},
					{ preconnect: globalThis.fetch.preconnect },
				),
			);
			const quotas = await run(phase === "preparation" ? changeConnection : undefined);
			expect(changeConnection).toHaveBeenCalledTimes(1);
			expect(network).toHaveBeenCalledTimes(1);
			expect(quotas).toHaveLength(1);
			expect(quotas[0]).toMatchObject({
				credentialId: id,
				quotaBalance: "3",
				customApiQuotaTarget: { providerId: id, keyId: key.id, generation },
			});
			if (phase === "response") expect(quotas[0]?.providerIdentity).toBe(identity);
			const current = required(store.listGroup(id)[0]);
			if (change === "replacement") {
				expect(current.id).not.toBe(key.id);
				expect(current.apiKey).toBe(key.apiKey);
			}
			expect(required(quotaFixture.directory.getKey(current.id)).target.generation).not.toBe(
				generation,
			);
			expect(published).toEqual([]);
			expect(quotaStore.peek(key.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
			expect(quotaStore.peek(current.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
			expect(quotaStore.peek(id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		});
	}
}

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
	expect(quotas.map((event) => event.customApiQuotaTarget?.generation)).toEqual(
		starts.map((start) => start.generation),
	);
	expect(starts[0]?.identity).not.toBe(starts[1]?.identity);
	expect(starts[0]?.generation).not.toBe(starts[1]?.generation);
	expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(1);
	expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
	expect(getCustomApiCachedQuota(id)).toMatchObject({
		quotaBalance: "7",
		generation: starts[1]?.generation,
	});
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
