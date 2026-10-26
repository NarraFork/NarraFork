import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { managerControlOrigin } from "../../../shared/server-host";
import { managerFetch } from "../../manager/manager-fetch";
import { rebindHttpListener } from "../http-listener-rebind";
import {
	createManagerRebindCoordinator,
	isListenerPortConflict,
	type ListenerResource,
	managerControlRefusal,
	resolveManagerListenHost,
	startManagerListenerGroup,
} from "../manager-control-server";
import { listenWithLanFallback } from "../net/listen-host";
import { startServerAddressWatcher } from "../settings-address-watcher";

const token = "isolated-manager-secret";
const resources: ListenerResource[] = [];
const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === "IPv4" && !address.internal)?.address;
// Portable injected bind boundary: use a second local socket if the runner has no LAN NIC.
const publicBindHost = lanAddress ?? "127.0.0.2";
const publicReportedHost = lanAddress ?? "192.0.2.15";
const request = (path: string, init: RequestInit = {}) =>
	new Request(`http://127.0.0.1${path}`, init);
const authenticated = { headers: { authorization: `Bearer ${token}` } };
const calls: string[] = [];

function group(
	options: {
		port?: number;
		host?: string;
		token?: string | null;
		tls?: Bun.TLSOptions;
		dispatch?: (req: Request) => Response | Promise<Response>;
	} = {},
) {
	const host = options.host ?? publicReportedHost;
	const resource = startManagerListenerGroup({
		bindPublic: () => {
			const listener = Bun.serve({
				hostname: host === publicReportedHost ? publicBindHost : host,
				port: options.port ?? 0,
				tls: options.tls,
				fetch: () => new Response("public"),
			});
			resources.push(listener);
			return { listener, host };
		},
		managerToken: options.token === null ? undefined : (options.token ?? token),
		tls: options.tls,
		dispatch:
			options.dispatch ??
			((req) => {
				calls.push(new URL(req.url).pathname);
				return Response.json({ accepted: true });
			}),
	});
	resources.push(resource);
	return resource;
}

async function controlFetch(
	resource: ReturnType<typeof group>,
	path: string,
	init: RequestInit = {},
) {
	const origin = managerControlOrigin({
		host: resource.host,
		port: resource.port as number,
		protocol: resource.url.protocol === "https:" ? "https" : "http",
	});
	return managerFetch(`${origin}${path}`, {
		...authenticated,
		...init,
		signal: AbortSignal.timeout(1500),
	});
}

afterEach(() => {
	for (const resource of resources.splice(0))
		void Promise.resolve(resource.stop(true)).catch(() => {});
	calls.length = 0;
});

