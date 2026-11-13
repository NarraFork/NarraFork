import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	validateWebDavConfig,
	WebDavClient,
	type WebDavConfig,
	WebDavError,
} from "../shared/webdav-transport";
import { createWebDavFixture, webDavMultistatus } from "./fixtures/webdav-fixture";

const config: WebDavConfig = {
	url: "https://dav.example.test/private/",
	feed: "default",
	auth: { username: "private-user", password: "private-password" },
};
const root = "narrafork-mirror-v1/default";
const day = `${root}/ready/narrafork/main/2026-04-20`;
const hash = "a".repeat(64);
const file = `${day}/${hash}.json`;
const objects = `${root}/batches/narrafork/main/2026-04-20/job-1/objects`;
const object = `${objects}/${hash}`;
function signal() {
	return new AbortController().signal;
}
function digest(bytes: Uint8Array) {
	return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function fake(
	handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) =>
		Promise.resolve(handler(new URL(String(input)), init ?? {}))) as typeof fetch;
}
function chunks(values: Uint8Array[], canceled?: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream(
		{
			pull(c) {
				const next = values.shift();
				if (next) c.enqueue(next);
				else c.close();
			},
			cancel() {
				canceled?.();
			},
		},
		{ highWaterMark: 0 },
	);
}
async function read(stream: ReadableStream<Uint8Array> | null) {
	expect(stream).not.toBeNull();
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
function xmlClient(xml: string, status = 207) {
	return new WebDavClient(config, { fetchImpl: fake(() => new Response(xml, { status })) });
}
const href = `/private/${day}/`;

describe("configured streamed object budgets", () => {
	test("rejects unbounded budgets and retains a validated 60-minute ceiling", () => {
		expect(
			validateWebDavConfig({ ...config, transferTimeoutMs: 60 * 60_000 }).transferTimeoutMs,
		).toBe(60 * 60_000);
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60 * 60_000 + 1])
			expect(() => validateWebDavConfig({ ...config, transferTimeoutMs: value })).toThrow();
	});
	for (const method of ["GET", "PUT"] as const)
		test(`${method} applies configured deadline to stalled stream and does not retry`, async () => {
			let cancelled = false;
			let calls = 0;
			const source = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1]));
				},
				cancel() {
					cancelled = true;
				},
			});
			const client = new WebDavClient(
				{ ...config, transferTimeoutMs: 25 },
				{
					fetchImpl: fake(async (_url, init) => {
						calls++;
						if (method === "GET") return new Response(source);
						await new Response(init.body).arrayBuffer();
						return new Response(null, { status: 201 });
					}),
				},
			);
			if (method === "GET")
				await expect(read(await client.getStream(object, 2, signal()))).rejects.toThrow();
			else
				await expect(
					client.put(object, source, digest(new Uint8Array([1, 2])), signal()),
				).rejects.toThrow();
			expect(cancelled).toBe(true);
			expect(calls).toBe(1);
		});
});
describe("WebDAV config and namespace fencing", () => {
	test("remote-peer has an exact namespace without admitting arbitrary kind or path segments", async () => {
		const fixture = createWebDavFixture();
		const client = new WebDavClient(config, { fetchImpl: fixture.fetchImpl });
		const peerObjects = objects.replace("/main/", "/remote-peer/");
		const peerDay = day.replace("/main/", "/remote-peer/");
		await client.ensureCollection(peerObjects, signal());
		await client.ensureCollection(peerDay, signal());
		const bytes = new TextEncoder().encode("canonical peer fixture");
		expect(await client.put(`${peerObjects}/${hash}`, bytes, digest(bytes), signal())).toBe(
			"created",
		);
		expect(await client.getBytes(`${peerObjects}/${hash}`, 100, signal())).toEqual(bytes);
		const calls = fixture.requests.length;
		for (const path of [
			peerDay.replace("/remote-peer/", "/arbitrary/"),
			peerDay.replace("/remote-peer/", "/remote-peer-other/"),
			peerDay.replace("/remote-peer/", "/remote-peer%2fmain/"),
			`${peerDay}/../${hash}.json`,
			`${peerObjects}/../${hash}`,
		])
			await expect(client.getBytes(path, 100, signal())).rejects.toBeInstanceOf(WebDavError);
		expect(fixture.requests).toHaveLength(calls);
	});
	test("validates HTTPS, isolated feed and exact mutually-exclusive credential shape", () => {
		expect(validateWebDavConfig({ ...config, url: config.url.slice(0, -1) }).url).toBe(config.url);
		expect(
			validateWebDavConfig({ ...config, auth: { bearerToken: "bearer-secret" } }).auth,
		).toEqual({ bearerToken: "bearer-secret" });
		for (const url of [
			"http://dav.example.test/private",
			"https://user:pass@dav.example.test/",
			`${config.url}?secret=x`,
			`${config.url}#x`,
			`${config.url}?`,
			`${config.url}#`,
			`${config.url}../other`,
			`${config.url}%2e%2e/other`,
			`${config.url}a%2fb`,
			`${config.url}\\evil`,
			`${config.url}\n`,
		])
			expect(() => validateWebDavConfig({ ...config, url })).toThrow("INVALID_CONFIG");
		for (const auth of [
			{ username: "u", password: "p", bearerToken: "b" },
			{ username: "u:evil", password: "p" },
			{ bearerToken: "b\n" },
			{ username: "u", password: "" },
		])
			expect(() => validateWebDavConfig({ ...config, auth })).toThrow("INVALID_CONFIG");
		for (const feed of ["../evil", "a/b", "", "a%2fb"])
			expect(() => validateWebDavConfig({ ...config, feed })).toThrow();
	});
	test("never contacts transport for outside/invalid paths or non-date DELETE", async () => {
		let calls = 0;
		const client = new WebDavClient(config, {
			fetchImpl: fake(() => {
				calls++;
				return new Response(null, { status: 201 });
			}),
		});
		for (const path of [
			"user/private",
			`${root}/../evil`,
			`${root}/ready/narrafork/main/2026-02-30`,
			`${root.replace("default", "other")}/ready`,
			"/narrafork-mirror-v1/default",
			`${day}/%2e%2e`,
			`${day}/deep/file`,
			`${root}/ready/narrafork/main/2026-04-20/`,
		])
			await expect(client.getBytes(path, 100, signal())).rejects.toBeInstanceOf(WebDavError);
		for (const path of [root, `${root}/ready/narrafork/main`, file, `${objects}/extra`])
			await expect(client.deleteCollection(path, signal())).rejects.toBeInstanceOf(WebDavError);
		expect(calls).toBe(0);
	});
	test("recursive MKCOL, raw conditional objects/ready, bounded GET/list and strict day delete through Hono", async () => {
		const fixture = createWebDavFixture();
		const client = new WebDavClient(config, { fetchImpl: fixture.fetchImpl });
		await client.ensureCollection(objects, signal());
		await client.ensureCollection(day, signal());
		const bytes = new TextEncoder().encode("original bytes π");
		expect(
			await client.put(
				object,
				chunks([bytes.slice(0, 4), bytes.slice(4)]),
				digest(bytes),
				signal(),
			),
		).toBe("created");
		expect(fixture.objects.get(`/private/${object}`)).toEqual(bytes);
		expect(await client.put(object, bytes, digest(bytes), signal())).toBe("exists");
		expect(await client.put(file, bytes, digest(bytes), signal())).toBe("created");
		expect(await client.getBytes(file, 100, signal())).toEqual(bytes);
		expect(await read(await client.getStream(object, bytes.length, signal()))).toEqual(bytes);
		expect(await client.list(day, { signal: signal() })).toEqual([
			{ name: `${hash}.json`, isCollection: false },
		]);
		await client.deleteCollection(`${root}/batches/narrafork/main/2026-04-20`, signal());
		expect(fixture.objects.has(`/private/${object}`)).toBe(false);
		expect(fixture.objects.has(`/private/${file}`)).toBe(true);
		for (const request of fixture.requests) {
			expect(request.headers.get("authorization")).toBe(
				`Basic ${Buffer.from("private-user:private-password").toString("base64")}`,
			);
			if (request.method === "PUT") expect(request.headers.get("if-none-match")).toBe("*");
			if (request.method === "PROPFIND") expect(request.headers.get("depth")).toBe("1");
		}
	});
	test("real loopback fetch streams upload and validates EOF without private HTTPS bypass in config", async () => {
		const fixture = createWebDavFixture();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture.app.fetch });
		try {
			const fetchImpl = fake((url, init) => fetch(new URL(url.pathname, server.url), init));
			const client = new WebDavClient(config, { fetchImpl });
			await client.ensureCollection(objects, signal());
			const bytes = new Uint8Array(128 * 1024).fill(91);
			expect(
				await client.put(
					object,
					chunks([bytes.slice(0, 100), bytes.slice(100)]),
					digest(bytes),
					signal(),
				),
			).toBe("created");
			expect(await read(await client.getStream(object, bytes.length, signal()))).toEqual(bytes);
		} finally {
			await server.stop(true);
		}
	});
});
describe("upload integrity, cancellation and honest acceptance", () => {
	test("large caller byte arrays are uploaded with bounded incremental chunks", async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);
		let largest = 0;
		let received = 0;
		const client = new WebDavClient(config, {
			fetchImpl: fake(async (_url, init) => {
				expect(init.body).toBeInstanceOf(ReadableStream);
				const reader = (init.body as ReadableStream<Uint8Array>).getReader();
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					received += part.value.length;
					largest = Math.max(largest, part.value.length);
				}
				return new Response(null, { status: 201 });
			}),
		});
		expect(await client.put(object, bytes, digest(bytes), signal())).toBe("created");
		expect(received).toBe(bytes.length);
		expect(largest).toBeLessThanOrEqual(64 * 1024);
	});
	test("412 is merely exists; abort unconsumed input and never GET or claim verified", async () => {
		let canceled = false;
		const client = new WebDavClient(config, {
			fetchImpl: fake((_url, init) => {
				expect(init.method).toBe("PUT");
				return new Response(null, { status: 412 });
			}),
		});
		const bytes = new Uint8Array([1, 2]);
		expect(
			await client.put(
				object,
				chunks([bytes], () => {
					canceled = true;
				}),
				digest(bytes),
				signal(),
			),
		).toBe("exists");
		expect(canceled).toBe(true);
	});
	test("rejects successful response before body verification", async () => {
		const bytes = new Uint8Array([1, 2]);
		let canceled = false;
		const client = new WebDavClient(config, {
			fetchImpl: fake(() => new Response(null, { status: 201 })),
		});
		await expect(
			client.put(
				object,
				chunks([bytes], () => {
					canceled = true;
				}),
				digest(bytes),
				signal(),
			),
		).rejects.toThrow("EARLY_RESPONSE");
		expect(canceled).toBe(true);
	});
	test("stream same-size bad hash, truncation and oversized uploads fail", async () => {
		const client = new WebDavClient(config, {
			fetchImpl: fake(async (_url, init) => {
				await new Response(init.body as BodyInit).arrayBuffer();
				return new Response(null, { status: 201 });
			}),
		});
		const bytes = new Uint8Array([1, 2]);
		for (const source of [new Uint8Array([2, 1]), new Uint8Array([1]), new Uint8Array([1, 2, 3])]) {
			await expect(
				client.put(object, chunks([source]), digest(bytes), signal()),
			).rejects.toBeInstanceOf(WebDavError);
			await expect(client.put(object, source, digest(bytes), signal())).rejects.toThrow(
				"INTEGRITY",
			);
		}
	});
	test("pre-canceled request does not fetch; in-flight stalled upload cancels source", async () => {
		let called = false;
		const controller = new AbortController();
		controller.abort(new Error("private-password"));
		const bytes = new Uint8Array([1, 2]);
		const client = new WebDavClient(config, {
			fetchImpl: fake(() => {
				called = true;
				return new Response(null, { status: 201 });
			}),
		});
		await expect(client.put(object, bytes, digest(bytes), controller.signal)).rejects.toThrow(
			"ABORTED",
		);
		expect(called).toBe(false);
		const pending = new AbortController();
		let canceled = false;
		const stalled = new WebDavClient(config, {
			fetchImpl: fake(async (_url, init) => {
				pending.abort();
				await new Response(init.body as BodyInit).arrayBuffer();
				return new Response(null, { status: 201 });
			}),
		});
		await expect(
			stalled.put(
				object,
				chunks([bytes], () => {
					canceled = true;
				}),
				digest(bytes),
				pending.signal,
			),
		).rejects.toThrow("ABORTED");
		expect(canceled).toBe(true);
	});
});
describe("bounded download lifetime and sanitized errors", () => {
	test("abort after response stream start but before awaited headers cancels the discarded body", async () => {
		const entered = Promise.withResolvers<void>();
		const controller = new AbortController();
		let canceled = false;
		const client = new WebDavClient(config, {
			fetchImpl: fake(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(stream) {
								stream.enqueue(new Uint8Array([1, 2, 3]));
								entered.resolve();
							},
							cancel() {
								canceled = true;
							},
						}),
					),
			),
		});
		const pending = client.getStream(object, 10, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(pending).rejects.toThrow("ABORTED");
		expect(canceled).toBe(true);
	});
	test("late response headers after the aborted request already rejected are still canceled", async () => {
		const headers = Promise.withResolvers<Response>();
		const controller = new AbortController();
		let canceled = false;
		const client = new WebDavClient(config, { fetchImpl: fake(() => headers.promise) });
		const pending = client.getStream(object, 10, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("ABORTED");
		headers.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new Uint8Array([1, 2, 3]));
					},
					cancel() {
						canceled = true;
					},
				}),
			),
		);
		await Promise.resolve();
		expect(canceled).toBe(true);
	});
	test("each response-to-reader microtask handoff retains cancel ownership", async () => {
		for (let phase = 0; phase <= 8; phase++) {
			const controller = new AbortController();
			let canceled = false;
			const client = new WebDavClient(config, {
				fetchImpl: fake(
					() =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(stream) {
									stream.enqueue(new Uint8Array([1, 2, 3]));
								},
								cancel() {
									canceled = true;
								},
							}),
						),
				),
			});
			const pending = client.getStream(object, 10, controller.signal);
			const abort = (async () => {
				for (let turn = 0; turn < phase; turn++) await Promise.resolve();
				controller.abort();
			})();
			const [result] = await Promise.allSettled([pending, abort]);
			if (result?.status === "fulfilled" && result.value)
				await expect(read(result.value)).rejects.toThrow("ABORTED");
			else expect(result?.status).toBe("rejected");
			expect(canceled).toBe(true);
		}
	});
	test("idle-stream abort releases the parent listener without requiring a read", async () => {
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		let canceled = false;
		try {
			const client = new WebDavClient(config, {
				fetchImpl: fake(
					() =>
						new Response(
							new ReadableStream({
								cancel() {
									canceled = true;
								},
							}),
						),
				),
			});
			const stream = await client.getStream(object, 2, controller.signal);
			controller.abort();
			expect(canceled).toBe(true);
			expect(remove).toHaveBeenCalled();
			await expect(read(stream)).rejects.toThrow("ABORTED");
		} finally {
			remove.mockRestore();
		}
	});
	test("rejecting HTTP status or length cancels the unconsumed response body", async () => {
		for (const status of [200, 401]) {
			let canceled = false;
			const client = new WebDavClient(config, {
				fetchImpl: fake(
					() =>
						new Response(
							new ReadableStream({
								cancel() {
									canceled = true;
								},
							}),
							{ status, headers: { "content-length": "200" } },
						),
				),
			});
			try {
				await client.getBytes(file, 2, signal());
				throw new Error("expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(WebDavError);
				if (status === 401) expect((error as WebDavError).status).toBe(401);
			}
			expect(canceled).toBe(true);
		}
	});
	test("large streams stay pull-driven and never pre-collect the full body", async () => {
		let produced = 0;
		let canceled = false;
		const client = new WebDavClient(config, {
			fetchImpl: fake(
				() =>
					new Response(
						new ReadableStream(
							{
								pull(c) {
									produced++;
									c.enqueue(new Uint8Array(1024));
								},
								cancel() {
									canceled = true;
								},
							},
							{ highWaterMark: 0 },
						),
					),
			),
		});
		const stream = await client.getStream(object, 4 * 1024 ** 3, signal());
		expect(produced).toBe(0);
		const reader = stream?.getReader();
		expect((await reader?.read())?.value?.length).toBe(1024);
		expect(produced).toBe(1);
		await reader?.cancel();
		expect(canceled).toBe(true);
	});
	test("404 returns null; header, byte and exact EOF limits reject", async () => {
		const missing = new WebDavClient(config, {
			fetchImpl: fake(() => new Response(null, { status: 404 })),
		});
		expect(await missing.getBytes(file, 100, signal())).toBeNull();
		expect(await missing.getStream(object, 2, signal())).toBeNull();
		for (const size of [1, 3]) {
			const client = new WebDavClient(config, {
				fetchImpl: fake(() => new Response(chunks([new Uint8Array(size)]))),
			});
			await expect(read(await client.getStream(object, 2, signal()))).rejects.toBeInstanceOf(
				WebDavError,
			);
		}
		const header = new WebDavClient(config, {
			fetchImpl: fake(() => new Response("toolarge", { headers: { "content-length": "1000" } })),
		});
		await expect(header.getBytes(file, 2, signal())).rejects.toThrow("SIZE_LIMIT");
		const bytes = new WebDavClient(config, {
			fetchImpl: fake(() => new Response(chunks([new Uint8Array(3)]))),
		});
		await expect(bytes.getBytes(file, 2, signal())).rejects.toThrow("SIZE_LIMIT");
	});
	test("parent abort still works after headers and downstream cancel propagates", async () => {
		let canceled = 0;
		const client = new WebDavClient(config, {
			fetchImpl: fake(
				() =>
					new Response(
						new ReadableStream({
							cancel() {
								canceled++;
							},
						}),
					),
			),
		});
		const controller = new AbortController();
		const stream = await client.getStream(object, 2, controller.signal);
		const reading = read(stream);
		controller.abort();
		await expect(reading).rejects.toThrow("ABORTED");
		expect(canceled).toBe(1);
		const other = await client.getStream(object, 2, signal());
		await other?.cancel();
		expect(canceled).toBe(2);
	});
	test("request and body deadline remain active until EOF", async () => {
		const original = globalThis.setTimeout;
		const deadlines: number[] = [];
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: TimerHandler,
			delay?: number,
			...args: unknown[]
		) => {
			deadlines.push(delay ?? 0);
			return Reflect.apply(original, globalThis, [handler, 10, ...args]);
		}) as typeof setTimeout);
		try {
			let canceled = false;
			const client = new WebDavClient(config, {
				fetchImpl: fake(
					() =>
						new Response(
							new ReadableStream({
								cancel() {
									canceled = true;
								},
							}),
						),
				),
			});
			await expect(read(await client.getStream(object, 2, signal()))).rejects.toThrow("TIMEOUT");
			expect(canceled).toBe(true);
			const stalled = new WebDavClient(config, {
				fetchImpl: fake(() => new Promise<Response>(() => {})),
			});
			await expect(stalled.getBytes(file, 2, signal())).rejects.toThrow("TIMEOUT");
			const upload = new WebDavClient(config, {
				fetchImpl: fake(async (_url, init) => {
					await new Response(init.body as BodyInit).arrayBuffer();
					return new Response(null, { status: 201 });
				}),
			});
			let uploadCanceled = false;
			await expect(
				upload.put(
					object,
					new ReadableStream({
						cancel() {
							uploadCanceled = true;
						},
					}),
					{ size: 2, sha256: hash },
					signal(),
				),
			).rejects.toThrow("TIMEOUT");
			expect(uploadCanceled).toBe(true);
			expect(deadlines).toContain(15 * 60_000);
			expect(deadlines).toContain(30_000);
		} finally {
			timer.mockRestore();
		}
	});
	test("redirect:error applies every verb and exception never exposes URL, auth or body", async () => {
		const seen: string[] = [];
		const client = new WebDavClient(config, {
			fetchImpl: fake((_url, init) => {
				expect(init.redirect).toBe("error");
				seen.push(String(init.method));
				return new Response("private-password", {
					status: 302,
					headers: { location: "https://evil.test/" },
				});
			}),
		});
		const bytes = new Uint8Array([1]);
		for (const operation of [
			() => client.ensureCollection(day, signal()),
			() => client.put(object, bytes, digest(bytes), signal()),
			() => client.getBytes(file, 100, signal()),
			() => client.list(day, { signal: signal() }),
			() => client.deleteCollection(day, signal()),
		]) {
			try {
				await operation();
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(WebDavError);
				expect(String(error)).not.toContain("private");
				expect(String(error)).not.toContain("https:");
			}
		}
		expect(seen).toEqual(["MKCOL", "PUT", "GET", "PROPFIND", "DELETE"]);
		const failed = new WebDavClient(config, {
			fetchImpl: fake(() => {
				throw new Error("https://private-user:private-password@dav.example.test/private/");
			}),
		});
		await expect(failed.getBytes(file, 100, signal())).rejects.toThrow("WebDAV NETWORK_ERROR");
	});
});
describe("strict bounded Depth-1 XML discovery", () => {
	test("allows self plus 32 direct entries, not 33; cleanup explicitly allows up to 512", async () => {
		const entries: Array<[string, boolean]> = [
			[href, true],
			...Array.from(
				{ length: 32 },
				(_, i) => [`${href}${String(i).padStart(64, "0")}.json`, false] as [string, boolean],
			),
		];
		expect(
			await xmlClient(webDavMultistatus(entries)).list(day, { signal: signal() }),
		).toHaveLength(32);
		entries.push([`${href}${"b".repeat(64)}.json`, false]);
		await expect(
			xmlClient(webDavMultistatus(entries)).list(day, { signal: signal() }),
		).rejects.toThrow("ENTRY_LIMIT");
		expect(
			await xmlClient(webDavMultistatus(entries)).list(day, { signal: signal(), maxEntries: 512 }),
		).toHaveLength(33);
		await expect(
			xmlClient(webDavMultistatus(entries)).list(day, { signal: signal(), maxEntries: 513 }),
		).rejects.toThrow();
	});
	test("accepts correct default namespace and immediate href only", async () => {
		const good = webDavMultistatus([
			[href, true],
			[`${href}${hash}.json`, false],
		]);
		expect(
			await xmlClient(good.replaceAll("d:", "").replace('xmlns:d="DAV:"', 'xmlns="DAV:"')).list(
				day,
				{ signal: signal() },
			),
		).toEqual([{ name: `${hash}.json`, isCollection: false }]);
		const nested = good.replace(
			`<d:href>${href}${hash}.json</d:href>`,
			`<d:prop><d:href>${href}${hash}.json</d:href></d:prop>`,
		);
		await expect(xmlClient(nested).list(day, { signal: signal() })).rejects.toThrow();
	});
	for (const child of [
		"https://evil.test/secret",
		"https://user:pass@dav.example.test/private/x",
		`${href}../other`,
		`${href}%2e%2e`,
		`${href}deep/file`,
		`${href}file?token=x`,
		`${href}file#x`,
		`/private/user-files/x`,
		`${href}a\\b`,
	]) {
		test(`rejects unsafe href ${child}`, async () => {
			await expect(
				xmlClient(webDavMultistatus([[child, false]])).list(day, { signal: signal() }),
			).rejects.toBeInstanceOf(WebDavError);
		});
	}
	test("supports encoded safe base roots and bearer auth without accepting encoded child paths", async () => {
		const encodedRoot = "https://dav.example.test/private%20root/";
		const fixture = createWebDavFixture({ baseUrl: encodedRoot });
		const client = new WebDavClient(
			{ ...config, url: encodedRoot, auth: { bearerToken: "secret-bearer" } },
			{ fetchImpl: fixture.fetchImpl },
		);
		await client.ensureCollection(day, signal());
		const bytes = new Uint8Array([1]);
		await client.put(file, bytes, digest(bytes), signal());
		expect(await client.list(day, { signal: signal() })).toEqual([
			{ name: `${hash}.json`, isCollection: false },
		]);
		expect(
			fixture.requests.every((r) => r.headers.get("authorization") === "Bearer secret-bearer"),
		).toBe(true);
	});
	test("lists a real Hono collection under an ampersand root with XML-escaped hrefs", async () => {
		const url = "https://dav.invalid/releases&archive/";
		const fixture = createWebDavFixture({ baseUrl: url });
		const client = new WebDavClient({ ...config, url }, { fetchImpl: fixture.fetchImpl });
		await client.ensureCollection(day, signal());
		const bytes = new Uint8Array([1, 2, 3]);
		await client.put(file, bytes, digest(bytes), signal());
		expect(await client.list(day, { signal: signal() })).toEqual([
			{ name: `${hash}.json`, isCollection: false },
		]);
		const response = await fixture.fetchImpl(new URL(`${day}/`, url), {
			method: "PROPFIND",
			headers: { depth: "1" },
		});
		const listing = await response.text();
		expect(listing).toContain(`/releases&amp;archive/${day}/`);
		expect(listing).not.toContain("/releases&archive/");
	});
	test("decodes each predefined entity in href text after tokenization", async () => {
		for (const [entity, character] of [
			["&amp;", "&"],
			["&lt;", "<"],
			["&gt;", ">"],
			["&apos;", "'"],
			["&quot;", '"'],
		]) {
			const url = `https://dav.example.test/private${character}root/`;
			const listing = webDavMultistatus([
				[`/private${character}root/${day}/`, true],
				[`/private${character}root/${file}`, false],
			]);
			expect(listing).toContain(`/private${entity}root/`);
			const client = new WebDavClient(
				{ ...config, url },
				{ fetchImpl: fake(() => new Response(listing, { status: 207 })) },
			);
			expect(await client.list(day, { signal: signal() })).toEqual([
				{ name: `${hash}.json`, isCollection: false },
			]);
		}
	});
	test("decodes decimal and hex references in text and namespace/ordinary attribute values", async () => {
		const good = webDavMultistatus([
			[href, true],
			[`${href}${hash}.json`, false],
		]);
		const listing = good
			.replace(
				'xmlns:d="DAV:"',
				`xmlns:d="D&#65;&#x56;:" note="&amp;&lt;&gt;&apos;&quot; &#9;&#10;&#13;" single='&quot;&apos;'`,
			)
			.replace(hash, `&#97;&#x61;${hash.slice(2)}`)
			.replaceAll("<d:response>", "&#9;&#xA;&#13;<d:response>")
			.replaceAll(
				"HTTP/1.1 200 OK",
				"HTTP/1.1 200 &amp;&lt;&gt;&apos;&quot; &#32;&#x20;&#55295;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;",
			);
		expect(await xmlClient(listing).list(day, { signal: signal() })).toEqual([
			{ name: `${hash}.json`, isCollection: false },
		]);
	});
	test("never recursively decodes entity text or reparses it as markup", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		const literal = good
			.replace("<d:multistatus ", '<d:multistatus note="&amp;unknown; &amp;#0;" ')
			.replace(
				"HTTP/1.1 200 OK",
				"HTTP/1.1 200 &lt;!DOCTYPE x&gt; &lt;d:collection/&gt; &amp;unknown; &amp;#0;",
			);
		expect(await xmlClient(literal).list(day, { signal: signal() })).toEqual([
			{ name: `${hash}.json`, isCollection: false },
		]);
		for (const listing of [
			good.replace('xmlns:d="DAV:"', 'xmlns:d="&amp;#68;AV:"'),
			good.replace(
				"<d:resourcetype></d:resourcetype>",
				"<d:resourcetype>&lt;d:collection/&gt;</d:resourcetype>",
			),
		])
			await expect(xmlClient(listing).list(day, { signal: signal() })).rejects.toThrow(
				"INVALID_XML",
			);
	});
	test("rejects unknown, bare, malformed and illegal character references in text and attributes", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		for (const invalid of [
			"&unknown;",
			"&AMP;",
			"&constructor;",
			"&",
			"&amp",
			"&;",
			"&amp&unknown;",
			"&#;",
			"&#x;",
			"&#X41;",
			"&#-1;",
			"&#+65;",
			"&#x-1;",
			"&#65",
			"&#65x;",
			"&#x41z;",
			"&#0;",
			"&#1;",
			"&#8;",
			"&#11;",
			"&#12;",
			"&#14;",
			"&#31;",
			"&#xD800;",
			"&#55296;",
			"&#xDFFF;",
			"&#57343;",
			"&#xFFFE;",
			"&#65535;",
			"&#x110000;",
			"&#1114112;",
			`&#${"9".repeat(400)};`,
			"\u0000",
			"\u000b",
			"\ufffe",
			"\uffff",
		])
			for (const listing of [
				good.replace(hash, invalid),
				good.replace("<d:multistatus ", `<d:multistatus note="${invalid}" `),
			])
				await expect(xmlClient(listing).list(day, { signal: signal() })).rejects.toThrow(
					"INVALID_XML",
				);
	});
	test("rejects raw UTF-8 surrogates, out-of-range code points and overlong encodings", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		const at = good.indexOf(href);
		const encode = new TextEncoder();
		for (const invalid of [
			[0xed, 0xa0, 0x80],
			[0xed, 0xbf, 0xbf],
			[0xf4, 0x90, 0x80, 0x80],
			[0xc0, 0x80],
		]) {
			const bytes = new Uint8Array([
				...encode.encode(good.slice(0, at)),
				...invalid,
				...encode.encode(good.slice(at)),
			]);
			const client = new WebDavClient(config, {
				fetchImpl: fake(() => new Response(bytes, { status: 207 })),
			});
			await expect(client.list(day, { signal: signal() })).rejects.toThrow("INVALID_XML");
		}
	});
	test("rejects DTD, external and recursively declared entities without resolving them", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		for (const declaration of [
			'<!DOCTYPE d:multistatus SYSTEM "https://evil.test/external.dtd">',
			'<!DOCTYPE d:multistatus [<!ENTITY external SYSTEM "file:///secret">]>',
			'<!DOCTYPE d:multistatus [<!ENTITY loop "&loop;">]>',
			'<!DOCTYPE d:multistatus [<!ENTITY one "&two;"><!ENTITY two "&one;">]>',
		])
			await expect(
				xmlClient(`${declaration}${good}`).list(day, { signal: signal() }),
			).rejects.toThrow("INVALID_XML");
	});
	test("retains namespace restrictions after decoding attribute values", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		for (const attributes of [
			'xmlns:xml="http://www.w3.org/2000/xmln&#x73;/"',
			'xmlns:other="http://www.w3.org/XML/1998/namespac&#101;"',
			'xmlns:a="D&#65;V:" xmlns:b="DAV:" a:x="1" b:x="2"',
		])
			await expect(
				xmlClient(good.replace("<d:multistatus ", `<d:multistatus ${attributes} `)).list(day, {
					signal: signal(),
				}),
			).rejects.toThrow("INVALID_XML");
	});
	test("retains URL containment after decoding character references in hrefs", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		for (const escaped of [
			`${href}&#46;&#46;/other`,
			`${href}&#x2e;&#x2e;/other`,
			`${href}&#37;2e&#37;2e/other`,
			`${href}deep&#47;file`,
			`${href}deep&#x2f;file`,
			`${href}a&#x5c;b`,
			`${href}a&#x3f;token=x`,
			`${href}a&#35;x`,
			`${href}a&#9;b`,
			"https&#58;//evil.test/secret",
			"&#46;&#46;/file",
		])
			await expect(
				xmlClient(good.replace(`${href}${hash}.json`, escaped)).list(day, { signal: signal() }),
			).rejects.toThrow("INVALID_HREF");
	});
	test("rejects reserved/unbound/duplicate namespaces, missing resource type and XML declaration corruption", async () => {
		const good = webDavMultistatus([[`${href}${hash}.json`, false]]);
		for (const value of [
			good.replace("<d:multistatus ", '<d:multistatus toString:x="bad" '),
			good.replace("<d:multistatus ", '<d:multistatus xmlns:xmlns="DAV:" '),
			good.replace("<d:multistatus ", '<d:multistatus xmlns:xml="DAV:" '),
			good.replace('xmlns:d="DAV:"', 'xmlns:d="DAV:" xmlns:d="DAV:"'),
			good.replace(
				"<d:multistatus ",
				'<d:multistatus xmlns:a="DAV:" xmlns:b="DAV:" a:x="1" b:x="2" ',
			),
			good.replace("<d:resourcetype></d:resourcetype>", '<d:resourcetype xmlns:d="evil:"/>'),
			good.replace("<d:resourcetype></d:resourcetype>", ""),
			good.replace('version="1.0"', "version=\"1.0'"),
			good.replace("<d:response>", "<d:response\u00a0>"),
		])
			await expect(xmlClient(value).list(day, { signal: signal() })).rejects.toBeInstanceOf(
				WebDavError,
			);
	});
	test("rejects DTD/entity, malformed/truncated XML, namespace confusion and non-207", async () => {
		const good = webDavMultistatus([
			[href, true],
			[`${href}${hash}.json`, false],
		]);
		for (const value of [
			good.slice(0, -5),
			`${good}<evil/>`,
			good.replace('xmlns:d="DAV:"', 'xmlns:d="evil:"'),
			good.replace('xmlns:d="DAV:"', ""),
			good.replace("</d:response>", "</d:prop>"),
			`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]>${good}`,
			good.replace(hash, "&xxe;"),
			good.replace("<d:multistatus", "<d:multistatus invalid"),
			`${good}<`,
			good.replace("<d:href>", "<d:href/><d:href>"),
			good.replace("HTTP/1.1 200 OK", "HTTP/1.1 500 Bad"),
			good.replace("<d:response>", '<d:response xmlns:d="evil:">'),
		])
			await expect(xmlClient(value).list(day, { signal: signal() })).rejects.toBeInstanceOf(
				WebDavError,
			);
		await expect(xmlClient(good, 200).list(day, { signal: signal() })).rejects.toThrow(
			"HTTP_STATUS",
		);
		await expect(
			xmlClient(" ".repeat(256 * 1024 + 1)).list(day, { signal: signal() }),
		).rejects.toThrow("SIZE_LIMIT");
	});
});

