import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { apiRequests, credentialUsageTotals, narrators, userUsageTotals } from "@server/db/schema";
import { TOKEN_ACCOUNTING_VERSION } from "@shared/token-accounting";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { buildUsageDataFromSnapshot } from "../usage-tracking";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("@server/db")) };
mock.module("@server/db", () => ({ ...realDbModule, db, sqlite }));

import {
	DIAGNOSTICS_MAX_BYTES,
	finishApiRequest,
	serializeDiagnostics,
	startApiRequest,
} from "../api-request-tracker";
import { resolveCredentialDisplayName } from "../credential-display-name";
import { getProviderKeyStore } from "../provider-keys";
import { defaultRequestSourceId } from "../request-source";
import { saveSettings, settings } from "../settings";
import { registerTokenDanceRuntime } from "../tokendance-runtime";

afterEach(() => {
	cleanDb(sqlite);
});

describe("serializeDiagnostics", () => {
	test("returns null when there are no diagnostics", () => {
		expect(serializeDiagnostics({})).toBeNull();
		expect(serializeDiagnostics({ diagnostics: null })).toBeNull();
	});

	test("serializes normalized diagnostics", () => {
		const out = serializeDiagnostics({
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 502,
				requestId: "req-123",
			},
		});
		expect(JSON.parse(out as string)).toEqual({
			schema: "narrafork.error-diagnostics.v1",
			statusCode: 502,
			requestId: "req-123",
		});
	});

	test("stays within DIAGNOSTICS_MAX_BYTES for oversized input (CJK measured in bytes)", () => {
		const huge = "内容".repeat(200_000);
		const out = serializeDiagnostics({
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 400,
				message: huge,
				responseSnippet: huge,
				cause: huge,
				endpoint: huge,
				channelName: huge,
				provider: "nug2",
				model: "nug2:anthropic:claude-opus-5",
				recordingRequestId: "rec-oversized",
				responseHeaders: { "x-request-id": huge },
			},
		});
		expect(out).not.toBeNull();
		expect(Buffer.byteLength(out as string, "utf8")).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
		const parsed = JSON.parse(out as string) as { recordingRequestId?: string };
		// The association id must survive trimming so the row still links to its recording.
		expect(parsed.recordingRequestId).toBe("rec-oversized");
	});
});