describe("restricted same-port control listener", () => {
	test("LAN-only public socket and control socket share the actual allocated port", async () => {
		const resource = group();
		expect(resource.controlListener?.port).toBe(resource.port);
		expect(resource.controlListener?.url.hostname).toBe("127.0.0.1");
		expect(await (await fetch(resource.url, { proxy: false })).text()).toBe("public");
		for (const [method, path] of [
			["GET", "/api/update/check"],
			["POST", "/api/update/download"],
			["POST", "/api/update/apply"],
			["POST", "/api/system/lifecycle/signal"],
		]) {
			expect((await controlFetch(resource, path as string, { method })).status).toBe(200);
		}
		expect(calls).toHaveLength(4);
	});

	test("no session fallback, pages, ordinary API, prefixes, alternate methods or WS", async () => {
		const resource = group();
		for (const headers of [
			{},
			{ authorization: "Bearer session-token" },
			{ cookie: "session=admin" },
		] as HeadersInit[]) {
			expect((await controlFetch(resource, "/api/update/check", { headers })).status).toBe(401);
		}
		for (const [method, path, upgrade] of [
			["GET", "/", false],
			["GET", "/api/health", false],
			["GET", "/api/settings", false],
			["GET", "/ws/narrator", true],
			["GET", "/api/update/check", true],
			["POST", "/api/update/check", false],
			["HEAD", "/api/update/check", false],
			["OPTIONS", "/api/update/check", false],
			["GET", "/api/update/check/", false],
			["GET", "/api/update/check/extra", false],
			["GET", "/api/update/download", false],
			["POST", "/api/system/lifecycle/shutdown", false],
		] as const) {
			const response = await controlFetch(resource, path, {
				method,
				headers: { ...authenticated.headers, ...(upgrade && { upgrade: "websocket" }) },
			});
			expect(response.status).toBe(404);
		}
		expect(calls).toHaveLength(0);
	});

	test("the real socket peer cannot be replaced by forwarded loopback headers", () => {
		const req = request("/api/update/check", {
			headers: { ...authenticated.headers, "x-forwarded-for": "127.0.0.1", "x-real-ip": "::1" },
		});
		for (const peer of ["192.168.1.8", "10.0.0.2", "2001:db8::1", undefined]) {
			expect(managerControlRefusal(req, peer, token)?.status).toBe(401);
		}
		for (const peer of ["127.0.0.1", "127.2.3.4", "::1", "::ffff:127.0.0.1"]) {
			expect(managerControlRefusal(req, peer, token)).toBeUndefined();
		}
	});

	for (const host of ["0.0.0.0", "::", "::1", "127.0.0.1", "127.2.3.4", "localhost"]) {
		test(`${host} already provides loopback: no second listener`, async () => {
			const resource = group({ host });
			expect(resource.controlListener).toBeUndefined();
			expect(await (await controlFetch(resource, "/api/update/check")).text()).toBe("public");
		});
	}

	test("unmanaged LAN-only server does not add a listener", () => {
		const resource = group({ token: null });
		expect(resource.controlListener).toBeUndefined();
		const independent = Bun.serve({
			hostname: "127.0.0.1",
			port: resource.port,
			fetch: () => new Response(),
		});
		resources.push(independent);
	});

	test("TLS uses exactly the same key/certificate on both sockets", async () => {
		const certificate = await generate([{ name: "commonName", value: "localhost" }], {
			keySize: 2048,
		});
		const resource = group({ tls: { cert: certificate.cert, key: certificate.private } });
		expect(resource.url.protocol).toBe("https:");
		expect(resource.controlListener?.url.protocol).toBe("https:");
		expect((await controlFetch(resource, "/api/update/check")).status).toBe(200);
		expect(await (await managerFetch(resource.url.href)).text()).toBe("public");
	});
});

