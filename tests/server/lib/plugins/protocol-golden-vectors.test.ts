import { describe, expect, test } from "bun:test";
import {
	adaptProviderStreamAckToRpcCredit,
	eventsPollParamsSchema,
	eventsSubscribeParamsSchema,
	hostInitializeParamsSchema,
	jsonRpcEnvelopeSchema,
	jsonRpcNotificationSchema,
	jsonValueSchema,
	NARRAFORK_RPC_PROTOCOL,
	PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES,
	PLUGIN_TO_HOST_NOTIFICATION_METHODS,
	PLUGIN_TO_HOST_REQUEST_METHODS,
	PROVIDER_PROTOCOL_VERSION,
	pluginHelloParamsSchema,
	pluginToHostEnvelopeSchema,
	pluginToHostFeatureListSchema,
	pluginToHostNotificationSchema,
	pluginToHostRequestSchema,
	providerStreamAckSchema,
	providerStreamEventSchema,
	RPC_CANCEL_REQUEST_METHOD,
	RPC_CREDIT_METHOD,
	rpcCancelRequestNotificationSchema,
	rpcCreditNotificationSchema,
	SNAPSHOT_LIVE_UNAVAILABLE,
} from "@server/lib/plugins/protocol";
import type { ContextSegment } from "@shared/context-composition";

describe("Provider final-input composition wire metadata", () => {
	const counts = { totalChars: 120, systemChars: 20, toolsChars: 40 };
	const segments = [
		{ category: "system", chars: 15 },
		{ category: "summary", chars: 5 },
		{ category: "toolDefinition", chars: 40 },
		{ category: "user", chars: 60 },
	] satisfies ContextSegment[];
	function parseSegments(compositionSegments: unknown) {
		return providerStreamEventSchema.safeParse({
			type: "request_started",
			inputCharacters: { ...counts, compositionSegments },
		});
	}

	test("preserves classified counts and supports legacy absent or null counts", () => {
		const result = parseSegments(segments);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({
				type: "request_started",
				inputCharacters: { ...counts, compositionSegments: segments },
			});
		}
		for (const inputCharacters of [counts, null, undefined]) {
			expect(
				providerStreamEventSchema.safeParse({ type: "request_started", inputCharacters }).success,
			).toBe(true);
		}
	});

	test("preserves explicit unknown classification instead of treating it as legacy absent", () => {
		const result = parseSegments(null);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({
				type: "request_started",
				inputCharacters: { ...counts, compositionSegments: null },
			});
		}
	});

	test("rejects invalid categories, noninteger counts, bodies, and classification IDs", () => {
		for (const invalid of [
			[{ category: "secret", chars: 120 }],
			[{ category: "user", chars: Infinity }],
			[{ category: "user", chars: NaN }],
			[{ category: "user", chars: -1 }],
			[{ category: "user", chars: 120.5 }],
			[{ category: "user", chars: Number.MAX_SAFE_INTEGER + 1 }],
			[{ ...segments[0], body: "secret request text" }, ...segments.slice(1)],
			[{ ...segments[0], toolUseId: "private-id" }, ...segments.slice(1)],
			{},
		]) {
			expect(parseSegments(invalid).success).toBe(false);
		}
	});

	test("rejects denominator mismatch and fixed system/tool category miscalibration", () => {
		for (const invalid of [
			[],
			[...segments.slice(0, 3), { category: "user", chars: 59 }],
			[...segments.slice(0, 3), { category: "user", chars: 61 }],
			[{ category: "user", chars: 120 }],
			[
				{ category: "system", chars: 40 },
				{ category: "toolDefinition", chars: 20 },
				{ category: "user", chars: 60 },
			],
			[
				{ category: "summary", chars: 21 },
				{ category: "toolDefinition", chars: 40 },
				{ category: "user", chars: 59 },
			],
		]) {
			expect(parseSegments(invalid).success).toBe(false);
		}
	});

	test("accepts the segment ceiling and rejects oversized input without entry traversal", () => {
		const bounded = [
			...segments,
			...Array.from({ length: 2048 - segments.length }, () => ({ category: "other", chars: 0 })),
		];
		expect(parseSegments(bounded).success).toBe(true);
		const oversized = new Array(2049);
		Object.defineProperty(oversized, 0, {
			get: () => {
				throw new Error("Oversized classifications must not be traversed");
			},
		});
		expect(parseSegments(oversized).success).toBe(false);
		expect(parseSegments([...bounded, { category: "other", chars: 0 }]).success).toBe(false);
	});
});

