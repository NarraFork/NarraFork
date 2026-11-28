import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { type AppEnv, app } from "../../app";
import { db } from "../../db";
import { authSessions, users } from "../../db/schema";
import { toErrorPayload } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import { DbReadError, readAborted } from "../../lib/db-worker/errors";
import { attachDbReadAbortDiagnostics } from "../../lib/db-worker/read-diagnostics";
import { catalogError } from "../../lib/errors";
import * as idFactory from "../../lib/id";
import { logger } from "../../lib/logger";
import { authSessionStore } from "../../services/auth/store";

const probePath = "/api/__client-abort-probe";
type ProbeHandler = (c: Context<AppEnv>) => Response | Promise<Response>;
const probeHandlers = new Map<string, ProbeHandler>();

// A handler that surfaces its request's abort, as Git routes do when a client switches narrators.
app.get(probePath, (c) => {
	c.req.raw.signal.throwIfAborted();
	throw new Error("probe failure");
});
app.all(`${probePath}/*`, (c) => {
	const handler = probeHandlers.get(c.req.path);
	if (!handler) throw new Error("Missing probe handler");
	return handler(c);
});

const userId = idFactory.generateId();
let authorization = "";
beforeAll(async () => {
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "unused",
			createdAt: new Date().toISOString(),
		})
		.run();
	authorization = `Bearer ${await createToken(userId)}`;
	const session = db.select().from(authSessions).where(eq(authSessions.userId, userId)).get();
	if (!session) throw new Error("Missing probe session");
	// Keep the actual app/auth chain while making this HTTP error-boundary fixture independent
	// of reader scheduling and its clock. The session facts come from the issued test token.
	sessionLookup.mockImplementation(async (tokenHash) =>
		tokenHash === session.tokenHash
			? {
					...session,
					role: "user",
					userTokenVersion: 0,
					sessionTokenVersion: session.tokenVersion,
				}
			: null,
	);
});
afterAll(() => {
	db.delete(users).where(eq(users.id, userId)).run();
	errors.mockRestore();
	warnings.mockRestore();
	debug.mockRestore();
	sessionLookup.mockRestore();
});

const sessionLookup = spyOn(authSessionStore, "findSessionByTokenHash");
const errors = spyOn(logger, "error").mockImplementation(() => {});
const warnings = spyOn(logger, "warn").mockImplementation(() => {});
const debug = spyOn(logger, "debug").mockImplementation(() => {});
let restoreClock: (() => void) | undefined;
afterEach(() => {
	errors.mockClear();
	warnings.mockClear();
	debug.mockClear();
	probeHandlers.clear();
	restoreClock?.();
	restoreClock = undefined;
});

function probe(signal?: AbortSignal) {
	return app.request(`http://localhost${probePath}`, {
		headers: { authorization },
		signal,
	});
}

function createProbe(handler: ProbeHandler, path = `${probePath}/${idFactory.generateId()}`) {
	probeHandlers.set(path, handler);
	return {
		path,
		request(init: RequestInit = {}, query = "") {
			const headers = new Headers(init.headers);
			headers.set("authorization", authorization);
			return app.request(`http://localhost${path}${query}`, { ...init, headers });
		},
	};
}

function logFields(
	calls: Array<[string, Record<string, unknown>?]>,
	message: string,
): Record<string, unknown> {
	const matching = calls.filter(([loggedMessage]) => loggedMessage === message);
	expect(matching).toHaveLength(1);
	return matching[0]?.[1] ?? {};
}

function expectRequestFields(
	fields: Record<string, unknown>,
	path: string,
	requestAborted = false,
) {
	expect(fields.httpRequestId).toEqual(expect.any(String));
	expect(String(fields.httpRequestId)).toHaveLength(21);
	expect(fields).toMatchObject({ method: "GET", path, requestAborted });
	expect(fields.durationMs).toEqual(expect.any(Number));
	expect(Number(fields.durationMs)).toBeGreaterThanOrEqual(0);
}

function fakeClock() {
	let now = 100;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	restoreClock = () => clock.mockRestore();
	return { advance: (milliseconds: number) => (now += milliseconds) };
}

test("an abort from a client that went away keeps 499 and the debug-only log", async () => {
	const controller = new AbortController();
	controller.abort();
	const response = await probe(controller.signal);
	expect(response.status).toBe(499);
	expect(await response.text()).toBe("");
	expect(errors).not.toHaveBeenCalled();
	const fields = logFields(debug.mock.calls, "Request aborted by client");
	expectRequestFields(fields, probePath, true);
	expect(fields.error).toContain("AbortError");
});

