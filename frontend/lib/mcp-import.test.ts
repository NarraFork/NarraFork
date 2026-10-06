import { describe, expect, test } from "bun:test";
import { filterUnsupportedMcpImportTransports } from "./mcp-import";

describe("filterUnsupportedMcpImportTransports", () => {
	test("filters unsupported transports from mcpServers while preserving stdio entries", () => {
		const input = {
			mcpServers: {
				stdio: { command: "bunx", args: ["server"] },
				explicitStdio: { transport: " STdio ", command: "node" },
				sse: { type: "sse", url: "http://localhost:1234/sse" },
				urlOnly: { url: "http://localhost:1235/mcp" },
			},
			metadata: "kept",
		};

		const result = filterUnsupportedMcpImportTransports(input);

		expect(result).toEqual({
			json: {
				mcpServers: {
					stdio: { command: "bunx", args: ["server"] },
					explicitStdio: { transport: " STdio ", command: "node" },
				},
				metadata: "kept",
			},
			skippedUnsupportedTransport: 2,
			allRecognizedServersSkipped: false,
		});
	});

	test("marks wrapped servers as all skipped when every recognized server is non-stdio", () => {
		const result = filterUnsupportedMcpImportTransports({
			servers: {
				jetbrains: { type: "sse", url: "http://localhost:64342/sse" },
				http: { transport: "streamable-http", url: "http://localhost:64343/mcp" },
			},
		});

		expect(result).toEqual({
			json: { servers: {} },
			skippedUnsupportedTransport: 2,
			allRecognizedServersSkipped: true,
		});
	});

	test("skips single-server JetBrains SSE configs before sending to the backend", () => {
		const result = filterUnsupportedMcpImportTransports({
			type: "sse",
			url: "http://localhost:64342/sse",
		});

		expect(result).toEqual({
			json: { mcpServers: {} },
			skippedUnsupportedTransport: 1,
			allRecognizedServersSkipped: true,
		});
	});

	test("keeps single-server stdio configs unchanged", () => {
		const input = { type: "stdio", command: "npx", args: ["-y", "@example/server"] };

		const result = filterUnsupportedMcpImportTransports(input);

		expect(result).toEqual({
			json: input,
			skippedUnsupportedTransport: 0,
			allRecognizedServersSkipped: false,
		});
	});

	test("filters raw server maps after wrapper and single-server shapes", () => {
		const result = filterUnsupportedMcpImportTransports({
			stdio: { command: "bunx", args: ["server"] },
			streamable: { transport: "streamable-http", url: "http://localhost:9999/mcp" },
		});

		expect(result).toEqual({
			json: { stdio: { command: "bunx", args: ["server"] } },
			skippedUnsupportedTransport: 1,
			allRecognizedServersSkipped: false,
		});
	});

	test("leaves unrecognized shapes untouched", () => {
		const input = { random: "value" };

		expect(filterUnsupportedMcpImportTransports(input)).toEqual({
			json: input,
			skippedUnsupportedTransport: 0,
			allRecognizedServersSkipped: false,
		});
		expect(filterUnsupportedMcpImportTransports(null)).toEqual({
			json: null,
			skippedUnsupportedTransport: 0,
			allRecognizedServersSkipped: false,
		});
	});
});
