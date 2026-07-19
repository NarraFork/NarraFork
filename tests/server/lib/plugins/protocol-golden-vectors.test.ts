import { describe, expect, test } from "bun:test";
import {
	adaptProviderStreamAckToRpcCredit,
	eventsPollParamsSchema,
	eventsSubscribeParamsSchema,
	hostInitializeParamsSchema,
	jsonRpcNotificationSchema,
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
	RPC_CANCEL_REQUEST_METHOD,
	RPC_CREDIT_METHOD,
	rpcCancelRequestNotificationSchema,
	rpcCreditNotificationSchema,
	SNAPSHOT_LIVE_UNAVAILABLE,
} from "@server/lib/plugins/protocol";

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