describe("atomic listener lifetime", () => {
	test("companion conflict closes new public socket and is not swallowed by auto-LAN fallback", async () => {
		const blocker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("blocker"),
		});
		resources.push(blocker);
		const port = blocker.port as number;
		const attempts: string[] = [];
		expect(() =>
			startManagerListenerGroup({
				bindPublic: () =>
					listenWithLanFallback("auto-lan", publicReportedHost, (host) => {
						attempts.push(host);
						const listener = Bun.serve({
							hostname: publicBindHost,
							port,
							fetch: () => new Response("partial"),
						});
						resources.push(listener);
						return { listener, host };
					}),
				managerToken: token,
				dispatch: () => new Response(),
			}),
		).toThrow();
		expect(attempts).toEqual([publicReportedHost]);
		const replacement = Bun.serve({ hostname: publicBindHost, port, fetch: () => new Response() });
		resources.push(replacement);
		expect(await (await fetch(blocker.url)).text()).toBe("blocker");
	});

	test("default-port retry recognizes real Bun companion conflicts without leaking public ports", async () => {
		const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		resources.push(blocker);
		let conflict: unknown;
		try {
			group({ port: blocker.port });
		} catch (error) {
			conflict = error;
		}
		expect(isListenerPortConflict(conflict)).toBe(true);
		expect(isListenerPortConflict(new Error("invalid certificate"))).toBe(false);
		const replacement = group();
		expect(replacement.port).not.toBe(blocker.port);
		expect((await controlFetch(replacement, "/api/update/check")).status).toBe(200);
		const freed = Bun.serve({
			hostname: publicBindHost,
			port: blocker.port,
			fetch: () => new Response(),
		});
		resources.push(freed);
	});

	test("group stop detaches both ports synchronously", () => {
		const resource = group();
		void resource.stop(true);
		const replacement = group({ port: resource.port });
		expect(replacement.controlListener?.port).toBe(resource.port);
	});

	test("every member stops even if one stop throws; preserveResponse can later force-close", async () => {
		const stops: string[] = [];
		const resource = startManagerListenerGroup({
			bindPublic: () => ({
				host: "192.0.2.1",
				listener: {
					url: new URL("http://192.0.2.1:1234"),
					port: 1234,
					stop(force) {
						stops.push(`public:${force}`);
						if (force) throw new Error("public failed");
					},
				},
			}),
			managerToken: token,
			dispatch: () => new Response(),
			bindControl: () => ({
				url: new URL("http://127.0.0.1:1234"),
				port: 1234,
				stop(force) {
					stops.push(`control:${force}`);
				},
			}),
		});
		await resource.stop(false);
		await expect(resource.stop(true)).rejects.toBeInstanceOf(AggregateError);
		expect(stops).toEqual(["public:false", "control:false", "public:true", "control:true"]);
	});

	for (const scenario of ["success", "public-failure", "companion-failure"] as const) {
		test(`control request response survives group rebind and rollback: ${scenario}`, async () => {
			let active: ReturnType<typeof group>;
			let retired: ReturnType<typeof group>;
			active = group({
				dispatch: () => {
					retired = active;
					active = rebindHttpListener(
						active,
						() => {
							if (scenario === "public-failure") throw new Error("public bind failed");
							if (scenario === "companion-failure") {
								const blocker = Bun.serve({
									hostname: "127.0.0.1",
									port: 0,
									fetch: () => new Response(),
								});
								resources.push(blocker);
								return group({ port: blocker.port });
							}
							return group({ port: active.port });
						},
						() => group({ port: retired.port }),
						true,
					);
					return Response.json({ port: active.port });
				},
			});
			const port = active.port;
			const response = await controlFetch(active, "/api/update/check");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ port });
			// Wait for rebindHttpListener's documented delayed force-close, not a retry loop.
			await Bun.sleep(240);
			expect((await controlFetch(active, "/api/update/check")).status).toBe(200);
			expect(await (await fetch(active.url, { proxy: false })).text()).toBe("public");
		});
	}

	test("HTTP control response survives same-port transition of both sockets to HTTPS", async () => {
		const certificate = await generate([{ name: "commonName", value: "localhost" }], {
			keySize: 2048,
		});
		const tls = { cert: certificate.cert, key: certificate.private };
		let active: ReturnType<typeof group>;
		active = group({
			dispatch: () => {
				const oldPort = active.port;
				active = rebindHttpListener(
					active,
					() => group({ port: oldPort, tls }),
					() => group({ port: oldPort }),
					true,
				);
				return Response.json({ protocol: active.url.protocol, port: active.port });
			},
		});
		const port = active.port;
		const response = await controlFetch(active, "/api/update/check");
		expect(await response.json()).toEqual({ protocol: "https:", port });
		expect(active.controlListener?.url.protocol).toBe("https:");
		await Bun.sleep(240);
		expect((await controlFetch(active, "/api/update/check")).status).toBe(200);
		expect(await (await managerFetch(active.url.href)).text()).toBe("public");
	});

	test("authorized control dispatch shares accepting/drain tracking at the injection seam", async () => {
		let accepting = true;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const active = new Set<Promise<Response>>();
		let didEnter: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			didEnter = resolve;
		});
		const resource = group({
			dispatch: () => {
				if (!accepting) return new Response("draining", { status: 503 });
				const execution = gate.then(() => Response.json({ accepted: true }));
				active.add(execution);
				didEnter();
				void execution.finally(() => active.delete(execution));
				return execution;
			},
		});
		const pending = controlFetch(resource, "/api/update/check");
		await entered;
		expect(active.size).toBe(1);
		accepting = false;
		expect((await controlFetch(resource, "/api/update/check")).status).toBe(503);
		release();
		await Promise.all(active);
		expect((await pending).status).toBe(200);
		expect(active.size).toBe(0);
	});
});

