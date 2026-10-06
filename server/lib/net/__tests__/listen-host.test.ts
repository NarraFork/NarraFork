import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_LAN_HOST } from "../../../../shared/server-host";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-listen-host-"));
process.env.NARRAFORK_HOME = testHome;
const { listenWithLanFallback, resolveListenHost } = await import("../listen-host");
const { getLanAddresses } = await import("../lan-addresses");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("automatic LAN host resolution", () => {
	test("selects only the first LAN address and resolves afresh on each start", () => {
		let addresses = ["192.168.1.10", "10.0.0.2"];
		const getAddresses = () => addresses;
		expect(resolveListenHost(AUTO_LAN_HOST, getAddresses)).toBe("192.168.1.10");
		addresses = ["10.0.1.8"];
		expect(resolveListenHost(AUTO_LAN_HOST, getAddresses)).toBe("10.0.1.8");
	});

	test("falls back locally when offline or detection fails", () => {
		expect(resolveListenHost(AUTO_LAN_HOST, () => [])).toBe("localhost");
		expect(
			resolveListenHost(AUTO_LAN_HOST, () => {
				throw new Error("Network interfaces unavailable");
			}),
		).toBe("localhost");
	});

	test.each([
		"localhost",
		"127.0.0.1",
		"::1",
		"0.0.0.0",
		"192.168.1.10",
		"nas.local",
	])("leaves explicit host %s unchanged without enumerating interfaces", (host) => {
		expect(
			resolveListenHost(host, () => {
				throw new Error("Must not enumerate interfaces");
			}),
		).toBe(host);
	});
});

describe("automatic LAN listener fallback", () => {
	const lanHost = getLanAddresses()[0];
	test.skipIf(!lanHost || process.platform === "win32")(
		"falls back to a real localhost listener when the LAN endpoint is occupied",
		async () => {
			const occupied = Bun.serve({
				hostname: lanHost,
				port: 0,
				fetch: () => new Response("occupied"),
			});
			let server: ReturnType<typeof Bun.serve> | undefined;
			let boundHost = lanHost;
			try {
				server = listenWithLanFallback(AUTO_LAN_HOST, lanHost, (host) => {
					boundHost = host;
					return Bun.serve({
						hostname: host,
						port: occupied.port,
						fetch: () => new Response("local fallback"),
					});
				});
				expect(boundHost).toBe("localhost");
				const response = await fetch(`http://localhost:${server.port}`, {
					signal: AbortSignal.timeout(2000),
				});
				expect(await response.text()).toBe("local fallback");
			} finally {
				await server?.stop(true);
				await occupied.stop(true);
			}
		},
	);
	test("keeps a successful LAN listener", () => {
		const calls: string[] = [];
		const result = listenWithLanFallback(AUTO_LAN_HOST, "10.0.0.2", (host) => {
			calls.push(host);
			return "server";
		});
		expect(result).toBe("server");
		expect(calls).toEqual(["10.0.0.2"]);
	});

	test("retries locally once on bind failure, without trying another interface", () => {
		const calls: string[] = [];
		const result = listenWithLanFallback(AUTO_LAN_HOST, "10.0.0.2", (host) => {
			calls.push(host);
			if (host !== "localhost") throw new Error("EADDRNOTAVAIL");
			return "local server";
		});
		expect(result).toBe("local server");
		expect(calls).toEqual(["10.0.0.2", "localhost"]);
		// Persisted automatic mode can recover when the network is available next time.
		expect(resolveListenHost(AUTO_LAN_HOST, () => ["192.168.2.3"])).toBe("192.168.2.3");
	});

	test("propagates a failed local retry", () => {
		const calls: string[] = [];
		const error = new Error("EADDRINUSE");
		expect(() =>
			listenWithLanFallback(AUTO_LAN_HOST, "10.0.0.2", (host) => {
				calls.push(host);
				throw error;
			}),
		).toThrow(error);
		expect(calls).toEqual(["10.0.0.2", "localhost"]);
	});

	test.each([
		["192.168.1.10", "192.168.1.10"],
		["0.0.0.0", "0.0.0.0"],
		[AUTO_LAN_HOST, "localhost"],
	])("does not retry %s resolved to %s", (configured, resolved) => {
		const calls: string[] = [];
		const error = new Error("Bind failed");
		expect(() =>
			listenWithLanFallback(configured, resolved, (host) => {
				calls.push(host);
				throw error;
			}),
		).toThrow(error);
		expect(calls).toEqual([resolved]);
	});
});
