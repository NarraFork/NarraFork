import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CredentialNetwork } from "@shared/credential-network";
import { setNugCachedModels } from "../../nug-model-cache";
import {
	streamQuotaIdentityForPrefix,
	streamQuotaIdentityForRequest,
} from "../../provider-key-subjects";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../../provider-keys";
import { type NUGProviderConfig, saveSettings, settings } from "../../settings";
import { registerTokenDanceRuntime } from "../../tokendance-runtime";
import type {
	ChatParams,
	ImageGenerationRequest,
	ParsedStreamEvent,
	ProviderAdapter,
} from "../provider";
import { ApiError } from "../types";

// Keep the real resolver, Command Code factory, NUG adapter and credential stores.
// Only terminal adapters and relay transport are replaced; no request can leave the test.
// Bun does not undo mock.module via mock.restore(), so restore real exports explicitly.
const realAnthropic = { ...(await import("../anthropic-provider")) };
const realOpenai = { ...(await import("../openai-provider")) };
const realTokenDance = { ...(await import("../tokendance-provider")) };
const realRelay = { ...(await import("../../nug-relay/manager")) };
const realCommandCodeAuth = { ...(await import("../../commandcode-manager")) };

type AdapterConfig = {
	apiKey: string;
	id?: string;
	prefix?: string;
	generation?: number;
	apiMode?: string;
	proxy?: CredentialNetwork["proxy"];
	userAgentMode?: string;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
};
const constructed: Array<{ kind: string; config: AdapterConfig }> = [];
const requests: Array<{ apiKey: string; operation: string }> = [];
const imageRequests: Array<{ config: AdapterConfig; params: ImageGenerationRequest }> = [];
const relayConfigs: NUGProviderConfig[] = [];
const failingKeys = new Set<string>();
const authCalls: Array<string | undefined> = [];
let cliToken: string | undefined;

class FakeAdapter implements ProviderAdapter {
	private reasoningSource?: string;
	constructor(
		readonly config: AdapterConfig,
		kind: string,
	) {
		constructed.push({ kind, config: structuredClone(config) });
	}
	formatTools() {
		return [];
	}
	async buildHistory() {
		return { history: [] } as never;
	}
	injectSystemPrompt() {}
	setReasoningSourceOverride(source: string | undefined) {
		this.reasoningSource = source;
	}
	getActiveReasoningSource() {
		return this.reasoningSource;
	}
	protected request(operation: string) {
		requests.push({ apiKey: this.config.apiKey, operation });
		if (failingKeys.has(this.config.apiKey)) throw new ApiError(401, "invalid test key");
	}
	async *chat(params: ChatParams) {
		params.onRequestStart?.({ credentialId: "inner-connection" });
		this.request("chat");
		yield { text: this.config.apiKey, credentialId: "inner-connection" };
	}
	async generate() {
		this.request("generate");
		return this.config.apiKey;
	}
	async generateWithMeta() {
		this.request("meta");
		return { text: this.config.apiKey, credentialId: "inner-connection" };
	}
	async generateWithHistory() {
		this.request("history");
		return this.config.apiKey;
	}
	async generateWithHistoryWithMeta() {
		this.request("history-meta");
		return { text: this.config.apiKey, credentialId: "inner-connection" };
	}
}
class FakeOpenAI extends FakeAdapter {
	constructor(config: AdapterConfig) {
		super(config, "openai");
	}
	async generateImage(params: ImageGenerationRequest) {
		imageRequests.push({ config: structuredClone(this.config), params });
		this.request("image");
		return {
			response: Response.json({ apiKey: this.config.apiKey, model: params.model }),
			credentialId: "inner-connection",
		};
	}
}
class FakeAnthropic extends FakeAdapter {
	constructor(config: AdapterConfig) {
		super(config, "anthropic");
	}
}
class FakeTokenDance extends FakeAdapter {
	constructor(apiKey?: string, config?: AdapterConfig) {
		super({ ...config, apiKey: apiKey ?? "unexpected-runtime-key" }, "tokendance");
	}
}