describe("operator-opted GET-only download redirects", () => {
	const downloadHost = "123-184-221-162-v3.pd1.cjjd19.com";
	const signed = `https://${downloadHost}/object?signature=private-signed-query`;
	const enabled: WebDavConfig = { ...config, downloadRedirectHosts: ["*.pd1.cjjd19.com"] };
	function redirect(location: string, status = 302, canceled?: () => void): Response {
		return new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1]));
				},
				cancel() {
					canceled?.();
				},
			}),
			{ status, headers: { location, "set-cookie": "private-cookie=private-secret" } },
		);
	}
	test("normalizes explicit public hosts with PSL/private-suffix checks and preserves absent-field shape", () => {
		expect(validateWebDavConfig(config)).toEqual(config);
		expect(validateWebDavConfig({ ...config, downloadRedirectHosts: [] })).toEqual(config);
		expect(
			validateWebDavConfig({
				...config,
				auth: { bearerToken: "secret" },
				downloadRedirectHosts: [],
			}),
		).toEqual({ ...config, auth: { bearerToken: "secret" } });
		expect(
			validateWebDavConfig({
				...config,
				downloadRedirectHosts: ["*.PD1.CJJD19.COM", downloadHost.toUpperCase(), downloadHost],
			}).downloadRedirectHosts,
		).toEqual(["*.pd1.cjjd19.com", downloadHost]);
		for (const hosts of [
			null,
			"*.pd1.cjjd19.com",
			[""],
			[" "],
			[" cdn.example.com"],
			["cdn.example.com "],
			["https://cdn.example.com"],
			["cdn.example.com:443"],
			["cdn.example.com/path"],
			["cdn.example.com?x"],
			["cdn.example.com#x"],
			["cdn.example.com."],
			["user@cdn.example.com"],
			["com"],
			["co.uk"],
			["github.io"],
			["s3.amazonaws.com"],
			["*.s3.amazonaws.com"],
			["*.co.uk"],
			["*.example.com"],
			["*.localhost"],
			["localhost"],
			["cdn.localhost"],
			["cdn.internal"],
			["cdn.local"],
			["cdn.test"],
			["127.0.0.1"],
			["10.0.0.1"],
			["192.168.1.1"],
			["169.254.169.254"],
			["[::1]"],
			["::1"],
			["0x7f000001"],
			["2130706433"],
			["127.1"],
			["*pd1.cjjd19.com"],
			["a.*.cjjd19.com"],
			Array.from({ length: 9 }, () => downloadHost),
			Array(1),
			[undefined],
		])
			expect(() =>
				validateWebDavConfig({ ...config, downloadRedirectHosts: hosts as string[] }),
			).toThrow("INVALID_CONFIG");
	});

	for (const status of [301, 302, 303, 307, 308]) {
		test(`explicit exact/wildcard GET opt-in follows ${status} without forwarding credentials`, async () => {
			for (const hosts of [[downloadHost], ["*.pd1.cjjd19.com"]]) {
				const seen: Array<{ url: URL; init: RequestInit }> = [];
				let redirectCanceled = false;
				const client = new WebDavClient(
					{ ...config, downloadRedirectHosts: hosts },
					{
						fetchImpl: fake((url, init) => {
							seen.push({ url, init });
							if (seen.length === 1)
								return redirect(signed, status, () => {
									redirectCanceled = true;
								});
							return new Response(new Uint8Array([1, 2, 3]), {
								headers: { "content-length": "3" },
							});
						}),
					},
				);
				expect(await read(await client.getStream(object, 3, signal()))).toEqual(
					new Uint8Array([1, 2, 3]),
				);
				expect(redirectCanceled).toBe(true);
				expect(seen).toHaveLength(2);
				expect(new Headers(seen[0]?.init.headers).get("authorization")).toContain("Basic ");
				const target = seen[1];
				expect(target?.url.href).toBe(signed);
				expect([...new Headers(target?.init.headers).keys()]).toEqual([]);
				expect(target?.init.credentials).toBe("omit");
				expect(target?.init.referrer).toBe("");
				expect(target?.init.referrerPolicy).toBe("no-referrer");
				expect(target?.init.method).toBe("GET");
				expect(target?.init.signal).toBe(seen[0]?.init.signal);
				expect(seen.every((entry) => entry.init.redirect === "manual")).toBe(true);
			}
		});
	}

	test("real Bun fetch exposes opted-in 302 manually, then reaches the CDN without origin secrets", async () => {
		const originRequests: Array<{ method: string; headers: Headers }> = [];
		const cdnRequests: Array<{ path: string; headers: Headers }> = [];
		const options: Array<{ host: string; init: RequestInit }> = [];
		const cdn = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				cdnRequests.push({
					path: `${url.pathname}${url.search}`,
					headers: new Headers(request.headers),
				});
				return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
			},
		});
		const origin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				originRequests.push({ method: request.method, headers: new Headers(request.headers) });
				return new Response("redirect control body", {
					status: 302,
					headers: { location: signed, "set-cookie": "private-cookie=private-secret" },
				});
			},
		});
		try {
			const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
				const logical = new URL(String(input));
				options.push({ host: logical.hostname, init: init ?? {} });
				const base =
					logical.hostname === "dav.example.test"
						? origin.url
						: logical.hostname === downloadHost
							? cdn.url
							: null;
				if (!base) throw new Error("Unexpected test hostname");
				// The wrapper changes only the transport address. Real Bun fetch must
				// still enforce redirect:error/manual, including origin's real 302.
				return fetch(new URL(`${logical.pathname}${logical.search}`, base), init);
			}) as typeof fetch;
			const client = new WebDavClient(enabled, { fetchImpl });
			expect(await read(await client.getStream(object, 3, signal()))).toEqual(
				new Uint8Array([1, 2, 3]),
			);
			expect(options.map((entry) => entry.init.redirect)).toEqual(["manual", "manual"]);
			expect(originRequests[0]?.headers.get("authorization")).toContain("Basic ");
			expect(cdnRequests).toHaveLength(1);
			expect(cdnRequests[0]?.path).toBe("/object?signature=private-signed-query");
			for (const secret of ["authorization", "cookie", "referer", "proxy-authorization"])
				expect(cdnRequests[0]?.headers.get(secret)).toBeNull();
			expect(options[1]?.init.credentials).toBe("omit");
			expect(options[1]?.init.referrerPolicy).toBe("no-referrer");

			const defaults = new WebDavClient(config, { fetchImpl });
			const empty = new WebDavClient({ ...config, downloadRedirectHosts: [] }, { fetchImpl });
			const bytes = new Uint8Array([1]);
			for (const run of [
				() => defaults.getBytes(file, 100, signal()),
				() => empty.getBytes(file, 100, signal()),
				() => client.ensureCollection(day, signal()),
				() => client.put(object, bytes, digest(bytes), signal()),
				() => client.list(day, { signal: signal() }),
				() => client.deleteCollection(day, signal()),
			])
				await expect(run()).rejects.toBeInstanceOf(WebDavError);
			expect(options.slice(2).map((entry) => entry.init.redirect)).toEqual(Array(6).fill("error"));
			expect(originRequests.map((entry) => entry.method)).toEqual([
				"GET",
				"GET",
				"GET",
				"MKCOL",
				"PUT",
				"PROPFIND",
				"DELETE",
			]);
			expect(cdnRequests).toHaveLength(1);
		} finally {
			await origin.stop(true);
			await cdn.stop(true);
		}
	});

	test("default and empty whitelist never follow, even a known CDN hostname", async () => {
		for (const options of [config, { ...config, downloadRedirectHosts: [] }]) {
			let calls = 0;
			let canceled = false;
			const client = new WebDavClient(options, {
				fetchImpl: fake(() => {
					calls++;
					return redirect(signed, 302, () => {
						canceled = true;
					});
				}),
			});
			await expect(client.getBytes(file, 100, signal())).rejects.toThrow("REDIRECT");
			expect(calls).toBe(1);
			expect(canceled).toBe(true);
		}
	});

	for (const location of [
		"https://evil.example.com/file?signature=private-signed-query",
		"https://pd1.cjjd19.com/file",
		"https://notpd1.cjjd19.com/file",
		"https://a.pd1.cjjd19.com.evil.com/file",
		"https://a.pd1-cjjd19.com/file",
		`http://${downloadHost}/file`,
		`https://${downloadHost}:8443/file`,
		`https://user:private-password@${downloadHost}/file`,
		`https://${downloadHost}/file#secret`,
		`https://${downloadHost}/file#`,
		`https://${downloadHost}\\@evil.example.com/file`,
		"https://127.0.0.1/file",
		"https://10.0.0.1/file",
		"https://192.168.0.1/file",
		"https://169.254.169.254/file",
		"https://[::1]/file",
		"https://cdn.localhost/file",
		"https://cdn.internal/file",
		"https://cdn.local/file",
	]) {
		test(`refuses unsafe/nonmatching download target ${location.split("?")[0]}`, async () => {
			let calls = 0;
			let canceled = false;
			const client = new WebDavClient(enabled, {
				fetchImpl: fake(() => {
					calls++;
					return redirect(location, 302, () => {
						canceled = true;
					});
				}),
			});
			try {
				await client.getBytes(file, 100, signal());
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(WebDavError);
				for (const secret of ["private", "https:", "signature", "password"])
					expect(String(error)).not.toContain(secret);
			}
			expect(calls).toBe(1);
			expect(canceled).toBe(true);
		});
	}

	test("exact host does not trust its subdomains; wildcard supports only real subdomain boundaries", async () => {
		let calls = 0;
		const exact = new WebDavClient(
			{ ...config, downloadRedirectHosts: ["pd1.cjjd19.com"] },
			{
				fetchImpl: fake(() => {
					calls++;
					return redirect(signed);
				}),
			},
		);
		await expect(exact.getBytes(file, 100, signal())).rejects.toThrow("REDIRECT_HOST");
		expect(calls).toBe(1);
		const nested = `https://nested.${downloadHost}:443/file`;
		const client = new WebDavClient(enabled, {
			fetchImpl: fake((url) =>
				url.hostname === "dav.example.test" ? redirect(nested) : new Response("ok"),
			),
		});
		expect(await client.getBytes(file, 100, signal())).toEqual(new TextEncoder().encode("ok"));
	});

	test("follows at most three hops, rejects loops, cancels every intermediate body", async () => {
		for (const mode of ["three", "overflow", "loop"] as const) {
			let calls = 0;
			let canceled = 0;
			const client = new WebDavClient(enabled, {
				fetchImpl: fake((_url, init) => {
					calls++;
					if (calls > 1) expect(new Headers(init.headers).get("authorization")).toBeNull();
					if (mode === "three" && calls === 4) return new Response("done");
					const next = mode === "loop" ? "same" : String(calls);
					return redirect(
						`https://${downloadHost}/${next}?signature=private-signed-query`,
						302,
						() => {
							canceled++;
						},
					);
				}),
			});
			if (mode === "three")
				expect(await client.getBytes(file, 100, signal())).toEqual(
					new TextEncoder().encode("done"),
				);
			else
				await expect(client.getBytes(file, 100, signal())).rejects.toThrow(
					mode === "loop" ? "REDIRECT_LOOP" : "REDIRECT_LIMIT",
				);
			expect(calls).toBe(mode === "loop" ? 2 : 4);
			expect(canceled).toBe(mode === "three" ? 3 : calls);
		}
	});

	test("PUT MKCOL PROPFIND DELETE still reject redirects under the opt-in config", async () => {
		let calls = 0;
		let canceled = 0;
		const seen: string[] = [];
		const client = new WebDavClient(enabled, {
			fetchImpl: fake((_url, init) => {
				calls++;
				seen.push(String(init.method));
				return redirect(signed, 307, () => {
					canceled++;
				});
			}),
		});
		const bytes = new Uint8Array([1]);
		for (const run of [
			() => client.ensureCollection(day, signal()),
			() => client.put(object, bytes, digest(bytes), signal()),
			() => client.list(day, { signal: signal() }),
			() => client.deleteCollection(day, signal()),
		])
			await expect(run()).rejects.toThrow("REDIRECT");
		expect(seen).toEqual(["MKCOL", "PUT", "PROPFIND", "DELETE"]);
		expect(calls).toBe(4);
		expect(canceled).toBe(4);
	});

	test("unsupported/missing Location and already-redirected responses fail closed", async () => {
		for (const status of [300, 304, 305, 306]) {
			const client = new WebDavClient(enabled, {
				fetchImpl: fake(() => new Response(null, { status, headers: { location: signed } })),
			});
			await expect(client.getBytes(file, 100, signal())).rejects.toThrow("REDIRECT");
		}
		const missing = new WebDavClient(enabled, {
			fetchImpl: fake(() => new Response(null, { status: 302 })),
		});
		await expect(missing.getBytes(file, 100, signal())).rejects.toThrow("REDIRECT_TARGET");
		const response = new Response("secret");
		Object.defineProperty(response, "redirected", { value: true });
		const followed = new WebDavClient(enabled, { fetchImpl: fake(() => response) });
		await expect(followed.getBytes(file, 100, signal())).rejects.toThrow("REDIRECT");
	});

	test("final byte limits, exact EOF and sanitized network errors still apply", async () => {
		for (const mode of ["header", "oversize", "truncated", "network"] as const) {
			let canceled = 0;
			const client = new WebDavClient(enabled, {
				fetchImpl: fake((url) => {
					if (url.hostname === "dav.example.test")
						return redirect(signed, 302, () => {
							canceled++;
						});
					if (mode === "network") throw new Error(`failed ${signed} private-password`);
					return new Response(
						mode === "truncated"
							? chunks([new Uint8Array([1])])
							: new ReadableStream<Uint8Array>({
									start(c) {
										c.enqueue(new Uint8Array([1, 2, 3, 4]));
									},
									cancel() {
										canceled++;
									},
								}),
						mode === "header" ? { headers: { "content-length": "4" } } : {},
					);
				}),
			});
			try {
				await read(await client.getStream(object, 3, signal()));
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(WebDavError);
				expect(String(error)).not.toContain("private");
				expect(String(error)).not.toContain("https:");
			}
			expect(canceled).toBe(mode === "header" || mode === "oversize" ? 2 : 1);
		}
	});

	test("abort while canceling the first hop never starts another GET", async () => {
		const controller = new AbortController();
		let calls = 0;
		const client = new WebDavClient(enabled, {
			fetchImpl: fake(() => {
				calls++;
				return redirect(signed, 302, () => controller.abort());
			}),
		});
		await expect(client.getStream(object, 3, controller.signal)).rejects.toThrow("ABORTED");
		expect(calls).toBe(1);
	});

	test("abort across a pending redirected fetch still cancels its late response body", async () => {
		const entered = Promise.withResolvers<void>();
		const headers = Promise.withResolvers<Response>();
		const controller = new AbortController();
		let calls = 0;
		let canceled = 0;
		const client = new WebDavClient(enabled, {
			fetchImpl: fake(() => {
				calls++;
				if (calls === 1)
					return redirect(signed, 302, () => {
						canceled++;
					});
				entered.resolve();
				return headers.promise;
			}),
		});
		const pending = client.getStream(object, 3, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(pending).rejects.toThrow("ABORTED");
		headers.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						canceled++;
					},
				}),
			),
		);
		await Promise.resolve();
		expect(canceled).toBe(2);
	});

	test("hop chain shares one deadline through final streaming body", async () => {
		const original = globalThis.setTimeout;
		const deadlines: number[] = [];
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: TimerHandler,
			delay?: number,
			...args: unknown[]
		) => {
			deadlines.push(delay ?? 0);
			return Reflect.apply(original, globalThis, [handler, 10, ...args]);
		}) as typeof setTimeout);
		try {
			let canceled = 0;
			const client = new WebDavClient(enabled, {
				fetchImpl: fake((url) =>
					url.hostname === "dav.example.test"
						? redirect(signed, 302, () => {
								canceled++;
							})
						: new Response(
								new ReadableStream<Uint8Array>({
									cancel() {
										canceled++;
									},
								}),
							),
				),
			});
			await expect(read(await client.getStream(object, 3, signal()))).rejects.toThrow("TIMEOUT");
			expect(deadlines).toEqual([15 * 60_000]);
			expect(canceled).toBe(2);
		} finally {
			timer.mockRestore();
		}
	});
});
