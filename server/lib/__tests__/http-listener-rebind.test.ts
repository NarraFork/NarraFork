import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_LAN_HOST } from "../../../shared/server-host";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "narrafork-rebind-"));
process.env.NARRAFORK_HOME = home;
const { rebindHttpListener } = await import("../http-listener-rebind");
const { listenWithLanFallback, resolveListenHost } = await import("../net/listen-host");
const { registerServerRestart, restartServerForResponse } = await import("../server-restart");
type Listener = ReturnType<typeof Bun.serve>;
const listeners: Listener[] = [];
function listen(host: string, port: number): Listener {
	const server = Bun.serve({ hostname: host, port, fetch: () => new Response("owned") });
	listeners.push(server);
	return server;
}
afterEach(async () => {
	registerServerRestart(null);
	await Bun.sleep(220);
	for (const server of listeners.splice(0)) void server.stop(true);
});
afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

for (const scenario of [
	"success",
	"no-address",
	"detection-error",
	"occupied",
	"rollback",
] as const) {
	test(`response survives rebind and returns the real URL: ${scenario}`, async () => {
		let host = "127.0.0.1";
		let active: Listener;
		const old = Bun.serve({
			hostname: host,
			port: 0,
			async fetch() {
				const address = await restartServerForResponse(AUTO_LAN_HOST, oldPort);
				return Response.json({
					newUrl: `${address?.protocol}://${address?.host}:${address?.port}`,
				});
			},
		});
		listeners.push(old);
		active = old;
		const oldPort = old.port as number;
		if (scenario === "occupied") listen("127.0.0.2", oldPort);
		registerServerRestart((_configured, port, options) => {
			active = rebindHttpListener(
				active,
				() => {
					const resolved = resolveListenHost(AUTO_LAN_HOST, () => {
						if (scenario === "detection-error") throw new Error("network gone");
						return scenario === "no-address" ? [] : ["127.0.0.2"];
					});
					if (scenario === "rollback") throw new Error("TLS configuration rejected");
					return listenWithLanFallback(AUTO_LAN_HOST, resolved, (candidate) => {
						const server = listen(candidate, port);
						host = candidate;
						return server;
					});
				},
				() => {
					host = "127.0.0.1";
					return listen(host, oldPort);
				},
				options?.preserveResponse === true,
			);
			return { host, port: active.port as number, protocol: "http" };
		});
		const response = await fetch(`http://127.0.0.1:${oldPort}/`, {
			signal: AbortSignal.timeout(1000),
		});
		expect(response.ok).toBe(true);
		const { newUrl } = (await response.json()) as { newUrl: string };
		const expectedHost =
			scenario === "success" ? "127.0.0.2" : scenario === "rollback" ? "127.0.0.1" : "localhost";
		expect(newUrl).toBe(`http://${expectedHost}:${active.port}`);
		expect(await (await fetch(newUrl, { signal: AbortSignal.timeout(1000) })).text()).toBe("owned");
		await Bun.sleep(220);
		expect(await (await fetch(newUrl, { signal: AbortSignal.timeout(1000) })).text()).toBe("owned");
	});
}

test("HTTP response survives same-port HTTPS rebind and advertises actual protocol", async () => {
	const { issueServerCert } = await import("../tls");
	const cert = await issueServerCert();
	let active: Listener;
	const old = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			return Response.json(await restartServerForResponse("127.0.0.1", port));
		},
	});
	listeners.push(old);
	const port = old.port as number;
	active = old;
	registerServerRestart((_host, requestedPort, options) => {
		active = rebindHttpListener(
			active,
			() => {
				const replacement = Bun.serve({
					hostname: "127.0.0.1",
					port: requestedPort,
					tls: { cert: Bun.file(cert.certPath), key: Bun.file(cert.keyPath) },
					fetch: () => new Response("owned-tls"),
				});
				listeners.push(replacement);
				return replacement;
			},
			() => listen("127.0.0.1", port),
			options?.preserveResponse === true,
		);
		return {
			host: "127.0.0.1",
			port: active.port as number,
			protocol: active.url.protocol === "https:" ? "https" : "http",
		};
	});
	const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
	const address = await response.json();
	expect(address).toEqual({ host: "127.0.0.1", port, protocol: "https" });
	const secureResponse = await fetch(`https://127.0.0.1:${port}`, {
		tls: { rejectUnauthorized: false },
		signal: AbortSignal.timeout(1000),
	});
	expect(await secureResponse.text()).toBe("owned-tls");
});

test("rollback failure propagates instead of returning an unbound target", async () => {
	const old = listen("127.0.0.1", 0);
	expect(() =>
		rebindHttpListener(
			old,
			() => {
				throw new Error("bind failed");
			},
			() => {
				throw new Error("rollback failed");
			},
			true,
		),
	).toThrow("rollback failed");
});