describe("request evidence linkage on the inserted row", () => {
	test("row carries recordingRequestId and bounded diagnostics", async () => {
		const handle = startApiRequest({
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			recordingRequestId: "rec-linked-1",
		});
		await finishApiRequest(handle, {
			errorMessage: "upstream 502",
			diagnostics: {
				schema: "narrafork.error-diagnostics.v1",
				statusCode: 502,
				requestId: "req-502",
				message: "x".repeat(100_000),
			},
		});
		const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
		expect(row?.recordingRequestId).toBe("rec-linked-1");
		expect(row?.errorMessage).toBe("upstream 502");
		expect(row?.tokenAccountingVersion).toBe(TOKEN_ACCOUNTING_VERSION);
		const diagnosticsJson = row?.diagnosticsJson as string;
		expect(Buffer.byteLength(diagnosticsJson, "utf8")).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
		expect(JSON.parse(diagnosticsJson)).toMatchObject({ statusCode: 502, requestId: "req-502" });
	});

	test("successful request without diagnostics or recording stores nulls", async () => {
		const handle = startApiRequest({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
		await finishApiRequest(handle, { usage: { inputTokens: 1, outputTokens: 1 } });
		const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
		expect(row?.recordingRequestId).toBeNull();
		expect(row?.diagnosticsJson).toBeNull();
	});

	test("cache_usage_reported mirrors the adapter's flag and stays null when unknown", async () => {
		const cases = [
			{
				usage: buildUsageDataFromSnapshot({ inputTokens: 5, cacheReported: true }),
				expected: true,
			},
			{
				usage: buildUsageDataFromSnapshot({ inputTokens: 5, cacheReported: false }),
				expected: false,
			},
			{
				usage: buildUsageDataFromSnapshot({ inputTokens: 5, cachedInputTokens: 2 }),
				expected: null,
			},
			{ usage: null, expected: null },
		];
		for (const { usage, expected } of cases) {
			const handle = startApiRequest({ provider: "openai", model: "gpt-5" });
			await finishApiRequest(handle, { usage });
			const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
			expect(row?.cacheUsageReported).toBe(expected);
		}
	});
});

describe("request occupancy snapshot persistence", () => {
	test("actual request insertion maps bounded occupancy metadata without changing billing", async () => {
		const handle = startApiRequest({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
		const snapshot = {
			requestId: "logical-request",
			startedAt: "2026-10-05T00:00:00Z",
			source: "upstream" as const,
			percentage: 92.6,
			contextWindow: 1_000_000,
			occupiedTokens: 926000,
			inputCharacters: { totalChars: 1_000_000, systemChars: 0, toolsChars: 0 },
			composition: null,
		};
		await finishApiRequest(handle, {
			usage: { inputTokens: 510800, outputTokens: 10 },
			contextPercent: 92.6,
			contextSnapshot: snapshot,
		});
		const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
		expect(row?.contextUsageSnapshotJson).toEqual(snapshot);
		expect(row?.inputTokens).toBe(510800);
	});
	test("historical omission remains null; oversized metadata is not inserted", async () => {
		for (const contextSnapshot of [
			undefined,
			{
				requestId: "x".repeat(17000),
				startedAt: "2026-10-05T00:00:00Z",
				source: "estimate" as const,
				percentage: null,
				contextWindow: null,
				occupiedTokens: null,
				inputCharacters: null,
				composition: null,
			},
		]) {
			const handle = startApiRequest({ provider: "anthropic", model: "claude-sonnet-4-20250514" });
			await finishApiRequest(handle, { contextSnapshot });
			expect(
				db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get()
					?.contextUsageSnapshotJson,
			).toBeNull();
		}
	});
});

describe("request user attribution", () => {
	test.each([
		undefined,
		"ModelTrace canceled",
		"Invalid diagnostic answer",
	])("ModelTrace %s remains queryable with operator, child and cache attribution exactly once", async (errorMessage) => {
		const childId = "modeltrace-child";
		const userId = "modeltrace-operator";
		const now = new Date().toISOString();
		db.insert(narrators).values({ id: childId, createdAt: now, updatedAt: now }).run();
		const handle = startApiRequest({
			kind: "modeltrace",
			userId,
			narratorId: childId,
			provider: "nug",
			model: "frozen-model",
		});
		const options = {
			usage: buildUsageDataFromSnapshot({
				inputTokens: 100,
				completionTokens: 20,
				cachedInputTokens: 800,
				cacheCreationInputTokens: 50,
				cacheCreation5mTokens: 10,
				cacheCreation1hTokens: 40,
				reasoningTokens: 5,
			}),
			credentialId: "modeltrace-credential",
			ttftMs: 12,
			durationMs: 80,
			meterUsage: 1.5,
			meterUnit: "credit",
			errorMessage,
		};
		await finishApiRequest(handle, options);
		await finishApiRequest(handle, options);
		expect(db.select().from(apiRequests).where(eq(apiRequests.narratorId, childId)).all()).toEqual([
			expect.objectContaining({
				kind: "modeltrace",
				userId,
				narratorId: childId,
				provider: "nug",
				model: "frozen-model",
				inputTokens: 100,
				outputTokens: 20,
				cachedInputTokens: 800,
				cacheCreationInputTokens: 50,
				cacheCreation5mTokens: 10,
				cacheCreation1hTokens: 40,
				reasoningTokens: 5,
				errorMessage: errorMessage ?? null,
				ttftMs: 12,
				durationMs: 80,
				meterUsage: 1.5,
				meterUnit: "credit",
			}),
		]);
		expect(
			db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
		).toMatchObject({
			requestCount: 1,
			inputTokens: 100,
			cachedInputTokens: 800,
			cacheCreationTokens: 50,
		});
		expect(
			db
				.select()
				.from(credentialUsageTotals)
				.where(eq(credentialUsageTotals.credentialId, "modeltrace-credential"))
				.get(),
		).toMatchObject({
			requestCount: 1,
			inputTokens: 100,
			cachedInputTokens: 800,
			cacheCreationTokens: 50,
		});
	});

	test.each([
		"openai",
		"codex",
		"gemini",
		"nug",
		"anthropic",
	])("%s preserves normalized buckets in request, user and credential totals exactly once", async (provider) => {
		const userId = `normalized-${provider}`;
		const credentialId = `normalized-credential-${provider}`;
		const handle = startApiRequest({ provider, model: "unknown", userId, credentialId });
		const usage = {
			inputTokens: 200,
			outputTokens: 100,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 50,
		};
		await finishApiRequest(handle, { usage });
		await finishApiRequest(handle, { usage });
		expect(db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get()).toMatchObject({
			...usage,
			tokenAccountingVersion: TOKEN_ACCOUNTING_VERSION,
		});
		expect(
			db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
		).toMatchObject({
			requestCount: 1,
			inputTokens: 200,
			outputTokens: 100,
			cachedInputTokens: 800,
			cacheCreationTokens: 50,
		});
		expect(
			db
				.select()
				.from(credentialUsageTotals)
				.where(eq(credentialUsageTotals.credentialId, credentialId))
				.get(),
		).toMatchObject({
			requestCount: 1,
			inputTokens: 200,
			outputTokens: 100,
			cachedInputTokens: 800,
			cacheCreationTokens: 50,
		});
	});
	test("an API connection without a reported credential is attributed to the connection", async () => {
		const saved = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "conn1234",
				name: "Team relay",
				prefix: "relay",
				apiKey: "k",
				baseUrl: "",
				defaultModel: "",
			},
		];
		try {
			const handle = startApiRequest({ provider: "relay", model: "claude-x", userId: "u" });
			await finishApiRequest(handle, { usage: { inputTokens: 10, outputTokens: 5 } });
			expect(
				db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get(),
			).toMatchObject({ credentialId: "conn1234" });
			expect(
				db
					.select()
					.from(credentialUsageTotals)
					.where(eq(credentialUsageTotals.credentialId, "conn1234"))
					.get(),
			).toMatchObject({ provider: "relay", requestCount: 1 });
			expect(resolveCredentialDisplayName("relay", "conn1234")).toBe("Team relay");
			// Unknown prefixes stay unattributed instead of being guessed.
			const unknown = startApiRequest({ provider: "nowhere", model: "m", userId: "u" });
			await finishApiRequest(unknown, { usage: { inputTokens: 1, outputTokens: 1 } });
			expect(
				db.select().from(apiRequests).where(eq(apiRequests.id, unknown.id)).get()?.credentialId,
			).toBeNull();
		} finally {
			settings.anthropicProviders = saved;
		}
	});

	test("completion persists frozen user and rolls up once, including unknown-cost failures", async () => {
		const userId = "tracker-user-rollup-test";
		const handle = startApiRequest({ provider: "test", model: "unknown", userId });
		try {
			await finishApiRequest(handle, { usage: { inputTokens: 100, outputTokens: 20 } });
			await finishApiRequest(handle, { usage: { inputTokens: 100, outputTokens: 20 } });
			expect(db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get()?.userId).toBe(
				userId,
			);
			expect(
				db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
			).toMatchObject({
				requestCount: 1,
				inputTokens: 100,
				outputTokens: 20,
				unpricedRequestCount: 1,
			});
			const failed = startApiRequest({ provider: "test", model: "unknown", userId });
			await finishApiRequest(failed, { errorMessage: "upstream rejected" });
			expect(
				db.select().from(userUsageTotals).where(eq(userUsageTotals.userId, userId)).get(),
			).toMatchObject({ requestCount: 2, inputTokens: 100, unpricedRequestCount: 2 });
		} finally {
			db.delete(apiRequests).where(eq(apiRequests.userId, userId)).run();
			db.delete(userUsageTotals).where(eq(userUsageTotals.userId, userId)).run();
		}
	});
	test("captures the initiating user before shared options change", () => {
		const options = { provider: "test", model: "test", userId: "alice" };
		const first = startApiRequest(options);
		options.userId = "bob";
		const second = startApiRequest(options);
		expect(first.userId).toBe("alice");
		expect(second.userId).toBe("bob");
	});

	test("unknown initiators stay null even with a narrator", () => {
		expect(
			startApiRequest({ provider: "test", model: "test", narratorId: "shared" }).userId,
		).toBeNull();
		expect(startApiRequest({ provider: "test", model: "test", userId: null }).userId).toBeNull();
	});
});

const { resolveProviderAndModel } = await import("../agent/provider");
const { agentGenerateWithMeta, summaryGenerateWithHistory } = await import("../agent");
const { OpenAIProvider } = await import("../agent/openai-provider");
const { AnthropicProvider } = await import("../agent/anthropic-provider");
const { NugProvider } = await import("../agent/nug-provider");
const { TokenDanceProvider } = await import("../agent/tokendance-provider");

describe("every source reports the credential it used to fall back to", () => {
	type Adapter = import("../agent/provider").ProviderAdapter;
	type Params = import("../agent/provider").ChatParams;
	const usage = { inputTokens: 10, outputTokens: 5 };

	/**
	 * Network-free inner adapters that, as the worst case, report an id of their own on
	 * every path. The outer layer must override it with the real credential.
	 */
	function stubInner(proto: object) {
		const target = proto as Adapter;
		return [
			spyOn(target, "chat").mockImplementation(async function* (params: Params) {
				params.onRequestStart?.({ credentialId: "inner-id" });
				yield { text: "hi", credentialId: "inner-id" };
				yield { usage: { promptTokens: 10, completionTokens: 5 } };
			} as never),
			spyOn(target, "generateWithMeta").mockImplementation((async () => ({
				text: "hi",
				usage,
				credentialId: "inner-id",
			})) as never),
			spyOn(target, "generateWithHistoryWithMeta" as never).mockImplementation((async () => ({
				text: "hi",
				usage,
				credentialId: "inner-id",
			})) as never),
		];
	}

	/** Drive one streamed request the way the agent loop records it. */
	async function streamed(model: string) {
		const resolved = resolveProviderAndModel(model);
		let credentialId: string | undefined;
		let handle: ReturnType<typeof startApiRequest> | undefined;
		const params = {
			signal: new AbortController().signal,
			conversationId: "c1",
			stickySessionKey: "c1",
			model: resolved.model,
			onRequestStart: (info?: { credentialId?: string }) => {
				if (info?.credentialId) credentialId = info.credentialId;
				handle ??= startApiRequest({
					provider: resolved.provider,
					model: resolved.model,
					credentialId,
					userId: "u",
				});
			},
		} as unknown as Params;
		for await (const event of resolved.adapter.chat(params)) {
			if (event.credentialId) credentialId = event.credentialId;
		}
		if (!handle) throw new Error("request never started");
		await finishApiRequest(handle, { credentialId, usage });
		const row = db.select().from(apiRequests).where(eq(apiRequests.id, handle.id)).get();
		return { start: handle.credentialId, end: credentialId, row: row?.credentialId };
	}

	/** Both non-streaming entry points, recorded through trackApiRequest. */
	async function nonStreamed(model: string) {
		const before = db.select().from(apiRequests).all().length;
		await agentGenerateWithMeta("q", model, undefined, undefined, { userId: "u" });
		const savedSummary = settings.agent.summaryModel;
		settings.agent.summaryModel = model;
		try {
			await summaryGenerateWithHistory("s", "q", undefined, { userId: "u" });
		} finally {
			settings.agent.summaryModel = savedSummary;
		}
		return db
			.select()
			.from(apiRequests)
			.all()
			.slice(before)
			.map((row) => row.credentialId);
	}

	async function expectSource(model: string, expected: string, legacy: string | null) {
		// The id the prefix fallback used to pick is exactly what is now reported.
		expect(legacy).toBe(expected);
		expect(await streamed(model)).toEqual({ start: expected, end: expected, row: expected });
		expect(await nonStreamed(model)).toEqual([expected, expected]);
	}

	test("direct connection with one plain key, NUG, TokenDance and Command Code", async () => {
		const spies = [
			...stubInner(OpenAIProvider.prototype),
			...stubInner(AnthropicProvider.prototype),
			...stubInner(NugProvider.prototype),
			...stubInner(TokenDanceProvider.prototype),
			spyOn(NugProvider.prototype, "prepareForModel").mockImplementation(() => {}),
			spyOn(TokenDanceProvider.prototype, "prepareForModel").mockImplementation(() => {}),
		];
		const saved = structuredClone({
			customApiProviders: settings.customApiProviders,
			nugProviders: settings.nugProviders,
			commandCode: settings.commandCode,
		});
		const disposeTokenDance = registerTokenDanceRuntime({
			getTokenDanceRuntimeConfig: () => ({ apiKey: "td", generation: 1, disabled: false }),
			getTokenDanceCatalogModels: () => [],
			assertTokenDanceConnection: () => {},
			registerTokenDanceRequest: () => () => {},
		});
		try {
			saveSettings({
				...settings,
				customApiProviders: [
					{
						id: "directConn",
						name: "Direct",
						prefix: "direct",
						apiKey: "sk-only",
						baseUrl: "https://api.example.com/v1",
						defaultModel: "m",
						protocol: "completions-compatible",
					},
				],
			});
			settings.nugProviders = [
				{
					id: "nugConn",
					name: "Gateway",
					prefix: "gw",
					apiKey: "nug-key",
					baseUrl: "https://nug.example.com",
					defaultModel: "",
				},
			];
			settings.commandCode = { apiKey: "cc-key" };

			await expectSource("direct:m", "directConn", defaultRequestSourceId("direct"));
			await expectSource("gw:openai:m", "nugConn", defaultRequestSourceId("gw"));
			await expectSource("tokendance:m", "tokendance", defaultRequestSourceId("tokendance"));
			await expectSource("CommandCode:gpt-5", "CommandCode", defaultRequestSourceId("CommandCode"));
			await expectSource(
				"CommandCode:claude-sonnet-4",
				"CommandCode",
				defaultRequestSourceId("CommandCode"),
			);
		} finally {
			disposeTokenDance();
			saveSettings({ ...settings, customApiProviders: saved.customApiProviders });
			settings.nugProviders = saved.nugProviders;
			settings.commandCode = saved.commandCode;
			for (const spy of spies) spy.mockRestore();
		}
	});

	test("a pooled connection names the key, not the connection its adapters carry", async () => {
		const spies = stubInner(OpenAIProvider.prototype);
		const saved = structuredClone(settings.customApiProviders);
		try {
			saveSettings({
				...settings,
				customApiProviders: [
					{
						id: "poolConn",
						name: "Pool",
						prefix: "pool",
						apiKey: "sk-one",
						baseUrl: "https://api.example.com/v1",
						defaultModel: "m",
						protocol: "completions-compatible",
					},
				],
			});
			const second = getProviderKeyStore().add("poolConn", { apiKey: "sk-two" });
			getProviderKeyStore().reorder("poolConn", [second.id]);
			expect(await streamed("pool:m")).toEqual({
				start: second.id,
				end: second.id,
				row: second.id,
			});
			expect(await nonStreamed("pool:m")).toEqual([second.id, second.id]);
		} finally {
			saveSettings({ ...settings, customApiProviders: saved });
			getProviderKeyStore().removeProvider("poolConn");
			for (const spy of spies) spy.mockRestore();
		}
	});
});
