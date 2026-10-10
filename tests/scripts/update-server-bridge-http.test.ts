import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
	BRIDGE_POST_LIMIT,
	BridgeHttpError,
	resolveUpdateServerBridgeConfig,
	UpdateServerBridgeHttp,
} from "../../scripts/lib/update-server-bridge-http";

const TOKEN = "test-only-secret-do-not-log";
const config = { serverUrl: "https://bridge.example", token: TOKEN };
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
function http(
	handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
	timeout = 1000,
) {
	return new UpdateServerBridgeHttp(config, {
		fetchImpl: handler as typeof fetch,
		requestTimeoutMs: timeout,
	});
}
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "nf-bridge-http-"));
	roots.push(root);
	return root;
}

describe("explicit bridge configuration", () => {
	test("both absent does not read HOME or create a default", () => {
		expect(resolveUpdateServerBridgeConfig({ HOME: "/private-never-read" })).toBeUndefined();
	});
	test.each([
		{ NF_UPDATE_SERVER: config.serverUrl },
		{ NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "not-a-url", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "http://bridge.example", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "https://user:pass@bridge.example", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "https://bridge.example/base", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "https://bridge.example?token=no", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: "https://bridge.example#fragment", NF_UPDATE_TOKEN: TOKEN },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "  " },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "x\r\ny" },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "x\u0000y" },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "x y" },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "令牌" },
		{ NF_UPDATE_SERVER: config.serverUrl, NF_UPDATE_TOKEN: "x".repeat(4097) },
	])("invalid matrix fails closed %#", (env) => {
		expect(() => resolveUpdateServerBridgeConfig(env)).toThrow();
	});
	test("canonical origin and token omitted from JSON/inspect", () => {
		const resolved = resolveUpdateServerBridgeConfig({
			NF_UPDATE_SERVER: "https://BRIDGE.example:443/",
			NF_UPDATE_TOKEN: TOKEN,
		});
		expect(resolved?.serverUrl).toBe(config.serverUrl);
		expect(resolved?.token).toBe(TOKEN);
		expect(JSON.stringify(resolved)).not.toContain(TOKEN);
		expect(inspect(resolved)).not.toContain(TOKEN);
		expect(inspect(new UpdateServerBridgeHttp(config))).not.toContain(TOKEN);
	});
});

