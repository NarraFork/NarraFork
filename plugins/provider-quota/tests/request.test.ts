import { expect, spyOn, test } from "bun:test";
import { BalanceProbeRequestError } from "../src/errors";
import type { ConnectionResponse, QuotaQueryParams } from "../src/protocol";
import {
	createJsonConnectionRequest,
	createRelayRequest,
	parseConnectionJson,
	RELAY_METADATA_RETURN_BUDGET_MS,
} from "../src/request";

const response = (
	body: string,
	status = 200,
	contentType: string | null = "application/json",
): ConnectionResponse => ({
	status,
	contentType,
	body,
	bytes: new TextEncoder().encode(body).byteLength,
});
const params = (): QuotaQueryParams => ({
	protocolVersion: "1.0",
	contributionId: "relay",
	target: {
		kind: "custom-api",
		id: "custom-api/test",
		providerId: "test",
		generation: "generation",
		baseUrl: "https://relay.example/site/v1",
	},
	mode: "probe",
	reference: "reference",
	deadlineAt: Date.now() + 10_000,
});
function kind(fn: () => unknown) {
	try {
		fn();
	} catch (error) {
		return error instanceof BalanceProbeRequestError ? error.kind : "other";
	}
	return "none";
}
test.each([404, 405])("HTTP %s remains unsupported", (status) => {
	expect(kind(() => parseConnectionJson(response("{}", status)))).toBe("unsupported");
});
test.each([
	301, 400, 401, 403, 429, 500, 503,
])("HTTP %s remains transient, never forwarded as provider text", (status) => {
	expect(kind(() => parseConnectionJson(response('{"error":"secret"}', status)))).toBe("transient");
});
test.each([
	"text/html",
	"text/plain",
	"application/xml",
])("MIME %s is not quota JSON", (contentType) => {
	expect(kind(() => parseConnectionJson(response("<html>token</html>", 200, contentType)))).toBe(
		"unsupported",
	);
});
test.each([
	"application/json",
	"application/problem+json",
	"application/json; charset=utf-8",
	"Application/JSON",
	null,
])("JSON MIME %s preserves explicit zeros", (contentType) => {
	expect(parseConnectionJson(response('{"amount":0}', 200, contentType))).toEqual({ amount: 0 });
});
test.each([
	"",
	"<html>login</html>",
	"{",
	'{"amount":NaN}',
])("malformed JSON is unsupported", (body) => {
	expect(kind(() => parseConnectionJson(response(body)))).toBe("unsupported");
});
test("exactly 64KiB JSON is valid transport data while larger input fails before parsing", () => {
	const body = JSON.stringify({ padding: "x".repeat(65536 - 14) });
	expect(new TextEncoder().encode(body).byteLength).toBe(65536);
	expect(parseConnectionJson(response(body))).toHaveProperty("padding");
	expect(kind(() => parseConnectionJson(response(`${body} `)))).toBe("transient");
});
test("UTF-8 bytes are independently enforced, not trusted from the host DTO", () => {
	const body = JSON.stringify({ padding: "界".repeat(22_000) });
	expect(kind(() => parseConnectionJson({ ...response(body), bytes: body.length }))).toBe(
		"transient",
	);
	expect(kind(() => parseConnectionJson({ ...response("{}"), bytes: 0 }))).toBe("transient");
});
test("decoded depth/node/array budgets still reject excessive JSON structure", () => {
	let deep: unknown = 0;
	for (let i = 0; i < 20; i++) deep = { next: deep };
	expect(kind(() => parseConnectionJson(response(JSON.stringify(deep))))).toBe("unsupported");
	expect(kind(() => parseConnectionJson(response(JSON.stringify(new Array(257).fill(0)))))).toBe(
		"unsupported",
	);
});
test.each([
	"//evil.example/path",
	"https://evil.example/path",
	"/api/../balance",
	"/api/%2e%2e/balance",
	"/api?key=secret",
	"/api#secret",
	"/api\\balance",
])("host path is absolute and traversal/query-free: %s", async (path) => {
	let calls = 0;
	const request = createJsonConnectionRequest(
		params(),
		async () => {
			calls++;
			return response("{}");
		},
		new AbortController().signal,
	);
	await expect(request(path)).rejects.toMatchObject({
		kind: "invalid_configuration",
		code: "invalid_configuration",
	});
	expect(calls).toBe(0);
});
test("relay legacy URLs cannot select another origin or attach credential query params", async () => {
	let calls = 0;
	const request = createRelayRequest(
		params(),
		async () => {
			calls++;
			return response("{}");
		},
		new AbortController().signal,
	);
	await expect(request("https://evil.example/site/v1/usage")).rejects.toMatchObject({
		kind: "invalid_configuration",
		code: "invalid_configuration",
	});
	await expect(request("https://relay.example/site/v1/usage?apiKey=secret")).rejects.toMatchObject({
		kind: "invalid_configuration",
		code: "invalid_configuration",
	});
	expect(calls).toBe(0);
});
test.each([
	401, 403,
])("provider-key HTTP %s stays transient through relay request mapping", async (status) => {
	let wire: unknown;
	const request = createRelayRequest(
		params(),
		async (value) => {
			wire = value;
			return response('{"error":"private-key-body"}', status);
		},
		new AbortController().signal,
	);
	await expect(
		request("https://relay.example/site/v1/usage", "provider-key"),
	).rejects.toMatchObject({
		kind: "transient",
	});
	expect(wire).toEqual({
		reference: "reference",
		method: "GET",
		path: "/site/v1/usage",
		headers: { accept: "application/json" },
	});
});

