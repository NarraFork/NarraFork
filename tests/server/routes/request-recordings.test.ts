import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestRecordingDetail, SavedRecording } from "@shared/request-recording";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../../server/lib/app-error-response";
import { resetDbWorkerPoolForTest, shutdownDbWorkerPool } from "../../../server/lib/db-worker/pool";
import { NotFoundError } from "../../../server/lib/errors";
import { WorkerHandle } from "../../../server/lib/worker-runtime/lifecycle";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "narrafork-recording-routes-"));
process.env.NARRAFORK_HOME = home;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
const { createRequestRecordingRoutes, lookupApiRequestMetadata } = await import(
	"../../../server/routes/request-recordings"
);
const { requireNarratorAccess } = await import("../../../server/lib/narrator-access");
const { db } = await import("../../../server/db");
const { aclGrants, apiRequests, narrators, users } = await import("../../../server/db/schema");
const { generateId } = await import("../../../server/lib/id");
const { sqliteAuthSessionStore } = await import(
	"../../../server/services/auth/sqlite-session-store"
);

const OWNER = "recording-owner";
const VIEWER = "recording-viewer";
const STRANGER = "recording-stranger";
const ID = generateId();
const OTHER_ID = generateId();
const SAVE_ID = generateId();
const saved: SavedRecording = {
	id: SAVE_ID,
	narratorId: ID,
	createdAt: new Date().toISOString(),
	requestIds: ["request-a"],
	apiRequestIds: [],
	requestCount: 1,
	bytes: 123,
	partial: true,
	truncated: false,
};

// Execute the real global route gate, rather than replicating its method-to-ACL mapping.
// The recording service boundary is injected; the ACL below uses real database rows.
const narratorSource = await Bun.file(
	new URL("../../../server/routes/narrators.ts", import.meta.url),
).text();
const gateStart = narratorSource.indexOf("const NARRATOR_ID_GATE_EXEMPT_SEGMENTS");
const gateEnd = narratorSource.indexOf("// The bare `/:id` routes", gateStart);
if (gateStart < 0 || gateEnd < 0) throw new Error("Narrator access gate boundaries missing");
const gate = new Bun.Transpiler({ loader: "ts" }).transformSync(
	narratorSource.slice(gateStart, gateEnd),
);

beforeAll(async () => {
	for (const id of [OWNER, VIEWER, STRANGER]) {
		await db.insert(users).values({
			id,
			username: id,
			passwordHash: "unused",
			role: "user",
			createdAt: saved.createdAt,
		});
	}
	for (const id of [ID, OTHER_ID]) {
		await db.insert(narrators).values({
			id,
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: saved.createdAt,
			updatedAt: saved.createdAt,
		});
	}
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: ID,
		principalType: "user",
		principalId: VIEWER,
		capability: "read",
		grantedBy: OWNER,
		createdAt: saved.createdAt,
	});
});

afterAll(async () => {
	await shutdownDbWorkerPool();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

function fixture(
	userId = OWNER,
	lookup: typeof lookupApiRequestMetadata = lookupApiRequestMetadata,
) {
	const save = mock(async (_id: string) => saved);
	const detail: RequestRecordingDetail = {
		requestId: "request-a",
		narratorId: ID,
		provider: "fixture",
		model: "fixture",
		startedAt: saved.createdAt,
		partial: true,
		truncated: false,
		requestPreview: "request",
		responsePreview: "response",
		previewTruncated: { request: false, response: false },
	};
	const getDetail = mock(async (id: string, requestId: string, _signal?: AbortSignal) => {
		if (id !== ID || requestId !== "request-a")
			throw new NotFoundError("Request recording", "request");
		return detail;
	});
	const saveSpecific = mock(async (id: string, requestId: string, _signal?: AbortSignal) => {
		if (id !== ID || requestId !== "request-a")
			throw new NotFoundError("Request recording", "request");
		return saved;
	});
	const list = mock(async (_id: string, _cursor?: string, _limit?: number) => ({
		items: [saved],
		nextCursor: "next-page",
	}));
	const remove = mock(async (id: string, saveId: string) => {
		if (id !== ID || saveId !== SAVE_ID) throw new NotFoundError("Request recording", saveId);
	});
	const download = mock(async (id: string, saveId: string, _signal?: AbortSignal) => {
		if (id !== ID || saveId !== SAVE_ID) throw new NotFoundError("Request recording", saveId);
		return new Response(
			new ReadableStream({
				start: (controller) => {
					controller.enqueue(new TextEncoder().encode("zip bytes"));
					controller.close();
				},
			}),
			{
				headers: {
					"Content-Type": "application/zip",
					"Content-Disposition": 'attachment; filename="recording.zip"',
				},
			},
		);
	});
	const routes = new Hono();
	const workAdmission = mock(async (_id: string, next: () => Promise<void>) => next());
	const bindings = {
		narratorRoutes: routes,
		requireNarratorAccess,
		withNarratorWorkAdmission: workAdmission,
		requireSqliteLazyRefsBackfill: () => {
			throw new Error("Unexpected lineage fallback");
		},
		assertWorkspaceHistoryRevertSupported: () => {
			throw new Error("Unexpected history revert");
		},
	};
	new Function(...Object.keys(bindings), gate)(...Object.values(bindings));
	routes.route(
		"/:id/request-recordings",
		createRequestRecordingRoutes({
			saveRequestRecording: save,
			getRequestRecordingDetail: getDetail,
			lookupApiRequestMetadata: lookup,
			saveSpecificRequestRecording: saveSpecific,
			listSavedRecordings: list,
			deleteSavedRecording: remove,
			downloadSavedRecording: download,
		}),
	);
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: error.message }, 500),
	);
	app.route("/narrators", routes);
	return {
		save,
		list,
		remove,
		download,
		workAdmission,
		getDetail,
		saveSpecific,
		detail,
		request: (method = "GET", suffix = "", narratorId = ID, signal?: AbortSignal) =>
			app.request(`http://localhost/narrators/${narratorId}/request-recordings${suffix}`, {
				method,
				signal,
			}),
	};
}