mock.module("../anthropic-provider", () => ({
	...realAnthropic,
	AnthropicProvider: FakeAnthropic,
}));
mock.module("../openai-provider", () => ({ ...realOpenai, OpenAIProvider: FakeOpenAI }));
mock.module("../tokendance-provider", () => ({
	...realTokenDance,
	TokenDanceProvider: FakeTokenDance,
}));
mock.module("../../nug-relay/manager", () => ({
	...realRelay,
	ensureNugRelayClient: (config: NUGProviderConfig) => relayConfigs.push(structuredClone(config)),
	getNugRelayChannelId: () => "test-relay-channel",
}));
mock.module("../../commandcode-manager", () => ({
	...realCommandCodeAuth,
	resolveCommandCodeToken: (configuredApiKey?: string) => {
		authCalls.push(configuredApiKey);
		const token = configuredApiKey?.trim() || cliToken;
		return token
			? { credential: { token, source: configuredApiKey?.trim() ? "settings" : "cli" } }
			: { reason: "not_configured" };
	},
}));
const { buildCommandCodeProvider } = await import("../commandcode-provider");
const { PooledProvider, resetProviderKeyRuntimeForTests } = await import("../pooled-provider");
const { resolveProviderAndModel } = await import("../provider");
const network = spyOn(globalThis, "fetch").mockRejectedValue(
	new Error("Unexpected external fetch"),
);

const NUG_ID = "source-key-pool-nug";
const CUSTOM_ID = "source-key-pool-custom";
const families = [
	{ name: "TokenDance", owner: TOKENDANCE_KEY_OWNER, group: "tokendance", model: "tokendance:m" },
	{
		name: "Command Code",
		owner: COMMAND_CODE_KEY_OWNER,
		group: "CommandCode",
		model: "CommandCode:gpt-test",
	},
	{ name: "NUG", owner: nugKeyOwner(NUG_ID), group: NUG_ID, model: "poolnug:upstream:m" },
] as const;
const store = () => getProviderKeyStore();
const providerNetwork: CredentialNetwork = {
	proxy: { mode: "direct" },
	userAgentMode: "custom",
	customUserAgent: "connection-agent",
	extraHeaders: { "X-Connection": "retained", "X-Identity": "connection" },
};
const keyNetwork = (name: string): CredentialNetwork => ({
	proxy: { mode: "custom", url: `http://${name}.proxy.invalid:8080` },
	userAgentMode: "custom",
	customUserAgent: `${name}-agent`,
	extraHeaders: { "X-Identity": name },
});
const unregisterRuntime = registerTokenDanceRuntime({
	getTokenDanceRuntimeConfig: () => ({
		apiKey: "runtime-first-key",
		generation: 17,
		disabled: false,
	}),
	assertTokenDanceConnection: () => {},
	registerTokenDanceRequest: () => () => {},
	getTokenDanceCatalogModels: () => [],
});

beforeEach(() => {
	for (const family of families) store().removeProvider(family.owner);
	store().removeProvider(CUSTOM_ID);
	resetProviderKeyRuntimeForTests();
	constructed.length = 0;
	requests.length = 0;
	imageRequests.length = 0;
	relayConfigs.length = 0;
	failingKeys.clear();
	authCalls.length = 0;
	cliToken = "test-cli-fallback";
	network.mockClear();
	settings.agent.disabledProviders = [];
	settings.customApiProviders = [];
	settings.anthropicProviders = [];
	settings.openaiProviders = [];
	settings.geminiProviders = [];
	settings.tokendance = { ...providerNetwork, apiKey: "", generation: 17, disabled: false };
	settings.commandCode = { ...providerNetwork, disabled: false };
	settings.nugProviders = [
		{
			...providerNetwork,
			id: NUG_ID,
			name: "NUG key pool test",
			prefix: "poolnug",
			apiKey: "",
			baseUrl: "https://gateway.invalid",
			defaultModel: "upstream:m",
		},
	];
	setNugCachedModels(NUG_ID, [
		{ id: "upstream:m", channel: "upstream", channelType: "openai", model: "m" },
	]);
});

afterEach(() => {
	for (const family of families) store().removeProvider(family.owner);
	store().removeProvider(CUSTOM_ID);
	resetProviderKeyRuntimeForTests();
	expect(network).not.toHaveBeenCalled();
});

afterAll(() => {
	unregisterRuntime();
	network.mockRestore();
	mock.module("../anthropic-provider", () => realAnthropic);
	mock.module("../openai-provider", () => realOpenai);
	mock.module("../tokendance-provider", () => realTokenDance);
	mock.module("../../nug-relay/manager", () => realRelay);
	mock.module("../../commandcode-manager", () => realCommandCodeAuth);
	mock.restore();
});

