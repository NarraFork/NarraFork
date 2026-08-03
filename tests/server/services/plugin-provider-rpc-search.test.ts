/**
 * `PluginProviderRpcClient.search()` — the host side of `provider.search`.
 *
 * The mapping and manifest contract are covered elsewhere; what matters here is that this
 * unary path applies the same guards as `listModels` (handshake required, descriptor
 * required, byte caps, timeout ceiling) and that it refuses a response the search router
 * could not act on.
 */

import { describe, expect, it } from "bun:test";
import { PROVIDER_SEARCH_METHOD } from "@server/lib/plugins/protocol";
import {
	PluginProviderRpcClient,
	type ProviderRpcRequestOptions,
	type ProviderRpcTransport,
} from "@server/services/plugin-provider-rpc";

const PROTOCOL_VERSION = "1.0";
const PLUGIN_ID = "com.example.provider";
const PROVIDER_TYPE_ID = `${PLUGIN_ID}/main`;

function describeResult() {
	return {
		selectedProtocolVersion: PROTOCOL_VERSION,
		plugin: { id: PLUGIN_ID, name: "Example Provider", version: "1.0.0" },
		providers: [
			{
				localId: "main",
				displayName: "Example",
				configSchema: { type: "object", properties: {} },
				capabilities: { validateConfig: true, listModels: true, chat: true, generate: true },
			},
		],
	};
}

class SearchTransport implements ProviderRpcTransport {
	readonly requests: Array<{
		method: string;
		params: unknown;
		options?: ProviderRpcRequestOptions;
	}> = [];
	searchResponse: unknown = { text: "upstream answer" };

	request<T = unknown>(
		method: string,
		params?: unknown,
		options?: ProviderRpcRequestOptions,
	): Promise<T> {
		this.requests.push({ method, params, options });
		if (method === "provider.describe") return Promise.resolve(describeResult() as T);
		if (method === PROVIDER_SEARCH_METHOD) return Promise.resolve(this.searchResponse as T);
		return Promise.resolve(undefined as T);
	}

	notify(): Promise<void> {
		return Promise.resolve();
	}

	kill(): void {}
}

function searchParams(overrides: Record<string, unknown> = {}) {
	return {
		providerTypeId: PROVIDER_TYPE_ID,
		providerInstanceId: `${PLUGIN_ID}/main@1`,
		config: {},
		contributionId: "web-search",
		query: "latest news",
		...overrides,
	};
}

async function makeClient(limits?: { unaryTimeoutMs?: number; maxUnaryResponseBytes?: number }) {
	const transport = new SearchTransport();
	const client = new PluginProviderRpcClient({
		transport,
		expectedPluginId: PLUGIN_ID,
		...(limits ? { limits } : {}),
	});
	await client.describe({ protocolVersions: [PROTOCOL_VERSION] });
	return { client, transport };
}

