import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	buildAppErrorResponse,
	toDatabaseReadUnavailablePayload,
	toErrorPayload,
} from "../app-error-response";
import { DATABASE_READ_RETRY_AFTER_SECONDS } from "../db-reader-readiness";
import { DbReadError } from "../db-worker/errors";
import { DbReadTaskOverloadedError, WorkersUnavailableError } from "../db-worker/pool";
import { AppError, catalogError, RateLimitError } from "../errors";

const privateDetail =
	"SELECT private_column FROM private_table WHERE token = 'private-bind'; /private/database.db";

async function responseFor(error: Error) {
	const app = new Hono();
	let handled = false;
	app.get("/", async () => {
		await Promise.resolve();
		throw error;
	});
	app.onError((error, c) => {
		const response = buildAppErrorResponse(error, c);
		handled = response !== null;
		// Same response boundary and generic fallback as server/app.ts.
		return response ?? c.json(toErrorPayload(catalogError("INTERNAL_ERROR")), 500);
	});
	const response = await app.request("/");
	const body: unknown = await response.json();
	return { response, body, handled };
}

describe("database reader HTTP error boundary", () => {
	test("payload classification rejects absent, unknown and explicit application errors", () => {
		for (const error of [
			undefined,
			null,
			new Error(privateDetail),
			new AppError(privateDetail, 409, "DB_READ_BUSY"),
		]) {
			expect(toDatabaseReadUnavailablePayload(error)).toBeNull();
		}
	});

	test("catalog construction provides the reusable localizable service-unavailable response", async () => {
		const { response, body } = await responseFor(catalogError("DATABASE_READ_UNAVAILABLE"));
		expect(response.status).toBe(503);
		expect(body).toEqual(toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")));
	});

	test("unknown errors use the safe internal-error fallback without their message", async () => {
		const { response, body, handled } = await responseFor(new Error(privateDetail));
		expect(handled).toBe(false);
		expect(response.status).toBe(500);
		expect(body).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
	});
	for (const code of [
		"DB_READ_UNAVAILABLE",
		"DB_READ_OVERLOADED",
		"DB_READ_TASK_OVERLOADED",
		"DB_READ_BUSY",
		"DB_READ_DATABASE_CLOSED",
		"DB_READ_WORKER_EXITED",
		"DB_READ_READER_EXIT_UNCONFIRMED",
		"DB_READ_TASK_TIMEOUT",
	]) {
		test(`maps ${code} to a fixed localizable 503 without serializing reader internals`, async () => {
			const error = Object.assign(new DbReadError(code, privateDetail), {
				reason: privateDetail,
				sql: privateDetail,
				binds: ["private-bind"],
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { id: privateDetail },
			});
			const { response, body, handled } = await responseFor(error);
			expect(handled).toBe(true);
			expect(response.status).toBe(503);
			expect(body).toEqual({ ...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")), code });
			expect(JSON.stringify(body)).not.toContain("private");
			expect(response.headers.get("retry-after")).toBe(String(DATABASE_READ_RETRY_AFTER_SECONDS));
		});
	}

	test("handles the pool's real unavailable error without exposing its reason", async () => {
		const { response, body } = await responseFor(new WorkersUnavailableError(privateDetail));
		expect(response.status).toBe(503);
		expect(body).toEqual(toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")));
	});

	for (const [limit, overload] of [
		["count", new DbReadTaskOverloadedError()],
		["bytes", new DbReadError("DB_READ_OVERLOADED", privateDetail)],
	] as const) {
		test(`handles the pool's ${limit} queue overload with a safe localizable 503`, async () => {
			const error = Object.assign(overload, {
				reason: privateDetail,
				sql: privateDetail,
				binds: ["private-bind"],
				messageCode: "RESOURCE_NOT_FOUND",
				messageParams: { id: privateDetail },
			});
			const { response, body, handled } = await responseFor(error);
			expect(handled).toBe(true);
			expect(response.status).toBe(503);
			expect(body).toEqual({
				...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")),
				code: limit === "count" ? "DATABASE_READ_UNAVAILABLE" : "DB_READ_OVERLOADED",
			});
			expect(JSON.stringify(body)).not.toContain("private");
			expect(response.headers.get("retry-after")).toBe(String(DATABASE_READ_RETRY_AFTER_SECONDS));
		});
	}

	test("recognizes transient error codes reconstructed from worker messages", async () => {
		const error = Object.assign(new Error(privateDetail), { code: "DB_READ_TASK_TIMEOUT" });
		const { response, body } = await responseFor(error);
		expect(response.status).toBe(503);
		expect(body).toEqual({
			...toErrorPayload(catalogError("DATABASE_READ_UNAVAILABLE")),
			code: "DB_READ_TASK_TIMEOUT",
		});
	});

	for (const code of [
		"DB_READ_FAILED",
		"DB_READ_INVALID",
		"DB_READ_BUDGET",
		"DB_READ_ROW_TOO_LARGE",
		"DB_READ_UNSUPPORTED",
		"DB_READ_PROTOCOL",
		"DB_READ_CONSUMER_FAILED",
		"DB_READ_ABORTED",
		"DB_READ_UNAVAILABLE_EXTRA",
		"SQLITE_BUSY",
		"SQLITE_ERROR",
	]) {
		test(`keeps ${code} behind the generic safe production fallback`, async () => {
			const { response, body, handled } = await responseFor(
				Object.assign(new Error(privateDetail), { code }),
			);
			expect(handled).toBe(false);
			expect(response.status).toBe(500);
			expect(body).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
			expect(JSON.stringify(body)).not.toContain("private");
		});
	}

	test("does not coerce arbitrary code values or expose unknown error messages", async () => {
		const error = Object.assign(new Error(privateDetail), {
			code: {
				toString: () => {
					throw new Error("must not coerce error codes");
				},
			},
		});
		const { response, body, handled } = await responseFor(error);
		expect(handled).toBe(false);
		expect(response.status).toBe(500);
		expect(body).toEqual(toErrorPayload(catalogError("INTERNAL_ERROR")));
	});

	test("preserves explicit AppError status, prose and localization even with a reader-shaped code", async () => {
		const error = new AppError("Specific application conflict", 409, "DB_READ_BUSY", {
			messageCode: "FORBIDDEN_ACTION",
		});
		const { response, body } = await responseFor(error);
		expect(response.status).toBe(409);
		expect(body).toEqual(toErrorPayload(error));
	});

	test("preserves rate-limit status and retry metadata before reader-code mapping", async () => {
		const error = new RateLimitError("DB_READ_OVERLOADED", 1500);
		const { response, body } = await responseFor(error);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("2");
		expect(body).toEqual({ ...toErrorPayload(error), retryAfterSeconds: 2 });
	});
});
