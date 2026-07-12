import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../app-error-response";
import { RateLimitError } from "../errors";

describe("RateLimitError", () => {
	test("normalizes retry delay to a positive whole number of seconds", () => {
		const error = new RateLimitError("LOGIN_THROTTLED", 1_001);
		expect(error.statusCode).toBe(429);
		expect(error.code).toBe("LOGIN_THROTTLED");
		expect(error.retryAfterSeconds).toBe(2);
	});

	test("never emits a zero Retry-After value", () => {
		expect(new RateLimitError("AUTH_BUSY", 0).retryAfterSeconds).toBe(1);
	});

	test("serializes HTTP 429 with Retry-After and JSON retry metadata", async () => {
		const app = new Hono();
		app.get("/", () => {
			throw new RateLimitError("LOGIN_THROTTLED", 2_500);
		});
		app.onError(
			(error, c) =>
				buildAppErrorResponse(error, c) ?? c.json({ error: "Internal server error" }, 500),
		);

		const response = await app.request("/");
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("3");
		expect(await response.json()).toEqual({
			error: "Too many attempts. Please try again later.",
			code: "LOGIN_THROTTLED",
			retryAfterSeconds: 3,
		});
	});
});
