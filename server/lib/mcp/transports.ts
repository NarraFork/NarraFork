import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { envWithAmbientProxy } from "../net/proxy-env";
import type { McpServerConfig } from "../settings";

export function createTransport(config: McpServerConfig): Transport {
	switch (config.transport) {
		case "stdio":
			return createStdioTransport(config);
		case "streamable-http":
			return createStreamableHttpTransport(config);
		case "sse":
			return createSseTransport(config);
		default:
			throw new Error(`Unsupported MCP transport: ${config.transport}`);
	}
}

function createStdioTransport(config: McpServerConfig): Transport {
	if (!config.command) {
		throw new Error(`MCP server "${config.name}": stdio transport requires a command`);
	}

	// Merge config env with process env, filtering out undefined values.
	// An MCP server is third-party tooling the user configured and may need to
	// reach the network, so it gets the user's ambient proxy rather than the
	// blanked values NarraFork keeps for its own outbound fetch.
	let env: Record<string, string> | undefined;
	if (config.env) {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(envWithAmbientProxy())) {
			if (v !== undefined) base[k] = v;
		}
		env = { ...base, ...config.env };
	}

	return new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env,
		stderr: "pipe",
	});
}

function createStreamableHttpTransport(config: McpServerConfig): Transport {
	if (!config.url) {
		throw new Error(`MCP server "${config.name}": streamable-http transport requires a url`);
	}
	return new StreamableHTTPClientTransport(new URL(config.url), {
		requestInit: {
			headers: config.headers,
		},
	});
}

function createSseTransport(config: McpServerConfig): Transport {
	if (!config.url) {
		throw new Error(`MCP server "${config.name}": sse transport requires a url`);
	}
	return new SSEClientTransport(new URL(config.url), {
		requestInit: {
			headers: config.headers,
		},
	});
}