test("public metadata only sends accept and uses the same opaque reference", async () => {
	let wire: unknown;
	const request = createRelayRequest(
		params(),
		async (value) => {
			wire = value;
			return response("{}");
		},
		new AbortController().signal,
	);
	await request("https://relay.example/site/api/status", false);
	expect(wire).toEqual({
		reference: "reference",
		method: "GET",
		path: "/site/api/status",
		headers: { accept: "application/json" },
	});
});
test("near the deadline only optional metadata is skipped, not authenticated requests", async () => {
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now);
	const calls: string[] = [];
	try {
		const request = createRelayRequest(
			{ ...params(), deadlineAt: now + RELAY_METADATA_RETURN_BUDGET_MS },
			async (wire) => {
				calls.push(wire.path);
				return response("{}");
			},
			new AbortController().signal,
		);
		await expect(request("https://relay.example/site/v1/usage")).resolves.toEqual({});
		await expect(request("https://relay.example/site/api/status", false)).rejects.toMatchObject({
			kind: "transient",
			code: "timeout",
		});
		expect(calls).toEqual(["/site/v1/usage"]);
	} finally {
		clock.mockRestore();
	}
});
test("relay introspection and optional metadata share the same maxRequests counter", async () => {
	const calls: string[] = [];
	const request = createRelayRequest(
		params(),
		async (wire) => {
			calls.push(wire.path);
			return response("{}");
		},
		new AbortController().signal,
		{ maxRequests: 2 },
	);
	await request("https://relay.example/site/api/usage/token/");
	await request("https://relay.example/site/api/status", false);
	await expect(request("https://relay.example/site/v1/usage")).rejects.toMatchObject({
		kind: "transient",
		code: "queue_full",
	});
	expect(calls).toEqual(["/site/api/usage/token/", "/site/api/status"]);
});
test("maxRequests limits attempts, including failed responses", async () => {
	let calls = 0;
	const request = createJsonConnectionRequest(
		params(),
		async () => {
			calls++;
			return response("{}");
		},
		new AbortController().signal,
		{ maxRequests: 1 },
	);
	await request("/v1/usage");
	await expect(request("/api/usage/token/")).rejects.toMatchObject({
		kind: "transient",
		code: "queue_full",
	});
	expect(calls).toBe(1);
});
test("request timeout releases an abort-ignoring host RPC", async () => {
	let release: ((value: ConnectionResponse) => void) | undefined;
	const request = createJsonConnectionRequest(
		params(),
		async () =>
			new Promise((resolve) => {
				release = resolve;
			}),
		new AbortController().signal,
		{ requestTimeoutMs: 20 },
	);
	await expect(request("/v1/usage")).rejects.toMatchObject({ kind: "transient", code: "timeout" });
	release?.(response('{"balance":99}'));
	await Promise.resolve();
});
test("already-cancelled rounds make no host RPC", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const request = createJsonConnectionRequest(
		params(),
		async () => {
			calls++;
			return response("{}");
		},
		controller.signal,
	);
	await expect(request("/v1/usage")).rejects.toMatchObject({ kind: "transient" });
	expect(calls).toBe(0);
});
