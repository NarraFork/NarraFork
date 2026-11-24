import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	downloadMirrorPatchFromSource,
	resolveMirrorPatchProxyOrigin,
} from "../../scripts/lib/mirror-patch-proxy";

const origin = "https://accelerator.example";
const bytes = "official patch";
const sha256 = createHash("sha256").update(bytes).digest("hex");
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "nf-patch-proxy-test-"));
	dirs.push(dir);
	const controller = new AbortController();
	const patch = {
		repository: "NarraFork/NarraFork",
		tag: "v0.9.15",
		assetId: 42,
		name: "narrafork-0.9.15-linux-x64.from-0.9.14.zstd-patch",
		size: bytes.length,
		sha256,
		outputPath: join(dir, "patch"),
		signal: controller.signal,
	};
	let directCount = 0;
	const run = (
		proxy: string | undefined,
		fetchImpl: NonNullable<Parameters<typeof downloadMirrorPatchFromSource>[3]>,
		timeoutMs?: number,
	) =>
		downloadMirrorPatchFromSource(
			patch,
			proxy,
			async (options) => {
				directCount++;
				expect(options.signal).toBe(controller.signal);
				expect(options.assetId).toBe(42);
				await writeFile(options.outputPath, bytes, { flag: "wx" });
			},
			fetchImpl,
			timeoutMs,
		);
	return { patch, controller, run, directCount: () => directCount };
}

test("configuration accepts only a credential-free HTTPS origin", () => {
	expect(resolveMirrorPatchProxyOrigin()).toBeUndefined();
	expect(resolveMirrorPatchProxyOrigin("")).toBeUndefined();
	expect(resolveMirrorPatchProxyOrigin(`${origin}/`)).toBe(origin);
	for (const value of [
		"http://accelerator.example",
		`${origin}/path`,
		`${origin}?token=x`,
		"https://u:p@accelerator.example",
	])
		expect(() => resolveMirrorPatchProxyOrigin(value)).toThrow();
});

test("without an accelerator the producer reads the official asset", async () => {
	const f = await fixture();
	await f.run(undefined, () => {
		throw new Error("unexpected proxy request");
	});
	expect(f.directCount()).toBe(1);
});

test("verified accelerator payload uses the frozen path and sends no credentials", async () => {
	const f = await fixture();
	await f.run(origin, async (input, init) => {
		expect(input).toBe(
			`${origin}/https://github.com/NarraFork/NarraFork/releases/download/v0.9.15/${f.patch.name}`,
		);
		expect(init?.redirect).toBe("manual");
		expect(init?.credentials).toBe("omit");
		expect([...new Headers(init?.headers)]).toEqual([["accept-encoding", "identity"]]);
		return new Response(bytes);
	});
	expect(await readFile(f.patch.outputPath, "utf8")).toBe(bytes);
	expect(f.directCount()).toBe(0);
});

for (const [label, response] of [
	["wrong hash", () => new Response("x".repeat(bytes.length))],
	["overlong body", () => new Response(`${bytes}x`)],
	["short body", () => new Response("x")],
	[
		"redirect",
		() => new Response(null, { status: 302, headers: { Location: "https://other.example" } }),
	],
] as const) {
	test(`${label} falls back once without leaving proxy output`, async () => {
		const f = await fixture();
		let requests = 0;
		await f.run(origin, async () => {
			requests++;
			return response();
		});
		expect(requests).toBe(1);
		expect(f.directCount()).toBe(1);
		expect(await readFile(f.patch.outputPath, "utf8")).toBe(bytes);
	});
}

test("proxy timeout falls back under the original operation signal", async () => {
	const f = await fixture();
	await f.run(
		origin,
		async (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		},
		10,
	);
	expect(f.directCount()).toBe(1);
});

test("parent cancellation never falls back", async () => {
	const f = await fixture();
	await expect(
		f.run(origin, async () => {
			f.controller.abort();
			throw f.controller.signal.reason;
		}),
	).rejects.toThrow();
	expect(f.directCount()).toBe(0);
});
