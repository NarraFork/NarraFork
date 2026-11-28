import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { envWithAmbientProxy } from "../net/proxy-env";
import type { McpServerConfig } from "../settings";
import { createMcpOAuthProvider, noteMcpOAuthChallenge } from "./oauth";

/** `oauthKey` selects whose stored OAuth tokens a remote transport uses (default: config.id). */
export function createTransport(config: McpServerConfig, oauthKey = config.id): Transport {
	switch (config.transport) {
		case "stdio":
			return createStdioTransport(config);
		case "streamable-http":
			return createStreamableHttpTransport(config, oauthKey);
		case "sse":
			return createSseTransport(config, oauthKey);
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

	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env,
		stderr: "pipe",
	});
	// The SDK exposes a PassThrough before start(). Consume it immediately:
	// otherwise accumulated logs backpressure the child and stall MCP responses.
	// Discard rather than buffer or forward potentially large/sensitive logs.
	transport.stderr?.on("data", () => undefined);
	return transport;
}

/**
 * Options shared by the remote transports. With OAuth the SDK reuses the transport's
 * fetch for discovery, registration and token requests, which may go to another
 * origin, so the configured headers are added only to requests to the MCP server's
 * own origin instead of riding along in `requestInit`.
 */
function remoteTransportOptions(config: McpServerConfig, url: URL, oauthKey: string) {
	const authProvider = createMcpOAuthProvider(config, oauthKey);
	if (!authProvider) return { requestInit: { headers: config.headers } };
	const headers = Object.entries(config.headers ?? {});
	const fetchWithHeaders: FetchLike = async (input, init) => {
		if (new URL(input).origin !== url.origin) return fetch(input, init);
		const merged = new Headers(init?.headers);
		// Protocol headers the SDK sets (Accept, Content-Type, MCP-*) take precedence.
		for (const [name, value] of headers) if (!merged.has(name)) merged.set(name, value);
		const response = await fetch(input, { ...init, headers: merged });
		if (response.status === 401 || response.status === 403)
			noteMcpOAuthChallenge(config, oauthKey, response);
		return response;
	};
	return { authProvider, fetch: fetchWithHeaders };
}

function createStreamableHttpTransport(config: McpServerConfig, oauthKey: string): Transport {
	if (!config.url) {
		throw new Error(`MCP server "${config.name}": streamable-http transport requires a url`);
	}
	const url = new URL(config.url);
	return new StreamableHTTPClientTransport(url, remoteTransportOptions(config, url, oauthKey));
}

function createSseTransport(config: McpServerConfig, oauthKey: string): Transport {
	if (!config.url) {
		throw new Error(`MCP server "${config.name}": sse transport requires a url`);
	}
	const url = new URL(config.url);
	return new SSEClientTransport(url, remoteTransportOptions(config, url, oauthKey));
}