describe("Plugin JSON payload validation", () => {
	test("accepts long provider histories and large individual text blocks", () => {
		const history = Array.from({ length: 12_000 }, (_, index) => ({
			role: index % 2 ? "assistant" : "user",
			content: [{ type: "text", text: `message ${index}` }],
		}));
		expect(
			jsonRpcEnvelopeSchema.safeParse({
				jsonrpc: "2.0",
				id: "long-chat",
				method: "provider.chat",
				params: { history, current: "文".repeat(1_100_000) },
			}).success,
		).toBe(true);
	});

	test("accepts shared objects but rejects actual cycles", () => {
		const content = { type: "text", text: "shared" };
		expect(jsonValueSchema.safeParse({ a: content, b: content }).success).toBe(true);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(jsonValueSchema.safeParse(cyclic).success).toBe(false);
		const array: unknown[] = [];
		array.push(array);
		expect(jsonValueSchema.safeParse(array).success).toBe(false);
	});

	test("keeps depth and non-JSON safeguards", () => {
		let deep: unknown = null;
		for (let index = 0; index < 130; index++) deep = { child: deep };
		for (const invalid of [
			deep,
			undefined,
			NaN,
			Infinity,
			1n,
			new Date(),
			{ missing: undefined },
			JSON.parse('{"__proto__":{}}'),
			JSON.parse('{"constructor":{}}'),
			new Array(2),
		]) {
			expect(jsonValueSchema.safeParse(invalid).success).toBe(false);
		}
	});
});