test("ordinary failures keep their generic 500 response and original error and stack", async () => {
	const error = new Error("probe failure");
	const fixture = createProbe(() => {
		throw error;
	});
	const response = await fixture.request();
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
	const fields = logFields(errors.mock.calls, "Unhandled error");
	expectRequestFields(fields, fixture.path);
	expect(fields.error).toBe(String(error));
	expect(fields.stack).toBe(error.stack);
	expect(fields).not.toHaveProperty("errorCode");
	expect(fields).not.toHaveProperty("dbRead");
	expect(debug).not.toHaveBeenCalled();
});

test("AbortError without an aborted HTTP signal remains a server error", async () => {
	const fixture = createProbe(() => {
		throw new DOMException("operation cancelled", "AbortError");
	});
	const response = await fixture.request();
	expect(response.status).toBe(500);
	expectRequestFields(logFields(errors.mock.calls, "Unhandled error"), fixture.path);
	expect(debug).not.toHaveBeenCalled();
});

for (const requestAborted of [false, true]) {
	test(`DB_READ_ABORTED retains 500 when the HTTP signal is aborted=${requestAborted}`, async () => {
		const error = Object.assign(readAborted(), {
			taskId: "untrusted-task-id",
			phase: "running",
			dbRead: { taskId: "untrusted-task-id", kind: "selectRows", phase: "running" },
		});
		const fixture = createProbe(() => {
			throw error;
		});
		const controller = new AbortController();
		if (requestAborted) controller.abort();
		const response = await fixture.request({ signal: controller.signal });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
		const fields = logFields(errors.mock.calls, "Unhandled error");
		expectRequestFields(fields, fixture.path, requestAborted);
		expect(fields.errorCode).toBe("DB_READ_ABORTED");
		expect(fields).not.toHaveProperty("dbRead");
		expect(fields).not.toHaveProperty("taskId");
		expect(debug).not.toHaveBeenCalled();
	});
}

test("database abort logs include the host-owned task diagnostic snapshot", async () => {
	const error = readAborted();
	const dbRead = {
		taskId: "dbr-1-2",
		kind: "domainRead" as const,
		domainTask: "readerProbe" as const,
		phase: "running" as const,
	};
	attachDbReadAbortDiagnostics(error, dbRead);
	const fixture = createProbe(() => {
		throw error;
	});
	const response = await fixture.request();
	expect(response.status).toBe(500);
	const fields = logFields(errors.mock.calls, "Unhandled error");
	expectRequestFields(fields, fixture.path);
	expect(fields.errorCode).toBe("DB_READ_ABORTED");
	expect(fields.dbRead).toEqual(dbRead);
});

test("new log fields exclude request secrets and arbitrary error or task properties", async () => {
	const clock = fakeClock();
	const privateDetail = "private-sql-bind-reason-db-path";
	const error = Object.assign(new DbReadError("DB_READ_ABORTED", privateDetail), {
		sql: `SELECT * FROM private_table WHERE token = '${privateDetail}'`,
		binds: [privateDetail],
		reason: privateDetail,
		dbPath: privateDetail,
		httpRequestId: "client-private-request-id",
	});
	const dbRead = { taskId: "dbr-3-4", kind: "selectRows" as const, phase: "queued" as const };
	attachDbReadAbortDiagnostics(
		error,
		Object.assign({}, dbRead, {
			sql: error.sql,
			params: error.binds,
			dbPath: privateDetail,
			source: privateDetail,
			reason: privateDetail,
		}),
	);
	const fixture = createProbe(() => {
		clock.advance(12.345);
		throw error;
	});
	const response = await fixture.request(
		{
			method: "POST",
			headers: {
				"x-request-id": "client-private-request-id",
				"x-private-header": "private-header-value",
				cookie: "private-cookie-value",
				"content-type": "application/json",
			},
			body: JSON.stringify({ token: "private-body-value" }),
		},
		"?token=private-query-token&sql=private-query-sql",
	);
	expect(response.status).toBe(500);
	const fields = logFields(errors.mock.calls, "Unhandled error");
	const { error: originalError, stack: originalStack, ...addedFields } = fields;
	expect(originalError).toBe(String(error));
	expect(originalStack).toBe(error.stack);
	expect(addedFields).toEqual({
		httpRequestId: expect.any(String),
		method: "POST",
		path: fixture.path,
		requestAborted: false,
		durationMs: 12.35,
		errorCode: "DB_READ_ABORTED",
		dbRead,
	});
	const serialized = JSON.stringify(addedFields);
	for (const secret of [
		privateDetail,
		authorization,
		"client-private-request-id",
		"private-header-value",
		"private-cookie-value",
		"private-body-value",
		"private-query-token",
		"private-query-sql",
		"http://localhost",
	]) {
		expect(serialized).not.toContain(secret);
	}
});