describe("request recording HTTP contracts and ACL", () => {
	test("precise request detail permits read ACL and forwards cancellation", async () => {
		const f = fixture(VIEWER);
		const controller = new AbortController();
		const response = await f.request("GET", "/requests/request-a", ID, controller.signal);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(f.detail);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(f.getDetail.mock.calls[0]?.slice(0, 2)).toEqual([ID, "request-a"]);
		const signal = f.getDetail.mock.calls[0]?.[2];
		expect(signal).toBeInstanceOf(AbortSignal);
		controller.abort();
		expect(signal?.aborted).toBe(true);
		expect(f.save).not.toHaveBeenCalled();
		expect(f.saveSpecific).not.toHaveBeenCalled();
	});
	test("detail enriches bounded metadata by exact API primary key and same narrator only", async () => {
		const apiId = generateId();
		const foreignApiId = generateId();
		await db.insert(apiRequests).values([
			{
				id: apiId,
				narratorId: ID,
				createdAt: saved.createdAt,
				durationMs: 1234,
				ttftMs: 56,
				errorMessage: `failed /home/private-account/private.dump ${"中".repeat(5000)}`,
				diagnosticsJson: "DO_NOT_EXPOSE_RAW_DUMP",
			},
			{
				id: foreignApiId,
				narratorId: OTHER_ID,
				createdAt: saved.createdAt,
				durationMs: 999,
				ttftMs: 999,
				errorMessage: "foreign error",
				diagnosticsJson: "FOREIGN_DUMP",
			},
		]);
		const lookup = mock(lookupApiRequestMetadata);
		const f = fixture(VIEWER, lookup);
		f.detail.apiRequestId = apiId;
		const controller = new AbortController();
		const response = await f.request("GET", "/requests/request-a", ID, controller.signal);
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.apiRequest).toMatchObject({
			id: apiId,
			createdAt: saved.createdAt,
			durationMs: 1234,
			ttftMs: 56,
		});
		expect(result.apiRequest.errorMessage).not.toContain("private-account");
		expect(Buffer.byteLength(result.apiRequest.errorMessage)).toBeLessThanOrEqual(2048);
		expect(result.apiRequest.rawDumpJson).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE_RAW_DUMP");
		expect(lookup).toHaveBeenCalledWith(ID, apiId, expect.any(AbortSignal));
		const metadataSignal = lookup.mock.calls[0]?.[2];
		controller.abort();
		expect(metadataSignal?.aborted).toBe(true);
		f.detail.apiRequestId = foreignApiId;
		const foreign = await (await f.request("GET", "/requests/request-a")).json();
		expect(foreign.apiRequest).toBeUndefined();
		expect(foreign.requestPreview).toBe("request");
		expect(lookup).toHaveBeenCalledWith(ID, foreignApiId, expect.any(AbortSignal));
		f.detail.apiRequestId = generateId();
		expect(
			(await (await f.request("GET", "/requests/request-a")).json()).apiRequest,
		).toBeUndefined();
		delete f.detail.apiRequestId;
		lookup.mockClear();
		await f.request("GET", "/requests/request-a");
		expect(lookup).not.toHaveBeenCalled();
	});
	test("file-backed metadata fails explicitly without a short-read Worker", async () => {
		const apiId = generateId();
		await db.insert(apiRequests).values({ id: apiId, narratorId: ID, createdAt: saved.createdAt });
		const f = fixture();
		f.detail.apiRequestId = apiId;
		const previous = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			const response = await f.request("GET", "/requests/request-a");
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ code: "DATABASE_READ_UNAVAILABLE" });
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
	test("a recording burst leaves room for auth and an aborted lookup never dispatches", async () => {
		await resetDbWorkerPoolForTest();
		const apiId = generateId();
		await db.insert(apiRequests).values({ id: apiId, narratorId: ID, createdAt: saved.createdAt });
		const firstDispatch = Promise.withResolvers<void>();
		const dispatchGate = Promise.withResolvers<void>();
		const sendOrder: string[] = [];
		const aclReads: string[] = [];
		const create = WorkerHandle.thread;
		const spawn = spyOn(WorkerHandle, "thread").mockImplementation((entry, options) => {
			const handle = create(entry, options);
			const send = handle.resource.postMessage.bind(handle.resource);
			spyOn(handle.resource, "postMessage").mockImplementation((message) => {
				if (message.type === "task") {
					const sql = message.params.sql;
					if (sql.includes('"api_requests"')) sendOrder.push("recording");
					else if (sql.includes('"users"')) sendOrder.push("auth");
					else aclReads.push(sql);
					if (sendOrder.length === 1 && aclReads.length === 0) {
						firstDispatch.resolve();
						void dispatchGate.promise.then(() => send(message));
						return;
					}
				}
				send(message);
			});
			return handle;
		});
		const jobs: Promise<unknown>[] = [];
		const record = <T>(job: Promise<T>): Promise<T> => {
			jobs.push(job.catch(() => {}));
			return job;
		};
		try {
			const first = record(lookupApiRequestMetadata(ID, apiId));
			await Promise.race([firstDispatch.promise, first]);
			const controller = new AbortController();
			const cancelled = record(lookupApiRequestMetadata(ID, apiId, controller.signal));
			const queued = Array.from({ length: 3 }, () => record(lookupApiRequestMetadata(ID, apiId)));
			const auth = record(
				Promise.all([
					sqliteAuthSessionStore.findSessionState(OWNER),
					sqliteAuthSessionStore.findSessionState(VIEWER),
				]),
			);
			const f = fixture();
			f.detail.apiRequestId = apiId;
			const overflow = await f.request("GET", "/requests/request-a");
			expect(overflow.status).toBe(503);
			expect(await overflow.json()).toMatchObject({ code: "DATABASE_READ_UNAVAILABLE" });

			controller.abort();
			await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
			dispatchGate.resolve();
			expect(await auth).toMatchObject([{ id: OWNER }, { id: VIEWER }]);
			await Promise.all([first, ...queued]);
			expect(aclReads).toHaveLength(1);
			expect(aclReads[0]).toContain('"narrators"');
			expect(sendOrder).toEqual([
				"recording",
				"auth",
				"auth",
				"recording",
				"recording",
				"recording",
			]);
		} finally {
			dispatchGate.resolve();
			await Promise.all(jobs);
			await resetDbWorkerPoolForTest();
			spawn.mockRestore();
		}
	}, 12_000);
	test("read-only viewers can reuse existing exact completed evidence without a save call", async () => {
		const f = fixture(VIEWER);
		f.detail.savedRecording = { ...saved, partial: false };
		const result = await (await f.request("GET", "/requests/request-a")).json();
		expect(result.savedRecording.id).toBe(SAVE_ID);
		expect((await f.request("GET", `/${result.savedRecording.id}/download`)).status).toBe(200);
		expect(f.saveSpecific).not.toHaveBeenCalled();
	});
	test("precise save is write gated and never invokes narrator-window save", async () => {
		const f = fixture();
		const response = await f.request("POST", "/requests/request-a");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(saved);
		expect(f.saveSpecific.mock.calls[0]?.slice(0, 2)).toEqual([ID, "request-a"]);
		expect(f.saveSpecific.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
		expect(f.save).not.toHaveBeenCalled();
		for (const userId of [VIEWER, STRANGER]) {
			const denied = fixture(userId);
			expect((await denied.request("POST", "/requests/request-a")).status).toBe(404);
			expect(denied.saveSpecific).not.toHaveBeenCalled();
		}
	});
	test("missing, cross-narrator and unauthorized precise requests are hidden", async () => {
		for (const method of ["GET", "POST"]) {
			const f = fixture();
			expect((await f.request(method, "/requests/missing")).status).toBe(404);
			expect((await f.request(method, "/requests/request-a", OTHER_ID)).status).toBe(404);
			expect((await fixture(STRANGER).request(method, "/requests/request-a")).status).toBe(404);
		}
	});
	test("malformed request identifiers are hidden before recorder access", async () => {
		for (const requestId of ["%00", "x".repeat(513)]) {
			const f = fixture();
			for (const method of ["GET", "POST"])
				expect((await f.request(method, `/requests/${requestId}`)).status).toBe(404);
			expect(f.getDetail).not.toHaveBeenCalled();
			expect(f.saveSpecific).not.toHaveBeenCalled();
		}
	});
	test("save returns SavedRecording directly with write access", async () => {
		const f = fixture();
		const response = await f.request("POST");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(saved);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(f.save).toHaveBeenCalledWith(ID);
	});
	test.each([VIEWER, STRANGER])("%s cannot create or delete bundles", async (userId) => {
		const f = fixture(userId);
		expect((await f.request("POST")).status).toBe(404);
		expect((await f.request("DELETE", `/${SAVE_ID}`)).status).toBe(404);
		expect(f.save).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
		expect(f.workAdmission).not.toHaveBeenCalled();
	});
	test("read grant permits listing and streaming download", async () => {
		const f = fixture(VIEWER);
		const response = await f.request("GET", "?cursor=previous-page&limit=3");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [saved], nextCursor: "next-page" });
		expect(f.list).toHaveBeenCalledWith(ID, "previous-page", 3);
		const zip = await f.request("GET", `/${SAVE_ID}/download`);
		expect(zip.status).toBe(200);
		expect(zip.headers.get("content-type")).toBe("application/zip");
		expect(await zip.text()).toBe("zip bytes");
		expect(f.download.mock.calls[0]?.[0]).toBe(ID);
		expect(f.download.mock.calls[0]?.[1]).toBe(SAVE_ID);
		expect(f.download.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
		expect(f.workAdmission).not.toHaveBeenCalled();
	});
	test("download receives client abort so archive work can be cancelled", async () => {
		const f = fixture(VIEWER);
		const controller = new AbortController();
		expect((await f.request("GET", `/${SAVE_ID}/download`, ID, controller.signal)).status).toBe(
			200,
		);
		const signal = f.download.mock.calls[0]?.[2];
		expect(signal?.aborted).toBe(false);
		controller.abort();
		expect(signal?.aborted).toBe(true);
	});
	test("private recordings and missing narrators are hidden", async () => {
		const f = fixture(STRANGER);
		expect((await f.request()).status).toBe(404);
		expect((await f.request("GET", `/${SAVE_ID}/download`)).status).toBe(404);
		expect((await fixture().request("GET", "", generateId())).status).toBe(404);
		expect(f.list).not.toHaveBeenCalled();
		expect(f.download).not.toHaveBeenCalled();
	});
	test("delete returns ok without exposing internal paths", async () => {
		const f = fixture();
		const response = await f.request("DELETE", `/${SAVE_ID}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(f.remove).toHaveBeenCalledWith(ID, SAVE_ID);
	});
	test.each([
		"bad!id",
		"a".repeat(22),
		"%2e%2e%2fprivate",
	])("malformed saveId %s is 404 before storage access", async (saveId) => {
		const f = fixture();
		expect((await f.request("GET", `/${saveId}/download`)).status).toBe(404);
		expect((await f.request("DELETE", `/${saveId}`)).status).toBe(404);
		expect(f.download).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});
	test("missing bundle and a bundle owned by another narrator are both 404", async () => {
		const f = fixture();
		for (const method of ["GET", "DELETE"]) {
			const ending = method === "GET" ? "/download" : "";
			expect((await f.request(method, `/${generateId()}${ending}`)).status).toBe(404);
			expect((await f.request(method, `/${SAVE_ID}${ending}`, OTHER_ID)).status).toBe(404);
		}
	});
	test.each([
		"0",
		"101",
		"-1",
		"1.5",
		"NaN",
		"",
		"Infinity",
	])("rejects unbounded or malformed limit %s", async (limit) => {
		const f = fixture();
		expect((await f.request("GET", `?limit=${limit}`)).status).toBe(400);
		expect(f.list).not.toHaveBeenCalled();
	});
	test("default pagination is bounded and malformed cursors are rejected", async () => {
		const f = fixture();
		expect((await f.request()).status).toBe(200);
		expect(f.list).toHaveBeenCalledWith(ID, undefined, 20);
		f.list.mockClear();
		for (const cursor of ["", "a".repeat(257), "%00"]) {
			expect((await f.request("GET", `?cursor=${cursor}`)).status).toBe(400);
		}
		expect(f.list).not.toHaveBeenCalled();
	});
});
