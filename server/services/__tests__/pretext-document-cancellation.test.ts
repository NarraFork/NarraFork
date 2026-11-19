import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Initialize the service before its message module's existing import cycle.
const { narratorService } = await import("../narrator-service");
const { narratorRoutes } = await import("../../routes/narrators");
const NOW = "2026-10-01T00:00:00.000Z";
const URL = "http://localhost/api/narrators/n1/pretext-document";

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('viewer', 'viewer', 'test-only', 'user', ?)",
		[NOW],
	);
	sqlite.run(
		"INSERT INTO narrators (id, owner_user_id, visibility, created_at, updated_at) VALUES ('n1', 'viewer', 'private', ?, ?)",
		[NOW, NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('m1', 'n1', 'assistant', ?, ?)",
		[JSON.stringify([{ type: "text", text: "WAL history" }]), NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('ref-m1', 'n1', 'm1', 1)",
	);
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.restore();
	mock.module("../../db", () => realDbModule);
	await fixture.close();
});

function appForViewer() {
	const failures: Error[] = [];
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "viewer", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error, c) => {
		failures.push(error);
		return (
			buildAppErrorResponse(error, c) ??
			c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500)
		);
	});
	app.route("/api/narrators", narratorRoutes);
	return { app, failures };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type Stage = "initial-reference" | "display" | "final-reference";

/** Pause at a real pool boundary; cancellation still comes from the production pool. */
function gateRead(stage: Stage) {
	const run = pool.runReadTask;
	const entered = deferred();
	const released = deferred();
	const settled = deferred();
	let signal: AbortSignal | undefined;
	let failure: unknown;
	let refs = 0;
	let displays = 0;
	let matched = false;
	const spy = spyOn(pool, "runReadTask").mockImplementation(
		async <T>(...args: Parameters<typeof run>): Promise<T> => {
			const [, params, options] = args;
			const isRefs = params.kind === "domainRead" && params.task === "narratorAggregateRefs";
			const isDisplay = params.kind === "displayPageMessages";
			if (isRefs) refs++;
			if (isDisplay) displays++;
			const selected =
				(stage === "initial-reference" && isRefs && refs === 1) ||
				(stage === "display" && isDisplay && displays === 1) ||
				(stage === "final-reference" && isRefs && refs === 2);
			if (!selected) return run<T>(...args);
			matched = true;
			signal = options?.signal;
			entered.resolve();
			await released.promise;
			try {
				return await run<T>(...args);
			} catch (error) {
				failure = error;
				throw error;
			} finally {
				settled.resolve();
			}
		},
	);
	return {
		spy,
		release: released.resolve,
		async waitForEntry(response: Promise<Response>) {
			await Promise.race([
				entered.promise,
				response.then((result) => {
					throw new Error(`Request settled before ${stage} gate: ${result.status}`);
				}),
			]);
		},
		async waitForSettlement() {
			if (matched) await settled.promise;
		},
		state: () => ({ signal, failure, refs, displays }),
	};
}

async function expectHealthyPage(app: ReturnType<typeof appForViewer>["app"]) {
	const response = await app.request(URL);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ protocol: 2, messages: [{ id: "m1" }] });
	expect(sqlite.inTransaction).toBe(false);
}