test("slow and error logs share one request ID and the genuine elapsed time", async () => {
	const clock = fakeClock();
	const fixture = createProbe(() => {
		clock.advance(1_234.567);
		throw new Error("slow probe failure");
	});
	const response = await fixture.request({ headers: { "x-request-id": "client-chosen-id" } });
	expect(response.status).toBe(500);
	const unhandled = logFields(errors.mock.calls, "Unhandled error");
	const slow = logFields(warnings.mock.calls, "Slow API request");
	expectRequestFields(unhandled, fixture.path);
	expectRequestFields(slow, fixture.path);
	expect(unhandled.httpRequestId).not.toBe("client-chosen-id");
	expect(slow.httpRequestId).toBe(unhandled.httpRequestId);
	expect(unhandled.durationMs).toBe(1_234.57);
	expect(slow).toMatchObject({ status: 500, durationMs: 1_234.57, stalledMs: 0, maxStallMs: 0 });
});

test("successful slow requests keep a single slow log with the same request fields", async () => {
	const clock = fakeClock();
	const fixture = createProbe((c) => {
		clock.advance(1_010);
		return c.body(null, 204);
	});
	const response = await fixture.request({}, "?token=private-success-token");
	expect(response.status).toBe(204);
	const slow = logFields(warnings.mock.calls, "Slow API request");
	expectRequestFields(slow, fixture.path);
	expect(slow).toMatchObject({ status: 204, durationMs: 1_010 });
	expect(errors).not.toHaveBeenCalled();
	expect(debug).not.toHaveBeenCalled();
	expect(JSON.stringify(slow)).not.toContain("private-success-token");
});

test("fast successful requests do not gain per-request logs", async () => {
	fakeClock();
	const fixture = createProbe((c) => c.body(null, 204));
	const response = await fixture.request();
	expect(response.status).toBe(204);
	expect(errors).not.toHaveBeenCalled();
	expect(warnings).not.toHaveBeenCalled();
	expect(debug).not.toHaveBeenCalled();
});

test("request ID factory failures preserve successful responses and available slow-log fields", async () => {
	const clock = fakeClock();
	const fixture = createProbe((c) => {
		clock.advance(1_250);
		return c.json({ ok: true });
	});
	const ids = spyOn(idFactory, "generateId").mockImplementation(() => {
		throw new Error("request ID factory failed");
	});
	try {
		const response = await fixture.request({ headers: { "x-request-id": "client-chosen-id" } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(ids).toHaveBeenCalledTimes(1);
		const fields = logFields(warnings.mock.calls, "Slow API request");
		expect(fields).toMatchObject({
			method: "GET",
			path: fixture.path,
			requestAborted: false,
			durationMs: 1_250,
			status: 200,
		});
		expect(fields).not.toHaveProperty("httpRequestId");
		expect(errors).not.toHaveBeenCalled();
		expect(debug).not.toHaveBeenCalled();
	} finally {
		ids.mockRestore();
	}
});

test("request ID factory failures preserve the original unhandled error and 500 response", async () => {
	const clock = fakeClock();
	const error = new Error("original probe failure");
	const fixture = createProbe(() => {
		clock.advance(25.5);
		throw error;
	});
	const ids = spyOn(idFactory, "generateId").mockImplementation(() => {
		throw new Error("request ID factory failed");
	});
	try {
		const response = await fixture.request({ headers: { "x-request-id": "client-chosen-id" } });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
		expect(ids).toHaveBeenCalledTimes(1);
		const fields = logFields(errors.mock.calls, "Unhandled error");
		expect(fields).toMatchObject({
			method: "GET",
			path: fixture.path,
			requestAborted: false,
			durationMs: 25.5,
			error: String(error),
			stack: error.stack,
		});
		expect(fields).not.toHaveProperty("httpRequestId");
		expect(debug).not.toHaveBeenCalled();
	} finally {
		ids.mockRestore();
	}
});

test("concurrent requests keep separate IDs and signals even when sharing one frozen error", async () => {
	const error = readAborted();
	attachDbReadAbortDiagnostics(error, {
		taskId: "dbr-5-6",
		kind: "selectRows",
		phase: "running",
	});
	Object.freeze(error);
	const originalKeys = Reflect.ownKeys(error);
	const gate = Promise.withResolvers<void>();
	let entered = 0;
	const handler: ProbeHandler = async () => {
		if (++entered === 2) gate.resolve();
		await gate.promise;
		throw error;
	};
	const first = createProbe(handler);
	const second = createProbe(handler);
	const controller = new AbortController();
	controller.abort();
	const responses = await Promise.all([
		first.request({ method: "POST" }),
		second.request({ method: "PATCH", signal: controller.signal }),
	]);
	expect(responses.map((response) => response.status)).toEqual([500, 500]);
	const logs = errors.mock.calls.filter(([message]) => message === "Unhandled error");
	expect(logs).toHaveLength(2);
	const firstFields = logs.find(([, fields]) => fields?.path === first.path)?.[1];
	const secondFields = logs.find(([, fields]) => fields?.path === second.path)?.[1];
	expect(firstFields).toMatchObject({ method: "POST", path: first.path, requestAborted: false });
	expect(secondFields).toMatchObject({ method: "PATCH", path: second.path, requestAborted: true });
	expect(firstFields?.httpRequestId).toEqual(expect.any(String));
	expect(secondFields?.httpRequestId).toEqual(expect.any(String));
	expect(firstFields?.httpRequestId).not.toBe(secondFields?.httpRequestId);
	expect(firstFields?.dbRead).toEqual(secondFields?.dbRead);
	expect(Reflect.ownKeys(error)).toEqual(originalKeys);
	expect(debug).not.toHaveBeenCalled();
});

test("known database service-unavailable errors keep 503 without adding error logs", async () => {
	fakeClock();
	const fixture = createProbe(() => {
		throw new DbReadError("DB_READ_BUSY", "private database detail");
	});
	const response = await fixture.request();
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")),
		code: "DB_READ_BUSY",
	});
	expect(response.headers.get("retry-after")).toBe("5");
	expect(errors).not.toHaveBeenCalled();
	expect(warnings).not.toHaveBeenCalled();
	expect(debug).not.toHaveBeenCalled();
});

