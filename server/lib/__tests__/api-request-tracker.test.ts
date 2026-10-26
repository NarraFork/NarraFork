import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiRequests, credentialUsageTotals, userUsageTotals } from "@server/db/schema";
import { TOKEN_ACCOUNTING_VERSION } from "@shared/token-accounting";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("@server/db")) };
mock.module("@server/db", () => ({ ...realDbModule, db, sqlite }));

import {
	DIAGNOSTICS_MAX_BYTES,
	finishApiRequest,
	serializeDiagnostics,
	startApiRequest,
} from "../api-request-tracker";

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
