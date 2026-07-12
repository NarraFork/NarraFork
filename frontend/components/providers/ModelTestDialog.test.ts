import { describe, expect, test } from "bun:test";
import type { ModelTestDiagnostics } from "../../lib/api/settings";
import { formatModelTestDiagnosticReport } from "./ModelTestDialog";

function diagnostics(): ModelTestDiagnostics {
	return {
		id: "diag1234",
		model: "agg:demo:auto",
		resolvedProvider: "demo",
		resolvedModel: "demo:gpt-test",
		createdAt: "2026-04-26T00:00:00.000Z",
		durationMs: 42,
		runtime: {
			name: "Bun",
			version: "1.3.14",
			platform: "linux",
			arch: "x64",
		},
		verbose: {
			enabled: true,
			destination: "server_stdout",
			includesSensitiveHeaders: false,
			redaction: "safe_allowlist",
		},
		error: {
			name: "NetworkRequestError",
			message: "Network request failed [connection_reset/ECONNRESET]",
			category: "connection_reset",
			code: "ECONNRESET",
			cause: {
				name: "Error",
				message: "The socket connection was closed unexpectedly",
				code: "ECONNRESET",
			},
		},
		requests: [
			{
				sequence: 1,
				url: "https://api.example.com/v1/responses",
				method: "POST",
				route: "proxy",
				proxyUrl: "http://proxy.example.com:8080/",
				requestBodyBytes: 128,
				verbose: true,
				durationMs: 41,
				outcome: "network_error",
				category: "connection_reset",
				error: {
					message: "The socket connection was closed unexpectedly",
					code: "ECONNRESET",
				},
			},
		],
	};
}

describe("formatModelTestDiagnosticReport", () => {
	test("includes the structured error chain and request attempts", () => {
		const report = formatModelTestDiagnosticReport({
			model: "demo:gpt-test",
			selectedModel: "__agg__:balanced",
			sourceError: "Narrator hit ECONNRESET",
			error: "Network request failed",
			diagnostics: diagnostics(),
			requestUrls: [{ method: "POST", url: "https://legacy.example.com" }],
		});
		const parsed = JSON.parse(report) as Record<string, unknown>;

		expect(report).toContain("diag1234");
		expect(parsed.selectedModel).toBe("__agg__:balanced");
		expect(parsed.testModel).toBe("demo:gpt-test");
		expect(report).toContain("Narrator hit ECONNRESET");
		expect(report).toContain('"enabled": true');
		expect(report).toContain("ECONNRESET");
		expect(report).toContain("proxy.example.com:8080");
		expect(parsed).not.toHaveProperty("requestUrls");
	});

	test("keeps legacy request URLs when the server has no structured diagnostics", () => {
		const report = formatModelTestDiagnosticReport({
			model: "demo:gpt-test",
			error: "legacy failure",
			requestUrls: [{ method: "POST", url: "https://legacy.example.com/v1/responses" }],
		});

		expect(report).toContain("legacy.example.com/v1/responses");
		expect(report).toContain("legacy failure");
	});
});