describe("provider.search over RPC", () => {
	it("sends the contract params and returns the plugin's text", async () => {
		const { client, transport } = await makeClient();
		const result = await client.search(
			searchParams({ purpose: "verify", recencyDays: 7, maxResults: 5, locale: "zh-CN" }),
		);
		expect(result).toEqual({ text: "upstream answer" });
		const sent = transport.requests.find((entry) => entry.method === PROVIDER_SEARCH_METHOD);
		expect(sent?.params).toMatchObject({
			protocolVersion: PROTOCOL_VERSION,
			contributionId: "web-search",
			query: "latest news",
			purpose: "verify",
			recencyDays: 7,
			maxResults: 5,
			locale: "zh-CN",
		});
	});

	it("does not leak host-side routing fields to the plugin", async () => {
		// `providerTypeId`/`providerInstanceId` identify the registration to the host; a
		// plugin already knows which contribution it is serving and has no use for either.
		const { client, transport } = await makeClient();
		await client.search(searchParams());
		const sent = transport.requests.find((entry) => entry.method === PROVIDER_SEARCH_METHOD);
		expect(sent?.params).not.toHaveProperty("providerTypeId");
		expect(sent?.params).not.toHaveProperty("providerInstanceId");
		expect(sent?.params).not.toHaveProperty("timeoutMs");
	});

	it("requires the describe handshake first", async () => {
		const transport = new SearchTransport();
		const client = new PluginProviderRpcClient({ transport, expectedPluginId: PLUGIN_ID });
		await expect(client.search(searchParams())).rejects.toMatchObject({ code: "NOT_DESCRIBED" });
	});

	it("rejects an unknown provider type", async () => {
		const { client } = await makeClient();
		await expect(
			client.search(searchParams({ providerTypeId: `${PLUGIN_ID}/ghost` })),
		).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
	});

	it("clamps a manifest timeout to the transport ceiling", async () => {
		// A manifest may ask for less time than the host allows, never more: otherwise one
		// plugin could hold a search channel open past the host's own budget.
		const { client, transport } = await makeClient({ unaryTimeoutMs: 20_000 });
		await client.search(searchParams({ timeoutMs: 5_000 }));
		await client.search(searchParams({ timeoutMs: 90_000 }));
		const sent = transport.requests.filter((entry) => entry.method === PROVIDER_SEARCH_METHOD);
		expect(sent[0]?.options?.timeoutMs).toBe(5_000);
		expect(sent[1]?.options?.timeoutMs).toBe(20_000);
	});

	it("enforces a manifest-declared response budget and never lets it exceed the host cap", async () => {
		// `limits.maxOutputBytes` is a promise the plugin makes about itself, so a tighter
		// declaration is enforced rather than merely recorded — otherwise every source silently
		// gets the full host allowance. A larger declaration must have no effect.
		const { client, transport } = await makeClient({ maxUnaryResponseBytes: 64 * 1024 });
		transport.searchResponse = { text: "x".repeat(4_096) };

		// Declared smaller than the response: rejected.
		await expect(client.search(searchParams({ maxOutputBytes: 1_024 }))).rejects.toMatchObject({
			code: "FRAME_LIMIT",
		});
		// Declared larger than the host cap: clamped down to the host cap, which this response
		// still fits, so it succeeds — the declaration did not raise the ceiling.
		await expect(
			client.search(searchParams({ maxOutputBytes: 4 * 1024 * 1024 })),
		).resolves.toMatchObject({ text: "x".repeat(4_096) });
		// The budget is a host-side concern; the plugin is not told about it.
		const sent = transport.requests.filter((entry) => entry.method === PROVIDER_SEARCH_METHOD);
		expect(sent.at(-1)?.params).not.toHaveProperty("maxOutputBytes");
	});

	it("accepts structured results and drops empty item fields", async () => {
		const { client, transport } = await makeClient();
		transport.searchResponse = {
			results: [
				{ title: "Result", url: "https://example.com", snippet: "body" },
				{ title: "", url: "https://example.org" },
			],
		};
		const result = await client.search(searchParams());
		expect(result.results).toHaveLength(2);
		expect(result.results?.[0]?.title).toBe("Result");
		// An empty string is not a title; keeping it would render a blank heading.
		expect(result.results?.[1]?.title).toBeUndefined();
		expect(result.text).toBeUndefined();
	});

	it("rejects a response carrying neither text nor results", async () => {
		// An empty success would stop the router's fallback chain at a channel that returned
		// nothing, which is worse than a failure.
		const { client, transport } = await makeClient();
		for (const response of [{}, { text: "" }, { results: [] }]) {
			transport.searchResponse = response;
			await expect(client.search(searchParams())).rejects.toMatchObject({
				code: "INVALID_RESPONSE",
			});
		}
	});

	it("rejects a non-object response", async () => {
		const { client, transport } = await makeClient();
		transport.searchResponse = "just a string";
		await expect(client.search(searchParams())).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	});

	it("rejects an oversized result page", async () => {
		const { client, transport } = await makeClient();
		transport.searchResponse = {
			results: Array.from({ length: 101 }, (_, index) => ({ title: `r${index}` })),
		};
		await expect(client.search(searchParams())).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	});

	it("rejects an over-long field rather than truncating it", async () => {
		const { client, transport } = await makeClient();
		transport.searchResponse = { results: [{ url: "u".repeat(3_000) }] };
		await expect(client.search(searchParams())).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
	});

	it("enforces the unary response byte cap", async () => {
		// Large enough for the describe handshake, small enough that an oversized search
		// response trips it.
		const { client, transport } = await makeClient({ maxUnaryResponseBytes: 2_048 });
		transport.searchResponse = { text: "x".repeat(8_192) };
		await expect(client.search(searchParams())).rejects.toMatchObject({ code: "FRAME_LIMIT" });
	});

	it("rejects a result item that is not an object", async () => {
		const { client, transport } = await makeClient();
		transport.searchResponse = { results: ["not an object"] };
		await expect(client.search(searchParams())).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	});
});
