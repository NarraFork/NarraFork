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
		// `toEqual`, not a subset match: the shape of a 429 body is a contract. `code`
		// stays the caller's choice (the login form branches on it), while `messageCode`
		// only names the wording — asserting both here is what keeps a wording change
		// from quietly becoming a behaviour change.
		expect(await response.json()).toEqual({
			error: "Too many attempts. Please try again later.",
			code: "LOGIN_THROTTLED",
			messageCode: "LOGIN_THROTTLED",
			retryAfterSeconds: 3,
		});
	});

	test("caller-supplied prose is left un-localized rather than replaced", async () => {
		// The catalog has no wording for a sentence it has never seen, so attaching
		// `LOGIN_THROTTLED` here would swap the specific message for the generic one.
		const app = new Hono();
		app.get("/", () => {
			throw new RateLimitError("MFA_THROTTLED", 1_000, "Too many verification codes requested.");
		});
		app.onError(
			(error, c) =>
				buildAppErrorResponse(error, c) ?? c.json({ error: "Internal server error" }, 500),
		);

		expect(await (await app.request("/")).json()).toEqual({
			error: "Too many verification codes requested.",
			code: "MFA_THROTTLED",
			retryAfterSeconds: 1,
		});
	});
});