function chatParams(model: string, session: string): ChatParams {
	return {
		model,
		conversationId: session,
		stickySessionKey: session,
		content: "test",
		cwd: ".",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}
async function drain(stream: AsyncGenerator<ParsedStreamEvent>) {
	const events: ParsedStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

for (const family of families) {
	describe(`${family.name} source key pool integration`, () => {
		test("one plain key reports the group instead of the stored key id", async () => {
			const first = store().add(family.owner, { apiKey: "plain-key" });
			expect(first.id).not.toBe(family.group);
			const { adapter, model } = resolveProviderAndModel(family.model);
			expect(adapter).not.toBeInstanceOf(PooledProvider);
			if (family.name === "TokenDance") {
				expect(constructed.at(-1)?.config.generation).toBe(17);
			}
			const started: Array<string | undefined> = [];
			const events = await drain(
				adapter.chat({
					...chatParams(model, "plain"),
					onRequestStart: (info) => started.push(info?.credentialId),
				}),
			);
			expect(started).toEqual([family.group]);
			expect(events).toEqual([{ text: "plain-key", credentialId: family.group }]);
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "plain-key",
				credentialId: family.group,
			});
		});

		test("a second stored key enables real key-id reporting even when one is disabled", async () => {
			const first = store().add(family.owner, { apiKey: "disabled-key" });
			const second = store().add(family.owner, { apiKey: "enabled-key" });
			store().update(first.id, { disabled: true });
			const { adapter, model } = resolveProviderAndModel(family.model);
			expect(adapter).toBeInstanceOf(PooledProvider);
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "enabled-key",
				credentialId: second.id,
			});
			expect(constructed.every(({ config }) => config.apiKey === "enabled-key")).toBe(true);
		});

		test("a single network-overridden key is a pool and reports its real id", async () => {
			const first = store().add(family.owner, {
				apiKey: "network-key",
				network: keyNetwork("single"),
			});
			const { adapter, model } = resolveProviderAndModel(family.model);
			expect(adapter).toBeInstanceOf(PooledProvider);
			const started: Array<string | undefined> = [];
			const events = await drain(
				adapter.chat({
					...chatParams(model, "network"),
					onRequestStart: (info) => started.push(info?.credentialId),
				}),
			);
			expect(started).toEqual([first.id]);
			expect(events.map((event) => event.credentialId)).toEqual([first.id]);
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				credentialId: first.id,
			});
		});

		test("chat failure switches starts and events to the second real key", async () => {
			const first = store().add(family.owner, { apiKey: "rejected-key" });
			const second = store().add(family.owner, { apiKey: "backup-key" });
			failingKeys.add(first.apiKey);
			const { adapter, model } = resolveProviderAndModel(family.model);
			const started: Array<string | undefined> = [];
			const events = await drain(
				adapter.chat({
					...chatParams(model, "failover"),
					onRequestStart: (info) => started.push(info?.credentialId),
				}),
			);
			expect(requests).toEqual([
				{ apiKey: "rejected-key", operation: "chat" },
				{ apiKey: "backup-key", operation: "chat" },
			]);
			expect(started).toEqual([first.id, second.id]);
			expect(events).toEqual([{ text: "backup-key", credentialId: second.id }]);
			expect(store().get(first.id)).toMatchObject({ disabled: true, disabledReason: "invalid" });
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "backup-key",
				credentialId: second.id,
			});
		});

		test.each([
			"meta",
			"history-meta",
		])("%s failure returns metadata with the second real key", async (method) => {
			const first = store().add(family.owner, { apiKey: "rejected-key" });
			const second = store().add(family.owner, { apiKey: "backup-key" });
			failingKeys.add(first.apiKey);
			const { adapter, model } = resolveProviderAndModel(family.model);
			const result =
				method === "meta"
					? await adapter.generateWithMeta("test", model)
					: await adapter.generateWithHistoryWithMeta?.("system", "test", model);
			expect(result).toMatchObject({ text: "backup-key", credentialId: second.id });
			expect(requests).toEqual([
				{ apiKey: "rejected-key", operation: method },
				{ apiKey: "backup-key", operation: method },
			]);
		});

		test("disabled keys, reorder and network edits do not cross-contaminate adapter identities", async () => {
			const first = store().add(family.owner, {
				apiKey: "first-key",
				network: keyNetwork("first"),
			});
			const second = store().add(family.owner, {
				apiKey: "second-key",
				network: keyNetwork("second"),
			});
			const { adapter, model } = resolveProviderAndModel(family.model);
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "first-key",
				credentialId: first.id,
			});
			store().reorder(family.owner, [second.id, first.id]);
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "second-key",
				credentialId: second.id,
			});
			store().update(second.id, { disabled: true });
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "first-key",
				credentialId: first.id,
			});
			store().update(first.id, { network: keyNetwork("edited") });
			expect(await adapter.generateWithMeta("test", model)).toMatchObject({
				text: "first-key",
				credentialId: first.id,
			});
			for (const identity of ["first", "second", "edited"]) {
				expect(
					constructed.some(
						({ config }) =>
							config.apiKey === (identity === "second" ? "second-key" : "first-key") &&
							config.proxy?.mode === "custom" &&
							config.proxy.url === `http://${identity}.proxy.invalid:8080` &&
							config.userAgentMode === "custom" &&
							config.customUserAgent === `${identity}-agent` &&
							config.extraHeaders?.["X-Identity"] === identity &&
							config.extraHeaders?.["X-Connection"] === "retained",
					),
				).toBe(true);
			}
			expect(providerNetwork.extraHeaders?.["X-Identity"]).toBe("connection");
		});

		test("all managed keys disabled rejects instead of falling back", () => {
			const first = store().add(family.owner, { apiKey: "disabled-key" });
			store().update(first.id, { disabled: true });
			expect(() => resolveProviderAndModel(family.model)).toThrow("no usable API key");
			expect(requests).toEqual([]);
			expect(authCalls).toEqual([]);
		});
	});
}

