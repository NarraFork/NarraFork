import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getNarraforkPath } from "../../../server/lib/narrafork-home";
import { resetSecretStoreForTests, setSecretEncryption } from "../../../server/lib/secret-store";
import type { McpServerConfig } from "../../../server/lib/settings";

const actualSettings = { ...(await import("../../../server/lib/settings")) };
const settings = { mcpServers: [] as McpServerConfig[] };
mock.module("../../../server/lib/settings", () => ({ ...actualSettings, settings }));
const oauth = await import("../../../server/lib/mcp/oauth");
const { mcpManager } = await import("../../../server/lib/mcp/manager");

/** Fake protected MCP resource + authorization server on one origin. */
const hits: string[] = [];
const validTokens = new Set<string>();
let tokenCounter = 0;
let lastTokenForm: URLSearchParams | undefined;
let lastRegistration: Record<string, unknown> | undefined;
let challengeMetadataPath = "/.well-known/oauth-protected-resource/mcp";

function json(body: unknown, status = 200) {
	return Response.json(body, { status });
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const base = url.origin;
		hits.push(`${req.method} ${url.pathname}`);
		if (
			url.pathname === "/custom-prm" ||
			url.pathname.startsWith("/.well-known/oauth-protected-resource")
		)
			return json({ resource: `${base}/mcp`, authorization_servers: [base] });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json({
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			});
		if (url.pathname === "/register") {
			lastRegistration = await req.json();
			return json({ ...lastRegistration, client_id: "dyn-client" }, 201);
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(await req.text());
			lastTokenForm = form;
			const grant = form.get("grant_type");
			if (grant === "authorization_code" && form.get("code") !== "good-code")
				return json({ error: "invalid_grant" }, 400);
			if (grant === "refresh_token" && form.get("refresh_token") !== "refresh-1")
				return json({ error: "invalid_grant" }, 400);
			const access_token = `access-${++tokenCounter}`;
			validTokens.add(access_token);
			return json({
				access_token,
				token_type: "Bearer",
				expires_in: 3600,
				...(grant === "authorization_code" && { refresh_token: "refresh-1" }),
			});
		}
		if (url.pathname === "/mcp") {
			const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
			if (!token || !validTokens.has(token))
				return new Response("unauthorized", {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${base}${challengeMetadataPath}", scope="mcp:tools"`,
					},
				});
			const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
			mcp.registerTool("echo", { description: "echo" }, async () => ({
				content: [{ type: "text", text: "ok" }],
			}));
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await mcp.connect(transport);
			return transport.handleRequest(req);
		}
		return new Response("not found", { status: 404 });
	},
});

const baseUrl = `http://127.0.0.1:${server.port}`;
const redirectUrl = "https://nf.example/api/mcp/oauth/callback";
const config: McpServerConfig = {
	id: "remote",
	name: "Remote",
	transport: "streamable-http",
	url: `${baseUrl}/mcp`,
	mode: "auto",
	enabled: true,
};
const storePath = getNarraforkPath("mcp-oauth.json");

async function authorize(cfg = config) {
	const started = await oauth.startMcpOAuth(cfg, redirectUrl);
	if (!("authorizationUrl" in started)) throw new Error("expected a redirect");
	const authUrl = new URL(started.authorizationUrl);
	const state = authUrl.searchParams.get("state") ?? "";
	await oauth.finishMcpOAuth(state, "good-code", (id) =>
		settings.mcpServers.find((s) => s.id === id),
	);
	return { authUrl, state };
}

beforeAll(() => setSecretEncryption(true));
beforeEach(() => {
	settings.mcpServers = [{ ...config }];
	hits.length = 0;
	validTokens.clear();
	tokenCounter = 0;
	lastTokenForm = undefined;
	lastRegistration = undefined;
	challengeMetadataPath = "/.well-known/oauth-protected-resource/mcp";
	rmSync(storePath, { force: true });
	oauth.resetMcpOAuthForTests();
});
afterEach(async () => {
	await mcpManager.shutdown();
});
afterAll(() => {
	server.stop(true);
	rmSync(storePath, { force: true });
	oauth.resetMcpOAuthForTests();
	resetSecretStoreForTests();
});

