import { describe, expect, it } from "bun:test";
import {
	getContributionFullId,
	getContributionIds,
	isContributionId,
	isManifestPath,
	isManifestUrl,
	isPermissionName,
	isPluginId,
	parseActivationEvent,
	parseManifest,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import {
	CAPABILITIES,
	effectivePermissionSchema,
	invocationScopeSchema,
	isWidePermission as isManifestWidePermission,
	permissionScopeSchema,
	SCOPE_TYPES,
	TRUST_TIERS,
	trustTierSchema,
} from "@server/lib/plugins/permissions";
import {
	JSON_RPC_ERROR_CODES,
	jsonRpcEnvelopeSchema,
	jsonRpcRequestSchema,
	MANIFEST_SCHEMA_VERSION as MANIFEST_SCHEMA_VERSION_FROM_PROTOCOL,
	manifestSchemaVersion,
	NARRAFORK_RPC_PROTOCOL,
	NARRAFORK_UI_PROTOCOL,
	PROVIDER_PROTOCOL,
	PROVIDER_PROTOCOL_VERSION,
	PUBLIC_EVENT_TOPICS,
	providerAcceptedSchema,
	providerDoneSchema,
	providerEventSchema,
	publicEventFilterSchema,
	publicEventSchema,
	RPC_PROTOCOL,
	UI_PROTOCOL,
	UI_RPC_PROTOCOL,
	uiRpcEnvelopeSchema,
	uiRpcNotificationSchema,
	uiRpcRequestSchema,
	uiRpcResponseSchema,
} from "@server/lib/plugins/protocol";

const fixtureDirectory = new URL("../../../fixtures/plugins/", import.meta.url);

async function loadManifestFixture(name: string): Promise<unknown> {
	return Bun.file(new URL(name, fixtureDirectory)).json();
}

describe("Manifest fixtures", () => {
	it("accepts valid-manifest.json", async () => {
		const manifest = parseManifest(await loadManifestFixture("valid-manifest.json"));

		expect(manifest.pluginId).toBe("com.example.hello");
		expect(getContributionIds(manifest)).toEqual(["hello", "chapterChanged"]);
		expect(getContributionFullId(manifest.pluginId, "hello")).toBe("com.example.hello/hello");
	});

	it("accepts a pure UI manifest", async () => {
		const result = safeParseManifest(await loadManifestFixture("valid-ui-only.json"));

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.server).toBeUndefined();
			expect(result.data.ui?.entry).toBe("ui/index.js");
			expect(result.data.contributes.views).toHaveLength(1);
		}
	});

	it("accepts valid-wide-permission.json now that declarations are not gated", async () => {
		// This fixture declares `host: ["admin"]`. It used to be rejected at parse time.
		// Under the install-is-trust model the declaration is descriptive, so it parses and
		// the broad token survives into the manifest for an admin UI to surface.
		const result = safeParseManifest(await loadManifestFixture("valid-wide-permission.json"));

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.permissions?.host).toEqual(["admin"]);
		}
	});

	for (const fixture of [
		"invalid-illegal-id.json",
		"invalid-remote-entry.json",
		"invalid-path-traversal.json",
		"invalid-duplicate-contribution.json",
		"invalid-activation-event.json",
	]) {
		it(`rejects ${fixture}`, async () => {
			expect((await safeParseManifest(await loadManifestFixture(fixture))).success).toBe(false);
		});
	}
});

describe("Manifest primitive contracts", () => {
	it("validates plugin and contribution IDs", () => {
		expect(isPluginId("com.example.plugin")).toBe(true);
		expect(isPluginId("Com.Example.Plugin")).toBe(false);
		expect(isPluginId("com..example")).toBe(false);
		expect(isContributionId("tool.v1_read")).toBe(true);
		expect(isContributionId("tool/id")).toBe(false);
	});

	it("accepts package-relative paths and safe external URLs only", () => {
		expect(isManifestPath("ui/index.js")).toBe(true);
		expect(isManifestPath("../ui/index.js")).toBe(false);
		expect(isManifestPath("/ui/index.js")).toBe(false);
		expect(isManifestPath("https://cdn.example.com/ui.js")).toBe(false);
		expect(isManifestPath("C:\\ui\\index.js")).toBe(false);

		expect(isManifestUrl("https://example.com/plugin")).toBe(true);
		expect(isManifestUrl("http://localhost:7779/metadata")).toBe(true);
		expect(isManifestUrl("ftp://example.com/plugin")).toBe(false);
		expect(isManifestUrl("https://user:secret@example.com/plugin")).toBe(false);
	});

	it("parses activation events and rejects incomplete events", () => {
		expect(parseActivationEvent("onStartup")).toEqual({ kind: "onStartup" });
		expect(parseActivationEvent("onCommand:build")).toEqual({
			kind: "onCommand",
			reference: "build",
		});
		expect(parseActivationEvent("onEvent:chapter.changed")).toEqual({
			kind: "onEvent",
			reference: "chapter.changed",
		});
		expect(parseActivationEvent("onCommand")).toBeUndefined();
		expect(parseActivationEvent("onUnknown:thing")).toBeUndefined();
	});

	it("labels wide permissions without rejecting them", () => {
		// `isWidePermission` survives as a labelling aid for admin UIs. It no longer gates
		// anything: an installed plugin may declare any capability, so these all parse.
		expect(isManifestWidePermission("*")).toBe(true);
		expect(isManifestWidePermission("admin")).toBe(true);
		expect(isManifestWidePermission("network.any")).toBe(true);
		expect(isManifestWidePermission("query.*")).toBe(true);
		expect(isManifestWidePermission("query.chapters.read")).toBe(false);

		// Capability names are open strings now, so previously-refused tokens are accepted.
		expect(isPermissionName("query.chapters.read")).toBe(true);
		expect(isPermissionName("admin")).toBe(true);
		expect(isPermissionName("*")).toBe(true);
		expect(isPermissionName("com.acme.custom.capability")).toBe(true);

		// camelCase segments are valid: the host's own taxonomy uses them.
		expect(isPermissionName("diagnostics.readOwnLogs")).toBe(true);
		expect(isPermissionName("ui.openExternal")).toBe(true);

		// The remaining rule is formatting, not trust: names must stay loggable.
		expect(isPermissionName("")).toBe(false);
		expect(isPermissionName("Has Spaces")).toBe(false);
		expect(isPermissionName("trailing.")).toBe(false);
		expect(isPermissionName("has..empty")).toBe(false);
		expect(isPermissionName("1leading.digit")).toBe(false);
	});
});