describe("real Command Code factory and auth fallback", () => {
	test("no managed keys uses CLI auth and bills the group", async () => {
		expect(store().list(COMMAND_CODE_KEY_OWNER)).toEqual([]);
		const { adapter, model } = resolveProviderAndModel("CommandCode:gpt-test");
		expect(adapter).not.toBeInstanceOf(PooledProvider);
		expect(authCalls).toEqual([undefined]);
		expect(await adapter.generateWithMeta("test", model)).toMatchObject({
			text: "test-cli-fallback",
			credentialId: "CommandCode",
		});
	});

	test.each([
		["CommandCode:claude-test", "anthropic"],
		["CommandCode:gpt-test", "openai"],
	])("explicit key for %s bypasses the first key and CLI auth", (model, kind) => {
		store().add(COMMAND_CODE_KEY_OWNER, { apiKey: "first-managed-key" });
		const adapter = buildCommandCodeProvider(
			model,
			{ apiKey: "first-managed-key" },
			" selected-key ",
		);
		expect(adapter).toBeInstanceOf(FakeAdapter);
		expect(constructed.at(-1)).toMatchObject({ kind, config: { apiKey: "selected-key" } });
		expect(authCalls).toEqual([]);
		expect(buildCommandCodeProvider(model, { apiKey: "first-managed-key" }, " ")).toBeUndefined();
		expect(authCalls).toEqual([]);
	});
});

describe("real NUG preparation and relay ownership through pools", () => {
	test("resolver prepares the NUG delegate for this model, including newly selected keys", async () => {
		store().add(nugKeyOwner(NUG_ID), { apiKey: "first-nug-key" });
		const second = store().add(nugKeyOwner(NUG_ID), { apiKey: "second-nug-key" });
		const { adapter, model } = resolveProviderAndModel("poolnug:upstream:m");
		expect(adapter).toBeInstanceOf(PooledProvider);
		// No generation/chat yet: this delegate must have been created by prepareForModel.
		expect(constructed).toEqual([
			expect.objectContaining({
				kind: "openai",
				config: expect.objectContaining({ apiKey: "first-nug-key", apiMode: "completions" }),
			}),
		]);
		expect(adapter.getActiveReasoningSource?.()).toBe("poolnug:upstream");
		store().reorder(nugKeyOwner(NUG_ID), [second.id]);
		expect(adapter.getActiveReasoningSource?.()).toBe("poolnug:upstream");
		expect(constructed.at(-1)?.config.apiKey).toBe("second-nug-key");
		expect(await adapter.generateWithMeta("test", model)).toMatchObject({
			credentialId: second.id,
		});
	});

	test("rotating inference keys never rotates the connection's relay auth or proxy", async () => {
		const first = store().add(nugKeyOwner(NUG_ID), {
			apiKey: "relay-connection-key",
			network: keyNetwork("first"),
		});
		const second = store().add(nugKeyOwner(NUG_ID), {
			apiKey: "rotated-inference-key",
			network: keyNetwork("second"),
		});
		const connection = settings.nugProviders?.[0];
		if (!connection) throw new Error("missing NUG fixture");
		connection.egressMode = "local-proxy";
		const original = structuredClone(connection);
		const { adapter, model } = resolveProviderAndModel("poolnug:upstream:m");
		failingKeys.add(first.apiKey);
		expect(await adapter.generateWithMeta("test", model)).toMatchObject({
			credentialId: second.id,
		});
		expect(relayConfigs).toHaveLength(2);
		for (const config of relayConfigs) expect(config).toEqual(original);
		expect(relayConfigs.map((config) => config.apiKey)).toEqual([
			"relay-connection-key",
			"relay-connection-key",
		]);
		expect(relayConfigs.every((config) => config.proxy?.mode === "direct")).toBe(true);
	});
});

