import { describe, expect, test } from "bun:test";
import { redactHeaders, redactPostData, redactUrl } from "../redaction";

describe("browser network redaction", () => {
	test("redacts sensitive request and response headers", () => {
		expect(
			redactHeaders({
				Authorization: "Bearer token",
				Cookie: "sid=abc",
				"content-type": "application/json",
			}),
		).toEqual({
			Authorization: "[REDACTED]",
			Cookie: "[REDACTED]",
			"content-type": "application/json",
		});
	});

	test("redacts sensitive JSON post data recursively", () => {
		const redacted = redactPostData(
			JSON.stringify({ username: "alice", password: "pw", nested: { csrfToken: "secret" } }),
			{ "content-type": "application/json" },
		);
		expect(JSON.parse(redacted ?? "{}")).toEqual({
			username: "alice",
			password: "[REDACTED]",
			nested: { csrfToken: "[REDACTED]" },
		});
	});

	test("redacts form post data", () => {
		expect(
			redactPostData("username=alice&csrf_token=abc&session=xyz", {
				"content-type": "application/x-www-form-urlencoded",
			}),
		).toBe("username=alice&csrf_token=%5BREDACTED%5D&session=%5BREDACTED%5D");
	});

	test("redacts sensitive URL query parameters", () => {
		expect(redactUrl("https://example.com/path?token=abc&q=ok&api_key=xyz")).toBe(
			"https://example.com/path?token=%5BREDACTED%5D&q=ok&api_key=%5BREDACTED%5D",
		);
	});

	test("redacts camelCase sensitive keys in structured payloads", () => {
		const redacted = redactPostData(
			JSON.stringify({
				accessToken: "access-secret",
				sessionId: "session-secret",
				authToken: "auth-secret",
				profile: { displayName: "alice" },
			}),
			{ "content-type": "application/json" },
		);

		expect(JSON.parse(redacted ?? "{}")).toEqual({
			accessToken: "[REDACTED]",
			sessionId: "[REDACTED]",
			authToken: "[REDACTED]",
			profile: { displayName: "alice" },
		});
	});

	test("redacts URL credentials", () => {
		const redacted = redactUrl("https://alice:secret@example.com/path?accessToken=abc&q=ok");

		expect(redacted).toBe(
			"https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/path?accessToken=%5BREDACTED%5D&q=ok",
		);
	});

	test("redacts URL-valued headers without redacting the full header", () => {
		expect(
			redactHeaders({
				Referer: "https://example.com/path?csrfToken=abc&q=ok",
				Location: "https://user:pw@example.com/next?sessionId=sid",
				"x-original-url": "/login?authToken=secret&next=/home",
			}),
		).toEqual({
			Referer: "https://example.com/path?csrfToken=%5BREDACTED%5D&q=ok",
			Location: "https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/next?sessionId=%5BREDACTED%5D",
			"x-original-url": "/login?authToken=[REDACTED]&next=/home",
		});
	});
});