describe("Plugin protocol versions", () => {
	it("exposes the phase-0 protocol constants", () => {
		expect(MANIFEST_SCHEMA_VERSION_FROM_PROTOCOL).toBe(1);
		expect(manifestSchemaVersion).toBe(MANIFEST_SCHEMA_VERSION_FROM_PROTOCOL);
		expect(NARRAFORK_RPC_PROTOCOL).toBe("narrafork.rpc/1");
		expect(RPC_PROTOCOL).toBe(NARRAFORK_RPC_PROTOCOL);
		expect(PROVIDER_PROTOCOL_VERSION).toBe("1.0");
		expect(PROVIDER_PROTOCOL).toBe(PROVIDER_PROTOCOL_VERSION);
		expect(NARRAFORK_UI_PROTOCOL).toBe("narrafork.ui/1");
		expect(UI_PROTOCOL).toBe(NARRAFORK_UI_PROTOCOL);
		expect(UI_RPC_PROTOCOL).toBe(NARRAFORK_UI_PROTOCOL);
	});
});

describe("JSON-RPC envelopes", () => {
	const request = {
		jsonrpc: "2.0",
		id: "request-1",
		method: "plugin.initialize",
		params: { pluginId: "com.example.plugin" },
	};

	it("accepts a JSON-RPC request envelope", () => {
		expect(jsonRpcRequestSchema.safeParse(request).success).toBe(true);
		expect(jsonRpcEnvelopeSchema.safeParse(request).success).toBe(true);
	});

	it("rejects batches, unknown fields, and an unsupported protocol version", () => {
		expect(jsonRpcEnvelopeSchema.safeParse([request]).success).toBe(false);
		expect(jsonRpcRequestSchema.safeParse({ ...request, unexpected: true }).success).toBe(false);
		expect(jsonRpcRequestSchema.safeParse({ ...request, jsonrpc: "1.0" }).success).toBe(false);
	});

	it("accepts structured JSON-RPC errors without accepting unknown error fields", () => {
		const response = {
			jsonrpc: "2.0",
			id: "request-1",
			error: {
				code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
				message: "Invalid parameters",
			},
		};

		expect(jsonRpcEnvelopeSchema.safeParse(response).success).toBe(true);
		expect(
			jsonRpcEnvelopeSchema.safeParse({
				...response,
				error: { ...response.error, extra: true },
			}).success,
		).toBe(false);
	});
});

describe("Provider protocol envelopes", () => {
	it("accepts provider accepted, event, and done messages", () => {
		const accepted = {
			jsonrpc: "2.0",
			id: "request-1",
			result: { accepted: true, operationId: "operation-1" },
		};
		const event = {
			jsonrpc: "2.0",
			method: "provider.event",
			params: {
				protocolVersion: PROVIDER_PROTOCOL_VERSION,
				operationId: "operation-1",
				seq: 1,
				event: { type: "text.delta", text: "hello" },
			},
		};
		const done = {
			jsonrpc: "2.0",
			method: "provider.event",
			params: {
				protocolVersion: PROVIDER_PROTOCOL_VERSION,
				operationId: "operation-1",
				seq: 2,
				event: {
					type: "done",
					status: "completed",
					stopReason: "end_turn",
				},
			},
		};

		expect(providerAcceptedSchema.safeParse(accepted).success).toBe(true);
		expect(providerEventSchema.safeParse(event).success).toBe(true);
		expect(providerDoneSchema.safeParse(event).success).toBe(false);
		expect(providerEventSchema.safeParse(done).success).toBe(true);
		expect(providerDoneSchema.safeParse(done).success).toBe(true);
	});
});