describe("latest-request DNS rebind coordinator", () => {
	function pendingDns() {
		let resolve: (address: { address: string }) => void = () => {};
		let reject: (error: Error) => void = () => {};
		const promise = new Promise<{ address: string }>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		return { promise, resolve, reject };
	}

	function coordinatorHarness(initialHost?: string, portIntent?: number, hostIntent?: string) {
		let active = group(initialHost ? { host: initialHost } : {});
		let accepting = true;
		let configuredHost = hostIntent ?? initialHost ?? "initial.example";
		let configuredPort = portIntent ?? (active.port as number);
		let lastCommittedIntent: { host: string; port: number } | undefined;
		const commits: string[] = [];
		const pending = new Map<string, ReturnType<typeof pendingDns>>();
		const getCurrentAddress = () => ({ host: active.host, port: active.port });
		const rebind = createManagerRebindCoordinator({
			resolveHost: (host) =>
				resolveManagerListenHost(host, token, () => {
					const lookup = pendingDns();
					pending.set(host, lookup);
					return lookup.promise;
				}),
			getCurrentAddress,
			isAccepting: () => accepting,
			rebind: (host, port, resolvedHost, options) => {
				const old = active;
				active = rebindHttpListener(
					active,
					() => {
						const replacement = group({ host: resolvedHost, port });
						configuredHost = host;
						configuredPort = port;
						lastCommittedIntent = { host, port };
						commits.push(host);
						return replacement;
					},
					() => group({ host: old.host, port: old.port }),
					options?.preserveResponse === true,
				);
				return getCurrentAddress();
			},
		});
		return {
			rebind,
			pending,
			commits,
			getCurrentAddress,
			current: () => active,
			configured: () => configuredHost,
			configuredPort: () => configuredPort,
			lastCommittedIntent: () => lastCommittedIntent,
			shutdown: () => {
				accepting = false;
				void active.stop(true);
			},
		};
	}

	function watchHarness(
		harness: ReturnType<typeof coordinatorHarness>,
		initialFileHost = harness.configured(),
	) {
		const previousHome = process.env.NARRAFORK_HOME;
		const home = mkdtempSync(join(tmpdir(), "nf-control-intent-"));
		const controller = new AbortController();
		const port = harness.configuredPort();
		const changed: string[] = [];
		const requests: Promise<ReturnType<typeof harness.getCurrentAddress>>[] = [];
		let onObserved: (host: string) => void = () => {};
		process.env.NARRAFORK_HOME = home;
		const write = (host: string) =>
			writeFileSync(join(home, "settings.json"), JSON.stringify({ server: { host, port } }));
		write(initialFileHost);
		expect(
			startServerAddressWatcher({
				signal: controller.signal,
				onIntentChanged: (address) => {
					harness.rebind.invalidatePendingUnless(address.host, address.port);
					onObserved(address.host);
					const committed = harness.lastCommittedIntent();
					return (
						committed !== undefined &&
						(address.host !== committed.host || address.port !== committed.port)
					);
				},
				isCurrent: (address) =>
					(address.host === harness.configured() && address.port === harness.configuredPort()) ||
					harness.rebind.isPending(address.host, address.port),
				onChanged: (address) => {
					changed.push(address.host);
					requests.push(harness.rebind(address.host, address.port));
				},
			}),
		).toBe(true);
		return {
			write,
			changed,
			requests,
			nextObserved: () =>
				new Promise<string>((resolve) => {
					onObserved = resolve;
				}),
			stop: () => {
				controller.abort();
				if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
				else process.env.NARRAFORK_HOME = previousHome;
				rmSync(home, { recursive: true, force: true });
			},
		};
	}

	test("unrelated settings writes preserve startup default-port fallback instead of retrying the occupied intent port", async () => {
		const occupied = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("occupied"),
		});
		resources.push(occupied);
		const harness = coordinatorHarness("127.0.0.1", occupied.port);
		const original = harness.current();
		expect(original.port).not.toBe(occupied.port);
		const watcher = watchHarness(harness);
		try {
			const observed = watcher.nextObserved();
			watcher.write("127.0.0.1");
			await observed;
			expect(watcher.changed).toEqual([]);
			expect(harness.commits).toEqual([]);
			expect(harness.current()).toBe(original);
			expect(await (await controlFetch(original, "/api/update/check")).text()).toBe("public");
			expect(await (await fetch(occupied.url, { proxy: false })).text()).toBe("occupied");
		} finally {
			watcher.stop();
		}
	});

	for (const startup of ["auto-lan", "CLI-host-override"] as const) {
		test(`baseline settings saves preserve startup ${startup} intent without a committed rebind`, async () => {
			const harness =
				startup === "auto-lan"
					? coordinatorHarness(undefined, undefined, "auto-lan")
					: coordinatorHarness("127.0.0.2");
			const fileHost = startup === "auto-lan" ? "auto-lan" : "127.0.0.1";
			const original = harness.current();
			const watcher = watchHarness(harness, fileHost);
			try {
				const observed = watcher.nextObserved();
				watcher.write(fileHost);
				await observed;
				expect(watcher.changed).toEqual([]);
				expect(harness.commits).toEqual([]);
				expect(harness.current()).toBe(original);
				expect(await (await fetch(original.url, { proxy: false })).text()).toBe("public");
			} finally {
				watcher.stop();
			}
		});
	}

	for (const source of ["watcher", "route-before-watcher-debounce"] as const) {
		test(`real watcher reverting to current loopback invalidates pending DNS: ${source}`, async () => {
			const harness = coordinatorHarness("127.0.0.1");
			const original = harness.current();
			const watcher = watchHarness(harness);
			try {
				let pending: Promise<ReturnType<typeof harness.getCurrentAddress>>;
				if (source === "watcher") {
					const observed = watcher.nextObserved();
					watcher.write("slow.example");
					expect(await observed).toBe("slow.example");
					pending = watcher.requests[0] as typeof pending;
				} else {
					// A route starts DNS immediately; the file is reverted before the watcher ever
					// observes the temporary slow.example value. The final value equals baseline.
					watcher.write("slow.example");
					pending = harness.rebind("slow.example", original.port as number);
				}
				expect(harness.rebind.isPending("slow.example", original.port as number)).toBe(true);
				const reverted = watcher.nextObserved();
				watcher.write("127.0.0.1");
				expect(await reverted).toBe("127.0.0.1");
				expect(harness.rebind.isPending("slow.example", original.port as number)).toBe(false);
				harness.pending.get("slow.example")?.resolve({ address: "127.0.0.2" });
				expect(await pending).toEqual(harness.getCurrentAddress());
				expect(harness.current()).toBe(original);
				expect(harness.commits).toEqual([]);
				expect(harness.configured()).toBe("127.0.0.1");
				expect(watcher.changed).toEqual(source === "watcher" ? ["slow.example"] : []);
				expect(await (await controlFetch(original, "/api/update/check")).text()).toBe("public");
			} finally {
				watcher.stop();
			}
		});
	}

	test("real watcher reconciles a completed route rebind when the final file value equals baseline", async () => {
		const harness = coordinatorHarness("127.0.0.1");
		const watcher = watchHarness(harness);
		try {
			const port = harness.current().port as number;
			watcher.write("slow.example");
			const route = harness.rebind("slow.example", port);
			harness.pending.get("slow.example")?.resolve({ address: "127.0.0.2" });
			await route;
			expect(harness.configured()).toBe("slow.example");
			const observed = watcher.nextObserved();
			watcher.write("127.0.0.1");
			expect(await observed).toBe("127.0.0.1");
			await Promise.all(watcher.requests);
			expect(watcher.changed).toEqual(["127.0.0.1"]);
			expect(harness.commits).toEqual(["slow.example", "127.0.0.1"]);
			expect(harness.configured()).toBe("127.0.0.1");
			expect(harness.current().host).toBe("127.0.0.1");
			expect(await (await controlFetch(harness.current(), "/api/update/check")).text()).toBe(
				"public",
			);
		} finally {
			watcher.stop();
		}
	});

	test("duplicate real watcher intent preserves an in-flight route rebind without scheduling a second one", async () => {
		const harness = coordinatorHarness("127.0.0.1");
		const watcher = watchHarness(harness);
		try {
			const port = harness.current().port as number;
			watcher.write("slow.example");
			const pendingRoute = harness.rebind("slow.example", port, { preserveResponse: true });
			const dns = harness.pending.get("slow.example");
			const observed = watcher.nextObserved();
			expect(await observed).toBe("slow.example");
			expect(watcher.changed).toEqual([]);
			expect(harness.pending.get("slow.example")).toBe(dns);
			expect(harness.rebind.isPending("slow.example", port)).toBe(true);
			dns?.resolve({ address: "127.0.0.2" });
			expect(await pendingRoute).toEqual({ host: "127.0.0.2", port });
			expect(harness.commits).toEqual(["slow.example"]);
			expect(harness.configured()).toBe("slow.example");
			expect(await (await controlFetch(harness.current(), "/api/update/check")).text()).toBe(
				"public",
			);
		} finally {
			watcher.stop();
		}
	});

	for (const oldOutcome of ["resolve", "reject"] as const) {
		test(`older delayed DNS ${oldOutcome} cannot detach the newest real listener group`, async () => {
			const harness = coordinatorHarness();
			const port = harness.current().port as number;
			const slow = harness.rebind("slow.example", port);
			const fast = harness.rebind("fast.example", port, { preserveResponse: true });
			harness.pending.get("fast.example")?.resolve({ address: publicReportedHost });
			expect(await fast).toEqual(harness.getCurrentAddress());
			const newest = harness.current();
			if (oldOutcome === "resolve") {
				harness.pending.get("slow.example")?.resolve({ address: "127.0.0.2" });
			} else {
				harness.pending.get("slow.example")?.reject(new Error("stale DNS failed"));
			}
			expect(await slow).toEqual(harness.getCurrentAddress());
			expect(harness.current()).toBe(newest);
			expect(harness.commits).toEqual(["fast.example"]);
			expect(harness.configured()).toBe("fast.example");
			expect((await controlFetch(newest, "/api/update/check")).status).toBe(200);
			expect(await (await fetch(newest.url, { proxy: false })).text()).toBe("public");
		});
	}

	test("latest DNS failure cannot revive an older pending configuration", async () => {
		const harness = coordinatorHarness();
		const original = harness.current();
		const port = original.port as number;
		const old = harness.rebind("older.example", port);
		const latest = harness.rebind("latest.example", port);
		harness.pending.get("latest.example")?.reject(new Error("latest DNS failed"));
		await expect(latest).rejects.toThrow("latest DNS failed");
		harness.pending.get("older.example")?.resolve({ address: "127.0.0.2" });
		expect(await old).toEqual(harness.getCurrentAddress());
		expect(harness.current()).toBe(original);
		expect(harness.configured()).toBe("initial.example");
		expect(harness.commits).toEqual([]);
		expect((await controlFetch(original, "/api/update/check")).status).toBe(200);
	});

	test("shutdown rejects both newest and stale DNS completions without reopening sockets", async () => {
		const harness = coordinatorHarness();
		const port = harness.current().port as number;
		const slow = harness.rebind("slow.example", port);
		const latest = harness.rebind("latest.example", port);
		const settled = Promise.allSettled([slow, latest]);
		harness.shutdown();
		harness.pending.get("latest.example")?.resolve({ address: publicReportedHost });
		harness.pending.get("slow.example")?.reject(new Error("DNS failed during shutdown"));
		for (const result of await settled) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(String(result.reason)).toContain("during shutdown");
		}
		expect(harness.commits).toEqual([]);
		await expect(harness.rebind("after-shutdown.example", port)).rejects.toThrow("during shutdown");
		expect(harness.pending.has("after-shutdown.example")).toBe(false);
		// Both old sockets remain detached: a completely fresh resource group owns the same port.
		const replacement = group({ port });
		expect((await controlFetch(replacement, "/api/update/check")).status).toBe(200);
	});
});