describe("Plugin -> Host protocol golden vectors", () => {
	test("keeps legacy hello compatible while negotiating an explicit feature allowlist", () => {
		const legacyHello = pluginHelloParamsSchema.parse({
			id: "com.example.legacy",
			pluginVersion: "1.0.0",
			protocol: NARRAFORK_RPC_PROTOCOL,
		});
		expect(legacyHello).toEqual({
			pluginId: "com.example.legacy",
			version: "1.0.0",
			rpcProtocol: NARRAFORK_RPC_PROTOCOL,
			features: [],
		});

		expect(
			pluginToHostFeatureListSchema.safeParse(["host_api.requests", "unknown.feature"]).success,
		).toBe(false);
		expect(pluginToHostFeatureListSchema.safeParse(["rpc.cancel", "rpc.cancel"]).success).toBe(
			false,
		);
	});

	test("defaults initialize features to deny Plugin -> Host calls for old plugins", () => {
		const initialized = hostInitializeParamsSchema.parse({
			protocol: NARRAFORK_RPC_PROTOCOL,
			hostApiVersion: "1.0",
			pluginId: "com.example.legacy",
			runtimeId: "runtime-1",
			generation: 1,
			capabilities: ["query.read.projects"],
			limits: { maxInboundFrameBytes: 1_048_576, maxInFlight: 16 },
		});
		expect(initialized.features).toEqual([]);
	});

	test("allowlists the first Host API request surface and its required features", () => {
		const poll = {
			jsonrpc: "2.0",
			id: "request-1",
			method: "events.poll",
			params: { subscriptionId: "subscription-1" },
		};
		expect(pluginToHostRequestSchema.safeParse(poll).success).toBe(true);
		expect(pluginToHostEnvelopeSchema.safeParse(poll).success).toBe(true);
		expect(
			pluginToHostRequestSchema.safeParse({ ...poll, method: "host.internal.execute" }).success,
		).toBe(false);
		expect(PLUGIN_TO_HOST_REQUEST_METHODS).toContain("diagnostics.getOwn");
		expect(PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES["events.poll"]).toEqual([
			"host_api.requests",
			"events.poll",
		]);
	});

	test("validates cancellation as a reserved JSON-RPC control notification", () => {
		const cancel = {
			jsonrpc: "2.0",
			method: RPC_CANCEL_REQUEST_METHOD,
			params: { requestId: "request-1", reason: "deadline exceeded" },
		};
		expect(jsonRpcNotificationSchema.safeParse(cancel).success).toBe(true);
		expect(rpcCancelRequestNotificationSchema.safeParse(cancel).success).toBe(true);
		expect(pluginToHostNotificationSchema.safeParse(cancel).success).toBe(true);
		expect(
			rpcCancelRequestNotificationSchema.safeParse({
				...cancel,
				params: { requestId: "request-1" },
			}).success,
		).toBe(false);
	});

	test("validates generic credit and preserves the provider.streamAck adapter", () => {
		const credit = {
			jsonrpc: "2.0",
			method: RPC_CREDIT_METHOD,
			params: {
				streamId: "operation-1",
				throughSeq: 2,
				grantEvents: 1,
				grantBytes: 512,
			},
		} as const;
		expect(rpcCreditNotificationSchema.safeParse(credit).success).toBe(true);
		expect(
			rpcCreditNotificationSchema.safeParse({
				...credit,
				params: { ...credit.params, grantEvents: 0, grantBytes: 0 },
			}).success,
		).toBe(false);

		const providerAck = {
			jsonrpc: "2.0",
			method: "provider.streamAck",
			params: {
				protocolVersion: PROVIDER_PROTOCOL_VERSION,
				operationId: "operation-1",
				throughSeq: 2,
				grantEvents: 1,
				grantBytes: 512,
			},
		} as const;
		expect(providerStreamAckSchema.safeParse(providerAck).success).toBe(true);
		expect(adaptProviderStreamAckToRpcCredit(providerAck)).toEqual(credit);
	});

	test("distinguishes transport notifications from the Plugin -> Host semantic allowlist", () => {
		const unknown = { jsonrpc: "2.0", method: "plugin.unknown", params: { bounded: true } };
		expect(jsonRpcNotificationSchema.safeParse(unknown).success).toBe(true);
		expect(pluginToHostNotificationSchema.safeParse(unknown).success).toBe(false);
		expect(PLUGIN_TO_HOST_NOTIFICATION_METHODS).toContain("provider.event");
		expect(PLUGIN_TO_HOST_NOTIFICATION_METHODS).toContain(RPC_CANCEL_REQUEST_METHOD);
		expect(PLUGIN_TO_HOST_NOTIFICATION_METHODS).toContain(RPC_CREDIT_METHOD);
	});

	test("fixes v1 event delivery to live + poll and rejects snapshot_live", () => {
		const live = eventsSubscribeParamsSchema.parse({
			topics: ["narrafork.chapter.created"],
		});
		expect(live.mode).toBe("live");
		expect(live.delivery.transport).toBe("poll");
		expect(eventsPollParamsSchema.parse({ subscriptionId: "subscription-1" }).limit).toBe(100);

		const snapshot = eventsSubscribeParamsSchema.safeParse({
			topics: ["narrafork.chapter.created"],
			mode: "snapshot_live",
		});
		expect(snapshot.success).toBe(false);
		if (!snapshot.success) {
			expect(snapshot.error.issues.some((issue) => issue.message.includes("not implemented"))).toBe(
				true,
			);
		}
		expect(SNAPSHOT_LIVE_UNAVAILABLE).toMatchObject({
			code: "INCOMPATIBLE",
			retryable: false,
		});
	});
});