describe("bounded bridge HTTP", () => {
	test("public reads omit authorization; explicit read uses bearer and no redirect", async () => {
		const requests: RequestInit[] = [];
		const client = http((_url, init) => {
			requests.push(init ?? {});
			return Response.json({ ok: true });
		});
		expect(await client.readJson<{ ok: boolean }>("/api/v2/tools/state")).toEqual({ ok: true });
		await client.readJson("/api/v2/tools/state", { authenticated: true });
		expect(new Headers(requests[0].headers).has("Authorization")).toBe(false);
		expect(new Headers(requests[1].headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
		expect(requests.every((request) => request.redirect === "error")).toBe(true);
	});
	test.each([
		"https://elsewhere.example/api/v2/tools/state",
		"//elsewhere.example/api/v2/tools/state",
		"/not-v2",
		"https://user:pass@bridge.example/api/v2/tools/state",
	])("rejects uncontrolled URL %s without fetch", async (path) => {
		let calls = 0;
		await expect(
			http(() => {
				calls++;
				return Response.json({});
			}).readJson(path),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test("never follows authentication redirect or leaks response body/token", async () => {
		const client = http(
			() => new Response(TOKEN, { status: 302, headers: { Location: "https://attacker.example" } }),
		);
		try {
			await client.readJson("/api/v2/tools/state", { authenticated: true });
			throw new Error("expected fail");
		} catch (error) {
			expect(error).toBeInstanceOf(BridgeHttpError);
			expect(inspect(error)).not.toContain(TOKEN);
		}
	});
	test("malformed endpoint URL error does not echo its input", async () => {
		const client = http(() => Response.json({}));
		try {
			await client.readJson(`https://bridge.example:${TOKEN}/api/v2/tools/state`);
			throw new Error("Expected URL error");
		} catch (error) {
			expect(inspect(error)).not.toContain(TOKEN);
		}
	});
	test("fetch error diagnostics are redacted", async () => {
		await expect(
			http(() => {
				throw new Error(`secret ${TOKEN}`);
			}).readJson("/api/v2/tools/state"),
		).rejects.toThrow("operation failed");
	});
	test("404 is optional only when explicitly requested", async () => {
		const client = http(() => new Response(TOKEN, { status: 404 }));
		expect(await client.readJson("/api/v2/tools/state", { allowNotFound: true })).toBeUndefined();
		await expect(client.readJson("/api/v2/tools/state")).rejects.toBeInstanceOf(BridgeHttpError);
	});
	test("declared oversize rejected before body collection", async () => {
		await expect(
			http(() => new Response("{}", { headers: { "Content-Length": "1048577" } })).readJson(
				"/api/v2/tools/state",
			),
		).rejects.toThrow();
	});
	test("stream byte limit cancels unending body", async () => {
		let cancelled = false;
		const client = http(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(8192));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		await expect(client.readHash("/api/v2/tools/file", { maxBytes: 16384 })).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
	test("body deadline includes stalled body even when mock ignores fetch abort", async () => {
		let cancelled = false;
		const client = http(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
			20,
		);
		await expect(client.readJson("/api/v2/tools/state")).rejects.toThrow();
		expect(cancelled).toBe(true);
	});
	test("parent cancellation interrupts stalled fetch", async () => {
		const controller = new AbortController();
		const client = http(() => new Promise<Response>(() => {}));
		const operation = client.readJson("/api/v2/tools/state", { signal: controller.signal });
		controller.abort();
		await expect(operation).rejects.toThrow();
	});
	test("successful download streams exact hash and removes temporary file", async () => {
		const root = await directory();
		const bytes = Buffer.from("original bytes");
		const client = http(() => new Response(bytes));
		const result = await client.download("/api/v2/tools/file", join(root, "download"), {
			maxBytes: 100,
			expected: { size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") },
		});
		expect(result.size).toBe(bytes.length);
		expect(await readFile(join(root, "download"))).toEqual(bytes);
		expect(await readdir(root)).toEqual(["download"]);
	});
	test("bad hashes remove partial file; existing destination is never overwritten", async () => {
		const root = await directory();
		const client = http(() => new Response("new bytes"));
		await expect(
			client.download("/api/v2/tools/file", join(root, "bad"), {
				maxBytes: 100,
				expected: { size: 99 },
			}),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
		await writeFile(join(root, "existing"), "old");
		await expect(
			client.download("/api/v2/tools/file", join(root, "existing"), { maxBytes: 100 }),
		).rejects.toThrow();
		expect(await readFile(join(root, "existing"), "utf8")).toBe("old");
		expect(await readdir(root)).toEqual(["existing"]);
	});
	test("failed download body cancels and cleans exclusive temporary file", async () => {
		const root = await directory();
		const client = http(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(20));
							controller.error(new Error(TOKEN));
						},
					}),
				),
		);
		await expect(
			client.download("/api/v2/tools/file", join(root, "partial"), { maxBytes: 100 }),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	});
	test("full+patch upload rejects total multipart budget before fetch", async () => {
		const root = await directory();
		const file = Bun.file(join(root, "large"));
		const handle = await import("node:fs/promises").then((fs) =>
			fs.open(file.name as string, "wx"),
		);
		await handle.truncate(BRIDGE_POST_LIMIT - 10);
		await handle.close();
		const form = new FormData();
		form.set("file", file, "large.bin");
		let calls = 0;
		await expect(
			http(() => {
				calls++;
				return Response.json({});
			}).upload("/api/v2/products/narrafork/releases", form),
		).rejects.toThrow("multipart");
		expect(calls).toBe(0);
	});
	test("multipart bounded field count prevents header amplification", async () => {
		const form = new FormData();
		for (let i = 0; i < 33; i++) form.set(`field${i}`, "x");
		let calls = 0;
		await expect(
			http(() => {
				calls++;
				return Response.json({});
			}).upload("/api/v2/products/narrafork/releases", form),
		).rejects.toThrow("field count");
		expect(calls).toBe(0);
	});
	test("download stalled body timeout cleans exclusive temporary file", async () => {
		const root = await directory();
		const client = http(() => new Response(new ReadableStream()), 20);
		await expect(
			client.download("/api/v2/tools/file", join(root, "partial"), { maxBytes: 100 }),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	});
	test("dishonest short Content-Length body is rejected and cleaned", async () => {
		const root = await directory();
		const client = http(() => new Response("short", { headers: { "Content-Length": "10" } }));
		await expect(
			client.download("/api/v2/tools/file", join(root, "partial"), { maxBytes: 100 }),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	});
	test("late fetch response after parent cancellation is cancelled rather than leaked", async () => {
		const controller = new AbortController();
		let release: ((response: Response) => void) | undefined;
		const client = http(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		const operation = client.readJson("/api/v2/tools/state", { signal: controller.signal });
		controller.abort();
		await expect(operation).rejects.toThrow();
		let cancelled = false;
		if (!release) throw new Error("Fetch fixture was not started");
		release(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
		);
		await Promise.resolve();
		expect(cancelled).toBe(true);
	});
	test("invalid byte ceilings fail before starting a network request", async () => {
		let calls = 0;
		const client = http(() => {
			calls++;
			return Response.json({});
		});
		await expect(client.readHash("/api/v2/tools/file", { maxBytes: Number.NaN })).rejects.toThrow();
		await expect(client.readJson("/api/v2/tools/state", { maxBytes: -1 })).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test.each([
		false,
		true,
	])("PUT immutable snapshot prevents source inode/path changes during fetch await %#", async (replace) => {
		const root = await directory();
		const path = join(root, "file");
		const original = Buffer.alloc(2 * 1024 * 1024, 65);
		await writeFile(path, original);
		const expected = {
			size: original.length,
			sha256: createHash("sha256").update(original).digest("hex"),
			sha512: createHash("sha512").update(original).digest("base64"),
		};
		const client = http(async (_url, init) => {
			const changed = Buffer.alloc(original.length, 66);
			if (replace) {
				writeFileSync(`${path}.replacement`, changed);
				renameSync(`${path}.replacement`, path);
			} else writeFileSync(path, changed);
			const received = Buffer.from(await new Response(init?.body).arrayBuffer());
			expect(received.length).toBe(expected.size);
			expect(createHash("sha256").update(received).digest("hex")).toBe(expected.sha256);
			return Response.json({ success: true });
		});
		await client.put("/api/v2/tools/file", path, { maxBytes: 3 * 1024 * 1024, expected });
	});
	test("PUT rejects frozen expected hash mismatch before transport", async () => {
		const root = await directory();
		const path = join(root, "file");
		await writeFile(path, "source");
		let calls = 0;
		const client = http(() => {
			calls++;
			return Response.json({});
		});
		await expect(
			client.put("/api/v2/tools/file", path, {
				maxBytes: 100,
				expected: { size: 6, sha256: "0".repeat(64) },
			}),
		).rejects.toThrow("identity mismatch");
		expect(calls).toBe(0);
	});
	test("multipart type header is bounded before fetch", async () => {
		const form = new FormData();
		form.set("file", new Blob(["x"], { type: "x".repeat(257) }), "file");
		let calls = 0;
		await expect(
			http(() => {
				calls++;
				return Response.json({});
			}).upload("/api/v2/products/narrafork/releases", form),
		).rejects.toThrow("filename/type");
		expect(calls).toBe(0);
	});
	test("put sends only file bytes with bounded content length and bearer", async () => {
		const root = await directory();
		await writeFile(join(root, "file"), "tool bytes");
		const client = http(async (_url, init) => {
			expect(init?.method).toBe("PUT");
			expect(new Headers(init?.headers).get("Content-Length")).toBe("10");
			expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
			expect(await new Response(init?.body).text()).toBe("tool bytes");
			return Response.json({ success: true });
		});
		expect(await client.put("/api/v2/tools/file", join(root, "file"), { maxBytes: 32 })).toEqual({
			success: true,
		});
	});
});