describe("pretext document request cancellation", () => {
	test("an already cancelled request retains the display cancellation contract", async () => {
		const { app } = appForViewer();
		const service = spyOn(narratorService, "getPretextDocumentPage");
		const reads = spyOn(pool, "runReadTask");
		const controller = new AbortController();
		controller.abort(new Error("PRIVATE_CLIENT_REASON"));
		const request = new Request(URL, { signal: controller.signal });
		const response = await app.request(request);
		expect(service.mock.calls[0]?.[1]?.signal).toBe(request.signal);
		expect(response.status).toBe(499);
		expect(await response.json()).toEqual({
			error: "History display read was cancelled",
			code: "DISPLAY_PAGE_CANCELLED",
		});
		expect(
			reads.mock.calls.some(
				([, params]) =>
					params.kind === "displayPageMessages" ||
					(params.kind === "domainRead" && params.task === "narratorAggregateRefs"),
			),
		).toBe(false);
		await expectHealthyPage(app);
	}, 30_000);

	for (const stage of ["initial-reference", "display", "final-reference"] as const) {
		test(`${stage} cancellation maps the real pool rejection to 499`, async () => {
			const { app, failures } = appForViewer();
			const controller = new AbortController();
			const request = new Request(URL, { signal: controller.signal });
			const gate = gateRead(stage);
			const response = Promise.resolve(app.request(request));
			try {
				await gate.waitForEntry(response);
				const before = gate.state();
				expect(before.signal?.aborted).toBe(false);
				if (stage !== "display") expect(before.signal).toBe(request.signal);
				expect(before.refs).toBe(stage === "final-reference" ? 2 : 1);
				expect(before.displays).toBe(stage === "initial-reference" ? 0 : 1);
				controller.abort(new Error("PRIVATE_CLIENT_REASON"));
				expect(before.signal?.aborted).toBe(true);
				gate.release();
				const result = await response;
				await gate.waitForSettlement();
				expect(gate.state().failure).toMatchObject({ code: "DB_READ_ABORTED" });
				expect(gate.state().refs).toBe(before.refs);
				expect(gate.state().displays).toBe(before.displays);
				expect(result.status).toBe(499);
				expect(await result.json()).toEqual({
					error: "History display read was cancelled",
					code: "DISPLAY_PAGE_CANCELLED",
				});
				expect(failures).toHaveLength(1);
			} finally {
				controller.abort();
				gate.release();
				await response;
				await gate.waitForSettlement();
				gate.spy.mockRestore();
			}
			await expectHealthyPage(app);
		}, 30_000);
	}

	test("reference withdrawal after display retains the worker's authorization failure", async () => {
		const { app } = appForViewer();
		const gate = gateRead("final-reference");
		const response = Promise.resolve(app.request(URL));
		try {
			await gate.waitForEntry(response);
			sqlite.run("DELETE FROM narrator_message_refs WHERE id = 'ref-m1'");
			gate.release();
			const result = await response;
			await gate.waitForSettlement();
			expect(gate.state().failure).toMatchObject({
				statusCode: 409,
				code: "HISTORY_AGGREGATE_UNAVAILABLE",
			});
			expect(result.status).toBe(409);
			expect(await result.json()).toMatchObject({ code: "HISTORY_AGGREGATE_UNAVAILABLE" });
			expect(gate.state().refs).toBe(2);
		} finally {
			gate.release();
			await response;
			await gate.waitForSettlement();
			gate.spy.mockRestore();
		}
	}, 30_000);

	for (const entry of [
		{ code: undefined, status: 500, wireCode: "INTERNAL_ERROR" },
		{ code: "DB_READ_FAILED", status: 500, wireCode: "INTERNAL_ERROR" },
		{ code: "DB_READ_BUDGET", status: 500, wireCode: "INTERNAL_ERROR" },
		{ code: "DB_READ_TASK_TIMEOUT", status: 503, wireCode: "DB_READ_TASK_TIMEOUT" },
	]) {
		test(`snapshot failure ${entry.code ?? "Error"} is preserved even if the request is cancelled`, async () => {
			const { app, failures } = appForViewer();
			const controller = new AbortController();
			const failure = Object.assign(
				new Error("PRIVATE_READER_FAILURE"),
				entry.code ? { code: entry.code } : {},
			);
			const run = pool.runReadTask;
			let snapshotCalls = 0;
			spyOn(pool, "runReadTask").mockImplementation(
				async <T>(...args: Parameters<typeof run>): Promise<T> => {
					const [, params] = args;
					if (params.kind === "domainRead" && params.task === "narratorAggregateRefs") {
						snapshotCalls++;
						controller.abort();
						throw failure;
					}
					return run<T>(...args);
				},
			);
			const response = await app.request(new Request(URL, { signal: controller.signal }));
			expect(response.status).toBe(entry.status);
			expect(await response.json()).toMatchObject({ code: entry.wireCode });
			expect(failures).toHaveLength(1);
			expect(failures[0]).toBe(failure);
			expect(snapshotCalls).toBe(1);
		}, 30_000);
	}

	test("malformed display JSON keeps its explicit 500 error code", async () => {
		const { app, failures } = appForViewer();
		const reads = spyOn(pool, "runReadTask");
		// Replay JSON is stored as text; the display worker performs its JSON decoding.
		sqlite.run(
			"UPDATE narrator_messages SET original_content_json = 'PRIVATE_INVALID_JSON' WHERE id = 'm1'",
		);
		const response = await app.request(URL);
		expect(reads.mock.calls.some(([, params]) => params.kind === "displayPageMessages")).toBe(true);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Invalid stored display JSON: originalContentJson",
			code: "DISPLAY_PAGE_INVALID_JSON",
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ statusCode: 500, code: "DISPLAY_PAGE_INVALID_JSON" });
	}, 30_000);
});