describe("MCP OAuth", () => {
	test("background connections never register a client or start an authorization", async () => {
		const result = await mcpManager.testConnection(config);
		expect(result).toMatchObject({ ok: false, authRequired: true });
		expect(hits).not.toContain("POST /register");
		expect(hits).not.toContain("POST /token");
		expect(oauth.getMcpOAuthStatus(config).authorized).toBe(false);
	});

	test("manager reports authorization required without scheduling reconnects", async () => {
		await mcpManager.connect(config);
		const [status] = mcpManager.getServerStatuses();
		expect(status.status).toBe("error");
		expect(status.auth).toEqual({
			supported: true,
			authorized: false,
			hasClientSecret: false,
			required: true,
		});
		expect(status.error).toContain("requires OAuth authorization");
	});

	test("interactive flow uses discovery, DCR and PKCE, then stores encrypted tokens", async () => {
		const { authUrl, state } = await authorize();
		expect(authUrl.origin + authUrl.pathname).toBe(`${baseUrl}/authorize`);
		expect(authUrl.searchParams.get("client_id")).toBe("dyn-client");
		expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectUrl);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authUrl.searchParams.get("resource")).toBe(`${baseUrl}/mcp`);
		expect(lastRegistration).toMatchObject({
			redirect_uris: [redirectUrl],
			token_endpoint_auth_method: "none",
		});
		expect(lastTokenForm?.get("code_verifier")).toBeTruthy();
		expect(oauth.getMcpOAuthStatus(config).authorized).toBe(true);
		expect(existsSync(storePath)).toBe(true);
		expect(readFileSync(storePath, "utf8")).not.toContain("access-1");

		const result = await mcpManager.testConnection(config);
		expect(result.ok).toBe(true);
		expect(result.tools?.map((t) => t.name)).toEqual(["echo"]);

		// The state is single-use.
		await expect(oauth.finishMcpOAuth(state, "good-code", () => config)).rejects.toThrow(
			"Unknown or expired",
		);
	});

	test("expired access tokens are refreshed in the background, keeping the refresh token", async () => {
		await authorize();
		validTokens.clear();
		const result = await mcpManager.testConnection(config);
		expect(result.ok).toBe(true);
		expect(lastTokenForm?.get("grant_type")).toBe("refresh_token");
		validTokens.clear();
		expect((await mcpManager.testConnection(config)).ok).toBe(true);
		expect(tokenCounter).toBe(3);
	});

	test("a changed server URL or client id does not reuse stored tokens", async () => {
		await authorize();
		expect(oauth.getMcpOAuthStatus({ ...config, url: `${baseUrl}/mcp?v=2` }).authorized).toBe(
			false,
		);
		expect(oauth.getMcpOAuthStatus({ ...config, oauth: { clientId: "other" } }).authorized).toBe(
			false,
		);
	});

	test("a server edited mid-flow rejects the callback", async () => {
		const started = await oauth.startMcpOAuth(config, redirectUrl);
		if (!("authorizationUrl" in started)) throw new Error("expected a redirect");
		const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
		await expect(
			oauth.finishMcpOAuth(state, "good-code", () => ({ ...config, url: `${baseUrl}/other` })),
		).rejects.toThrow("changed while it was being authorized");
		expect(hits).not.toContain("POST /token");
	});

	test("pre-registered clients skip DCR and send their secret", async () => {
		const cfg = { ...config, oauth: { clientId: "static-client", scope: "tools:read" } };
		settings.mcpServers = [cfg];
		oauth.setMcpOAuthClientSecret(cfg.id, "s3cret");
		const { authUrl } = await authorize(cfg);
		expect(hits).not.toContain("POST /register");
		expect(authUrl.searchParams.get("client_id")).toBe("static-client");
		expect(authUrl.searchParams.get("scope")).toBe("tools:read");
		expect(lastTokenForm?.get("client_secret")).toBe("s3cret");
		expect(oauth.getMcpOAuthStatus(cfg)).toMatchObject({ authorized: true, hasClientSecret: true });

		oauth.signOutMcpOAuth(cfg.id);
		expect(oauth.getMcpOAuthStatus(cfg)).toMatchObject({
			authorized: false,
			hasClientSecret: true,
		});
		oauth.deleteMcpOAuth(cfg.id);
		expect(oauth.getMcpOAuthStatus(cfg).hasClientSecret).toBe(false);
	});

	test("consent uses the challenged scope when none is configured", async () => {
		await mcpManager.testConnection(config);
		const started = await oauth.startMcpOAuth(config, redirectUrl);
		if (!("authorizationUrl" in started)) throw new Error("expected a redirect");
		expect(new URL(started.authorizationUrl).searchParams.get("scope")).toBe("mcp:tools");
	});

	test("after a URL change, consent discovers via the challenge's resource metadata URL", async () => {
		await authorize();
		const moved = { ...config, url: `${baseUrl}/mcp?v=2` };
		challengeMetadataPath = "/custom-prm";
		await mcpManager.testConnection(moved, config.id);
		hits.length = 0;
		await oauth.startMcpOAuth(moved, redirectUrl);
		expect(hits).toContain("GET /custom-prm");
		expect(hits.some((hit) => hit.startsWith("GET /.well-known/oauth-protected-resource"))).toBe(
			false,
		);
	});

	test("a later challenge without scope keeps the challenged scope", async () => {
		await mcpManager.testConnection(config);
		oauth.noteMcpOAuthChallenge(
			config,
			config.id,
			new Response(null, {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/custom-prm"` },
			}),
		);
		const started = await oauth.startMcpOAuth(config, redirectUrl);
		if (!("authorizationUrl" in started)) throw new Error("expected a redirect");
		expect(new URL(started.authorizationUrl).searchParams.get("scope")).toBe("mcp:tools");
	});

	test("re-authorization always asks for consent and an abandoned one keeps the old grant", async () => {
		await authorize();
		const again = await oauth.startMcpOAuth(config, "https://other.example/api/mcp/oauth/callback");
		expect("authorizationUrl" in again).toBe(true);
		expect(oauth.getMcpOAuthStatus(config).authorized).toBe(true);
		expect((await mcpManager.testConnection(config)).ok).toBe(true);
	});

	test("testing an unsaved URL does not touch the saved server's credentials", async () => {
		await authorize();
		const edited = { ...config, id: "test-remote", url: `${baseUrl}/mcp?draft=1` };
		expect(await mcpManager.testConnection(edited, config.id)).toMatchObject({
			authRequired: true,
		});
		expect(oauth.getMcpOAuthStatus(config).authorized).toBe(true);
	});

	test("sign-out during an in-flight exchange is not undone", async () => {
		const started = await oauth.startMcpOAuth(config, redirectUrl);
		if (!("authorizationUrl" in started)) throw new Error("expected a redirect");
		const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
		await expect(
			oauth.finishMcpOAuth(state, "good-code", (id) => {
				oauth.signOutMcpOAuth(id);
				return config;
			}),
		).rejects.toThrow("reset");
		expect(oauth.getMcpOAuthStatus(config).authorized).toBe(false);
	});

	test("a static Authorization header opts the server out of OAuth", () => {
		expect(oauth.supportsMcpOAuth({ ...config, headers: { authorization: "Bearer pinned" } })).toBe(
			false,
		);
		expect(oauth.supportsMcpOAuth({ ...config, transport: "stdio" })).toBe(false);
	});
});