describe("UI RPC envelopes", () => {
	it("accepts requests, notifications, successful responses, and error responses", () => {
		const request = {
			protocol: NARRAFORK_UI_PROTOCOL,
			kind: "request",
			id: "ui-request-1",
			method: "panel.refresh",
			params: { force: true },
		};
		const notification = {
			protocol: NARRAFORK_UI_PROTOCOL,
			kind: "notification",
			method: "panel.ready",
		};
		const success = {
			protocol: NARRAFORK_UI_PROTOCOL,
			kind: "response",
			id: "ui-request-1",
			result: { refreshed: true },
		};
		const failure = {
			protocol: NARRAFORK_UI_PROTOCOL,
			kind: "response",
			id: "ui-request-2",
			error: { code: "INVALID_PARAMS", message: "Invalid panel parameters" },
		};

		expect(uiRpcRequestSchema.safeParse(request).success).toBe(true);
		expect(uiRpcNotificationSchema.safeParse(notification).success).toBe(true);
		expect(uiRpcResponseSchema.safeParse(success).success).toBe(true);
		expect(uiRpcResponseSchema.safeParse(failure).success).toBe(true);
		expect(uiRpcEnvelopeSchema.safeParse(request).success).toBe(true);
		expect(uiRpcEnvelopeSchema.safeParse({ ...request, protocol: "narrafork.ui/2" }).success).toBe(
			false,
		);
	});
});

describe("Public events and filters", () => {
	it("accepts a public event and structured filters", () => {
		const event = {
			schema: "narrafork.public-event",
			schemaVersion: 1,
			eventId: "event-1",
			topic: "narrafork.project.changed",
			eventClass: "state",
			occurredAt: "2026-01-01T00:00:00.000Z",
			resource: { type: "project", id: "project-1" },
			actor: { kind: "system" },
			data: { changed: ["name"] },
			redaction: "public",
		};
		const filter = {
			all: [{ topic: ["narrafork.project.changed"] }],
			any: [{ eventClass: ["state"], resourceTypes: ["project"] }],
		};

		expect(publicEventSchema.safeParse(event).success).toBe(true);
		expect(publicEventFilterSchema.safeParse(filter).success).toBe(true);
		expect(PUBLIC_EVENT_TOPICS).toContain("narrafork.project.changed");
	});

	it("rejects unknown event topics, arbitrary filter fields, and overly deep filters", () => {
		expect(
			publicEventFilterSchema.safeParse({ topic: ["narrafork.unknown.changed"] }).success,
		).toBe(false);
		expect(
			publicEventFilterSchema.safeParse({ topic: ["narrafork.project.changed"], extra: true })
				.success,
		).toBe(false);
		expect(
			publicEventFilterSchema.safeParse({
				all: [
					{
						all: [
							{
								all: [{ topic: ["narrafork.project.changed"] }],
							},
						],
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("Trust, scopes, and effective permissions", () => {
	it("defines the four trust tiers", () => {
		expect(TRUST_TIERS).toEqual(["T0", "T1", "T2", "T3"]);
		for (const tier of TRUST_TIERS) {
			expect(trustTierSchema.safeParse(tier).success).toBe(true);
		}
		expect(trustTierSchema.safeParse("T4").success).toBe(false);
	});

	it("validates global and identified permission scopes", () => {
		expect(SCOPE_TYPES).toContain("global");
		expect(SCOPE_TYPES).toContain("session");
		expect(permissionScopeSchema.safeParse({ type: "global" }).success).toBe(true);
		expect(permissionScopeSchema.safeParse({ type: "project", id: "project-1" }).success).toBe(
			true,
		);
		expect(permissionScopeSchema.safeParse({ type: "global", id: "unexpected" }).success).toBe(
			false,
		);
		expect(permissionScopeSchema.safeParse({ type: "project" }).success).toBe(false);
		expect(
			invocationScopeSchema.safeParse({ projectId: "project-1", narratorId: "narrator-1" }).success,
		).toBe(true);
	});

	it("requires effective capabilities to be the intersection of every permission source", () => {
		const capability = "query.read.projects";
		const base = {
			pluginId: "com.example.permissions",
			trustTier: "T1",
			desiredState: "enabled",
			runtimeState: "active",
			compatibilityState: "compatible",
			manifestRequested: [capability],
			installationGrants: [{ capability, scope: { type: "global" } }],
			hostPolicy: [capability],
			currentUserAuthority: [capability],
			currentInvocationScope: { projectId: "project-1" },
			contributionPolicy: [capability],
			runnerEnforcement: [capability],
			effectiveCapabilities: [capability],
			evaluatedAt: "2026-01-01T00:00:00.000Z",
		};

		expect(effectivePermissionSchema.safeParse(base).success).toBe(true);
		expect(effectivePermissionSchema.safeParse({ ...base, hostPolicy: [] }).success).toBe(false);
		expect(
			effectivePermissionSchema.safeParse({ ...base, effectiveCapabilities: ["provider.use"] })
				.success,
		).toBe(false);
		expect(effectivePermissionSchema.safeParse({ ...base, installationGrants: [] }).success).toBe(
			false,
		);
		expect(CAPABILITIES).toContain(capability);
	});
});