describe("real NUG pooled image generation", () => {
	test.each([
		1, 2,
	])("%i network key(s) prepares the chat route and bills the selected image key", async (count) => {
		const first = store().add(nugKeyOwner(NUG_ID), {
			apiKey: "first-image-key",
			network: keyNetwork("first"),
		});
		const second =
			count === 2
				? store().add(nugKeyOwner(NUG_ID), {
						apiKey: "second-image-key",
						network: keyNetwork("second"),
					})
				: undefined;
		const { adapter, model } = resolveProviderAndModel("poolnug:upstream:m");
		expect(adapter).toBeInstanceOf(PooledProvider);
		// Resolve on the first key, then select another one: its preparation must use
		// chatModel, never the unknown bare image model absent from the NUG catalog.
		if (second) store().reorder(nugKeyOwner(NUG_ID), [second.id, first.id]);
		const selected = second ?? first;
		const identity = second ? "second" : "first";
		const imageParams: ImageGenerationRequest = {
			prompt: "test image",
			model: "future-image-model",
			chatModel: model,
			conversationId: "image-session",
			signal: new AbortController().signal,
		};
		const result = await adapter.generateImage?.(imageParams);
		expect(result?.credentialId).toBe(selected.id);
		expect(await result?.response.json()).toEqual({
			apiKey: selected.apiKey,
			model: "upstream:future-image-model",
		});
		expect(requests).toEqual([{ apiKey: selected.apiKey, operation: "image" }]);
		expect(imageRequests).toHaveLength(1);
		expect(imageRequests[0]).toMatchObject({
			config: {
				apiKey: selected.apiKey,
				proxy: { mode: "custom", url: `http://${identity}.proxy.invalid:8080` },
				userAgentMode: "custom",
				customUserAgent: `${identity}-agent`,
				extraHeaders: { "X-Identity": identity, "X-Connection": "retained" },
			},
			params: { ...imageParams, model: "upstream:future-image-model" },
		});
		expect(imageParams.model).toBe("future-image-model");
	});

	test("image rejection is not retried or charged against another key", async () => {
		const first = store().add(nugKeyOwner(NUG_ID), {
			apiKey: "rejected-image-key",
			network: keyNetwork("first"),
		});
		const second = store().add(nugKeyOwner(NUG_ID), {
			apiKey: "backup-image-key",
			network: keyNetwork("second"),
		});
		const { adapter, model } = resolveProviderAndModel("poolnug:upstream:m");
		if (!adapter.generateImage) throw new Error("missing NUG image generation");
		failingKeys.add(first.apiKey);
		const imageParams: ImageGenerationRequest = {
			prompt: "test image",
			model: "future-image-model",
			chatModel: model,
			conversationId: "failed-image-session",
			signal: new AbortController().signal,
		};
		await expect(adapter.generateImage(imageParams)).rejects.toThrow("invalid test key");
		expect(requests).toEqual([{ apiKey: first.apiKey, operation: "image" }]);
		expect(imageRequests).toHaveLength(1);
		expect(imageRequests[0]?.config).toMatchObject({
			apiKey: first.apiKey,
			proxy: { mode: "custom", url: "http://first.proxy.invalid:8080" },
		});
		expect(store().get(first.id)?.disabled).not.toBe(true);
		expect(store().get(second.id)?.disabled).not.toBe(true);
		// A caller-controlled retry stays on the same selected key and reports its id.
		failingKeys.clear();
		const result = await adapter.generateImage(imageParams);
		expect(result.credentialId).toBe(first.id);
		expect(requests.map(({ apiKey }) => apiKey)).toEqual([first.apiKey, first.apiKey]);
	});
});

