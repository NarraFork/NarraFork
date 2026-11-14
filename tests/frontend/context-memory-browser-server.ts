import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../server/lib/app-error-response";

export async function startMemoryBrowserServer() {
	// tests/preload.ts isolates this connection; never use the running application's server.
	const { sqlite } = await import("../../server/db");
	const { contextMemoryRoutes } = await import("../../server/routes/context-memory");
	const actorId = "memory-browser-user";
	sqlite.run(
		"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'test-only', 'user', ?)",
		[actorId, actorId, new Date().toISOString()],
	);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("../fixtures/frontend/context-memory-manager.tsx", import.meta.url)),
		],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const js = bundle.outputs.find((asset) => asset.path.endsWith(".js"));
	const css = bundle.outputs.find((asset) => asset.path.endsWith(".css"));
	if (!js || !css) throw new Error("Memory browser fixture requires both JS and real Mantine CSS");
	const app = new Hono();
	const requests: { method: string; path: string; status: number }[] = [];
	app.use("/api/*", async (c, next) => {
		// Only authentication is substituted, as in the route suite. No application server
		// is started; this loopback-only fixture uses the production routes and persistence.
		c.set("user", { sub: actorId, role: "user", tokenVersion: 0, iat: 0, exp: 4_102_444_800 });
		await next();
		requests.push({ method: c.req.method, path: c.req.path, status: c.res.status });
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: error.message }, 500),
	);
	app.route("/api/context-memory", contextMemoryRoutes);
	app.get(
		"/fixture.js",
		() => new Response(js, { headers: { "Content-Type": "text/javascript" } }),
	);
	app.get("/fixture.css", () => new Response(css, { headers: { "Content-Type": "text/css" } }));
	app.get("/", (c) =>
		c.html(`<!doctype html><html><head><meta charset="utf-8">
			<meta name="viewport" content="width=device-width,initial-scale=1">
			<link rel="stylesheet" href="/fixture.css"><link rel="icon" href="data:,">
			</head><body><div id="root" data-user-id="${actorId}"></div>
			<script type="module" src="/fixture.js"></script></body></html>`),
	);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch: app.fetch });
	return {
		url: server.url.href,
		requests,
		reset() {
			sqlite.run("DELETE FROM context_memories WHERE owner_user_id = ?", [actorId]);
			requests.length = 0;
		},
		state() {
			return sqlite
				.query<{ id: string; status: string; version: number; content: string }, [string]>(
					"SELECT id, status, version, content FROM context_memories WHERE owner_user_id = ?",
				)
				.get(actorId);
		},
		auditCount() {
			return sqlite
				.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_memory_events")
				.get()?.count;
		},
		async close() {
			await server.stop(true);
			sqlite.run("DELETE FROM users WHERE id = ?", [actorId]);
		},
	};
}