test("early middleware failures have independent IDs without a fabricated duration", async () => {
	fakeClock();
	const ids: unknown[] = [];
	for (let index = 0; index < 2; index++) {
		const request = new Request(`http://localhost${probePath}?token=private-early-token`, {
			method: "PUT",
		});
		// The real CORS middleware reads Origin before reaching the API timing middleware.
		const headers = spyOn(request.headers, "get").mockImplementation(() => {
			throw new Error("early middleware failure");
		});
		try {
			const response = await app.fetch(request);
			expect(response.status).toBe(500);
			const fields = logFields(errors.mock.calls, "Unhandled error");
			expect(fields).toMatchObject({
				httpRequestId: expect.any(String),
				method: "PUT",
				path: probePath,
				requestAborted: false,
			});
			expect(fields).not.toHaveProperty("durationMs");
			expect(JSON.stringify(fields)).not.toContain("private-early-token");
			ids.push(fields.httpRequestId);
		} finally {
			headers.mockRestore();
			errors.mockClear();
		}
	}
	expect(ids[0]).not.toBe(ids[1]);
	expect(warnings).not.toHaveBeenCalled();
});

test("request method and pathname fields have fixed upper bounds", async () => {
	const longPath = `${probePath}/${"x".repeat(4_096)}`;
	const fixture = createProbe(() => {
		throw new Error("bounded probe failure");
	}, longPath);
	const request = new Request(`http://localhost${fixture.path}`, { headers: { authorization } });
	// Bun normalizes unknown methods to GET; supply the raw token to exercise the log bound.
	Object.defineProperty(request, "method", { value: "X".repeat(128) });
	const response = await app.fetch(request);
	expect(response.status).toBe(500);
	const fields = logFields(errors.mock.calls, "Unhandled error");
	expect(fields.method).toBe("X".repeat(32));
	expect(fields.path).toBe(longPath.slice(0, 1_024));
});

test("a diagnostic-only code getter failure does not replace the original error response", async () => {
	const error = new Error("probe getter failure");
	let reads = 0;
	Object.defineProperty(error, "code", {
		get: () => {
			// Existing disk/response checks read this three times; only the diagnostic read fails.
			if (++reads > 3) throw new Error("diagnostic code getter failed");
			return undefined;
		},
	});
	const fixture = createProbe(() => {
		throw error;
	});
	const response = await fixture.request();
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
	const fields = logFields(errors.mock.calls, "Unhandled error");
	expectRequestFields(fields, fixture.path);
	expect(fields.error).toBe(String(error));
	expect(fields).not.toHaveProperty("errorCode");
	expect(fields).not.toHaveProperty("dbRead");
});

test("arbitrary error code values are not copied or coerced into diagnostics", async () => {
	const error = Object.assign(new Error("probe failure"), {
		code: {
			toString: () => {
				throw new Error("must not coerce error codes");
			},
			toJSON: () => {
				throw new Error("must not serialize arbitrary error properties");
			},
		},
	});
	const fixture = createProbe(() => {
		throw error;
	});
	const response = await fixture.request();
	expect(response.status).toBe(500);
	const fields = logFields(errors.mock.calls, "Unhandled error");
	expectRequestFields(fields, fixture.path);
	expect(fields).not.toHaveProperty("errorCode");
	expect(fields).not.toHaveProperty("dbRead");
	expect(() => JSON.stringify(fields)).not.toThrow();
});