for (const variant of ["plain NUG", "pooled NUG", "pooled custom"] as const) {
	describe(`${variant} stream quota request identity TOCTOU`, () => {
		test.each([
			"key",
			"baseUrl",
			"globalProxy",
		])("%s edit at request-start delivery cannot relabel an old stream balance", async (edit) => {
			const custom = variant === "pooled custom";
			const pooled = variant !== "plain NUG";
			const owner = custom ? CUSTOM_ID : nugKeyOwner(NUG_ID);
			const group = custom ? CUSTOM_ID : NUG_ID;
			const prefix = custom ? "poolcustom" : "poolnug";
			const model = custom ? `${prefix}:m` : `${prefix}:upstream:m`;
			if (custom) {
				saveSettings({
					...settings,
					customApiProviders: [
						{
							...providerNetwork,
							id: CUSTOM_ID,
							name: "Custom quota TOCTOU",
							prefix,
							apiKey: "",
							baseUrl: "https://custom-before.invalid/v1",
							defaultModel: "m",
							protocol: "completions-compatible",
						},
					],
				});
			}
			if (edit === "globalProxy") {
				settings.proxy = { mode: "direct", noProxyRules: [] };
				const connection = custom ? settings.customApiProviders?.[0] : settings.nugProviders?.[0];
				if (!connection) throw new Error("missing global proxy TOCTOU connection");
				connection.proxy = { mode: "default" };
			}
			const first = store().add(owner, { apiKey: "request-selected-old-key" });
			if (pooled)
				store().add(owner, { apiKey: "unused-backup-key", network: keyNetwork("second") });
			const { adapter } = resolveProviderAndModel(model);
			expect(adapter instanceof PooledProvider).toBe(pooled);
			if (!pooled) expect(adapter.supportsDiagnosticFork).toBeUndefined();
			const credentialId = pooled ? first.id : group;
			const before = streamQuotaIdentityForPrefix(prefix, credentialId);
			expect(before).toBeString();
			let started = 0;
			let delivered: Parameters<typeof streamQuotaIdentityForRequest>[1];
			const events = await drain(
				adapter.chat({
					...chatParams(model, `quota-race-${variant}-${edit}`),
					onRequestStart: (info) => {
						started++;
						delivered = info;
						expect(info?.credentialId).toBe(credentialId);
						expect(typeof info?.validateDiagnosticCredential).toBe("function");
						expect(streamQuotaIdentityForRequest(prefix, info)).toBe(before);
						// The fake transport already owns its old config. Mutate synchronously
						// at delivery, before the loop asks what identity its balance belongs to.
						if (edit === "key") {
							store().update(first.id, { apiKey: "edited-live-key" });
						} else if (edit === "globalProxy") {
							saveSettings({
								...settings,
								proxy: {
									mode: "custom",
									url: "http://global.proxy.invalid:8080",
									noProxyRules: [],
								},
							});
							expect(settings.proxy?.mode).toBe("custom");
						} else if (custom) {
							saveSettings({
								...settings,
								customApiProviders: settings.customApiProviders?.map((config) =>
									config.id === group
										? { ...config, baseUrl: "https://custom-after.invalid/v1" }
										: config,
								),
							});
						} else {
							saveSettings({
								...settings,
								nugProviders: settings.nugProviders?.map((config) =>
									config.id === group
										? { ...config, baseUrl: "https://nug-after.invalid" }
										: config,
								),
							});
						}
						const live = streamQuotaIdentityForPrefix(prefix, credentialId);
						expect(live).toBeString();
						// Proxy-only edits leave the quota identity tuple unchanged, but
						// still invalidate the prepared transport's request-time guard.
						if (edit === "globalProxy") expect(live).toBe(before);
						else expect(live).not.toBe(before);
						expect(info?.validateDiagnosticCredential?.()).toBe(false);
						expect(streamQuotaIdentityForRequest(prefix, info)).toBeUndefined();
					},
				}),
			);
			expect(started).toBe(1);
			expect(events).toEqual([{ text: "request-selected-old-key", credentialId }]);
			expect(requests).toEqual([{ apiKey: "request-selected-old-key", operation: "chat" }]);
			expect(streamQuotaIdentityForRequest(prefix, delivered)).toBeUndefined();
		});
	});
}