describe("DNS bind decision", () => {
	test("actual localhost DNS bind reaches the same service without a companion collision", async () => {
		const host = await resolveManagerListenHost("localhost", token);
		const resource = group({ host });
		expect(resource.controlListener).toBeUndefined();
		expect(await (await controlFetch(resource, "/api/update/check")).text()).toBe("public");
	});

	test("DNS failure leaves the current public/control resource group serving", async () => {
		const resource = group();
		await expect(
			resolveManagerListenHost("machine.example", token, async () => {
				throw new Error("DNS failed before rebind");
			}),
		).rejects.toThrow("DNS failed before rebind");
		expect((await controlFetch(resource, "/api/update/check")).status).toBe(200);
		expect(await (await fetch(resource.url, { proxy: false })).text()).toBe("public");
	});

	for (const address of ["127.0.0.2", "::1", "192.168.1.12"]) {
		test(`hostname resolves before binding: ${address}`, async () => {
			const host = await resolveManagerListenHost("machine.example", token, async () => ({
				address,
			}));
			expect(host).toBe(address);
			const origin = managerControlOrigin({ host, port: 8888, protocol: "http" });
			expect(origin).not.toContain("machine.example");
			expect(origin).toBe(
				`http://${address === "::1" ? "[::1]" : address.startsWith("127.") ? address : "127.0.0.1"}:8888`,
			);
		});
	}

	test("unmanaged mode and IP literals do not need DNS; failures reject before detach", async () => {
		const forbidden = async () => {
			throw new Error("lookup must not run");
		};
		expect(await resolveManagerListenHost("machine.example", undefined, forbidden)).toBe(
			"machine.example",
		);
		for (const host of ["0.0.0.0", "::", "::1", "127.0.0.2"]) {
			expect(await resolveManagerListenHost(host, token, forbidden)).toBe(host);
		}
		await expect(resolveManagerListenHost("machine.example", token, forbidden)).rejects.toThrow(
			"lookup must not run",
		);
		await expect(
			resolveManagerListenHost("machine.example", token, async () => ({
				address: "other.example",
			})),
		).rejects.toThrow("DNS did not return an IP");
	});
});
