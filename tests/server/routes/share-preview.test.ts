import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { SHARE_HTML_MAX_BYTES, SHARE_TEXT_MAX_BYTES } from "../../../shared/share-preview";

const home = await mkdtemp(join(tmpdir(), "nf-share-preview-"));
const oldHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { shareRoutes } = await import("../../../server/routes/shares");
const { createShare, revokeShareRegistry } = await import("../../../server/lib/shares");
const { AppError } = await import("../../../server/lib/errors");
const { shareFileTool } = await import("../../../server/lib/agent/tools/share-file");
const { renderShareHtml, shareHtmlWorkerEntry, shareHtmlWorkerSpecifiers } = await import(
	"../../../server/lib/share-preview-html"
);
const app = new Hono();
app.onError((error, c) =>
	c.json({ error: error.message }, (error instanceof AppError ? error.statusCode : 500) as 400),
);
app.route("/api/shares", shareRoutes);
const ids: string[] = [];
let counter = 0;
async function fixture(name: string, data: string | Uint8Array, bytes?: number) {
	const id = `share-test-${++counter}`;
	const path = join(home, `${id}-${name}`);
	await writeFile(path, data);
	if (bytes) {
		const fd = await open(path, "r+");
		try {
			await fd.truncate(bytes);
		} finally {
			await fd.close();
		}
	}
	ids.push(id);
	const record = createShare({
		id,
		originalName: name,
		storagePath: path,
		size: Bun.file(path).size,
		createdBy: "test",
	});
	return { id, path, record, url: `/api/shares/${id}/preview` };
}
afterEach(() => {
	for (const id of ids.splice(0)) revokeShareRegistry(id);
});
afterAll(async () => {
	if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = oldHome;
	await rm(home, { recursive: true, force: true });
});

describe("share preview HTTP", () => {
	test("video and audio have correct MIME and do not require authentication", async () => {
		for (const [name, mime] of [
			["x.mp4", "video/mp4"],
			["x.mp3", "audio/mpeg"],
			["x.ogg", "audio/ogg"],
			["x.pdf", "application/pdf"],
		]) {
			const f = await fixture(name, "0123456789");
			const response = await app.request(f.url);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(mime);
			expect(response.headers.get("content-disposition")).toBe("inline");
			expect(response.headers.get("cache-control")).toBe("no-store");
			await response.body?.cancel();
		}
	});
	test("native HTTP Range works through the actual Hono route for files larger than 25 MiB", async () => {
		const f = await fixture("big.mp4", "0123456789", 32 * 1024 * 1024);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		try {
			const base = `http://127.0.0.1:${server.port}${f.url}`;
			for (const [range, length] of [
				["bytes=0-9", 10],
				["bytes=-8", 8],
				[`bytes=${32 * 1024 * 1024 - 4}-`, 4],
			] as const) {
				const response = await fetch(base, { headers: { Range: range } });
				expect(response.status).toBe(206);
				expect(response.headers.get("content-range")).toContain(`/33554432`);
				expect(Number(response.headers.get("content-length"))).toBe(length);
				expect((await response.arrayBuffer()).byteLength).toBe(length);
			}
			const invalid = await fetch(base, { headers: { Range: "bytes=999999999-" } });
			expect(invalid.status).toBe(416);
			expect(invalid.headers.get("content-range")).toBe("bytes */33554432");
			await invalid.body?.cancel();
			const head = await fetch(base, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(head.headers.get("content-length")).toBe("33554432");
		} finally {
			server.stop(true);
		}
	});
	test("text is source-bounded and advertises truncation", async () => {
		const f = await fixture("large.txt", "x".repeat(SHARE_TEXT_MAX_BYTES + 100));
		const response = await app.request(f.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-preview-truncated")).toBe("true");
		expect((await response.text()).length).toBe(SHARE_TEXT_MAX_BYTES);
	});
	test("rejects binaries, while extensionless UTF-8 can be previewed", async () => {
		for (const name of ["x.zip", "x.bin", "binary", "spoof.txt", "x.constructor", "x.__proto__"]) {
			const f = await fixture(name, new Uint8Array([0, 255, 1, 2]));
			expect((await app.request(f.url)).status).toBe(400);
			expect((await app.request(`${f.url}-info`)).status).toBe(400);
		}
		const f = await fixture("README", "中文文本");
		expect(await (await app.request(f.url)).text()).toBe("中文文本");
	});
	test("preflight distinguishes missing/expired shares and size rejection", async () => {
		expect((await app.request("/api/shares/missing/preview-info")).status).toBe(404);
		const f = await fixture("x.mp4", "media");
		f.record.expiresAt = new Date(0);
		expect((await app.request(`${f.url}-info`)).status).toBe(404);
		const large = await fixture("x.html", "x", SHARE_HTML_MAX_BYTES + 1);
		expect((await app.request(large.url)).status).toBe(413);
		expect((await app.request(`${large.url}-info`)).status).toBe(413);
	});
	test("HTML cleaning runs in a worker and cannot execute scripts or load external resources", async () => {
		const f = await fixture(
			"x.html",
			'<h1>Hello</h1><script>alert(1)</script><img src="https://evil.test/track"><form action="https://evil.test"><input></form><p onclick="alert(1)" style="color:red">safe</p>',
		);
		const response = await app.request(f.url);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<h1>Hello</h1>");
		expect(html).toContain("color:red");
		expect(html).not.toContain("script");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("https://evil.test");
		const csp = response.headers.get("content-security-policy");
		expect(csp).toContain("sandbox;");
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("allow-scripts");
	});
	test("HTML keeps safe layout CSS while dropping active and oversized CSS", async () => {
		const f = await fixture(
			"layout.html",
			'<div id="bar" style="width:100px;height:20px;background-color:red;margin:2px 4px;padding:3px;border:1px solid #abc;text-decoration:underline;max-height:50vh;position:fixed;background-image:url(https://evil.test/track)"></div><p style="width:100000000px;height:expression(alert(1))">bounded</p><p style="color:rgba(255,0,0,0.5);background-color:hsl(0 100% 50%);margin-left:-2px">colors</p>',
		);
		const response = await app.request(f.url);
		expect(response.status).toBe(200);
		const html = await response.text();
		for (const declaration of [
			"width:100px",
			"height:20px",
			"background-color:red",
			"margin:2px 4px",
			"padding:3px",
			"border:1px solid #abc",
			"text-decoration:underline",
			"max-height:50vh",
			"color:rgba(255,0,0,0.5)",
			"background-color:hsl(0 100% 50%)",
			"margin-left:-2px",
		])
			expect(html).toContain(declaration);
		for (const removed of [
			"position",
			"background-image",
			"evil.test",
			"expression",
			"100000000px",
		])
			expect(html).not.toContain(removed);
	});
	test("worker respects cancellation and does not consume an admission slot", async () => {
		const f = await fixture("x.html", "<p>ok</p>");
		const controller = new AbortController();
		controller.abort();
		await expect(renderShareHtml(f.path, controller.signal)).rejects.toThrow();
		expect(await renderShareHtml(f.path, new AbortController().signal)).toBe("<p>ok</p>");
	});
});

describe("compiled HTML preview", () => {
	test("resolves compiled worker entries and preserves Windows virtual paths", () => {
		expect(shareHtmlWorkerSpecifiers(true, "file:///$bunfs/root/app")[0]).toBe(
			"file:///$bunfs/root/lib/share-preview-worker.js",
		);
		expect(shareHtmlWorkerEntry("file:///C:/%7EBUN/root/server/lib/share-preview-worker.js")).toBe(
			"C:/~BUN/root/server/lib/share-preview-worker.js",
		);
		expect(shareHtmlWorkerEntry("file:///C:/work/share-preview-worker.ts")).toBeInstanceOf(URL);
	});
	test("worker is embedded and usable from a compiled Bun binary", async () => {
		const { safeSpawn } = await import("../../../server/lib/spawn");
		const f = await fixture("compiled.html", "<h1>compiled</h1><script>bad()</script>");
		const entry = join(home, "compiled-preview.ts");
		const binary = join(home, `compiled-preview${process.platform === "win32" ? ".exe" : ""}`);
		const implementation = fileURLToPath(
			new URL("../../../server/lib/share-preview-html.ts", import.meta.url),
		);
		await writeFile(
			entry,
			`import { renderShareHtml } from ${JSON.stringify(implementation.replaceAll("\\", "/"))}; console.log(await renderShareHtml(process.argv[2], new AbortController().signal));`,
		);
		const build = await safeSpawn({
			cmd: [
				process.execPath,
				"build",
				"--compile",
				entry,
				fileURLToPath(new URL("../../../server/lib/share-preview-worker.ts", import.meta.url)),
				"--root",
				fileURLToPath(new URL("../../../", import.meta.url)),
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			timeout: 90_000,
			maxOutputBytes: 8192,
		});
		expect(build.exitCode).toBe(0);
		const run = await safeSpawn({
			cmd: [binary, f.path],
			cwd: home,
			timeout: 15_000,
			maxOutputBytes: 8192,
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("<h1>compiled</h1>");
		expect(run.stdout).not.toContain("bad()");
	}, 120_000);
});

describe("ShareFile preview output", () => {
	test("oversized HTML is shared without claiming an available preview", async () => {
		const path = join(home, "oversized.html");
		await writeFile(path, "x".repeat(SHARE_HTML_MAX_BYTES + 1));
		const result = await shareFileTool.execute({ path, preview: true }, {
			cwd: home,
			narratorId: "test",
		} as Parameters<typeof shareFileTool.execute>[1]);
		ids.push(result.metadata?.shareId as string);
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.preview).toBeUndefined();
		expect(result.metadata?.previewReason).toBe("tooLarge");
		expect(result.output).toContain("Preview unavailable");
	});
	test("tool metadata agrees with preview capability, including unsupported requested types", async () => {
		for (const [name, kind, content] of [
			["sample.mp4", "video", "media"],
			["sample.mp3", "audio", "media"],
			["sample.md", "text", "# hello"],
			["sample.zip", "unsupported", "archive"],
			["README", "text", "hello"],
		]) {
			const path = join(home, name);
			await writeFile(path, content);
			const result = await shareFileTool.execute({ path, preview: true }, {
				cwd: home,
				narratorId: "test",
			} as Parameters<typeof shareFileTool.execute>[1]);
			expect(result.isError).not.toBe(true);
			expect(result.metadata?.previewType).toBe(kind);
			expect(result.metadata?.previewRequested).toBe(true);
			const id = result.metadata?.shareId as string;
			ids.push(id);
			if (kind === "unsupported") {
				expect(result.metadata?.preview).toBeUndefined();
				expect(result.output).toContain("Preview unavailable");
			} else {
				expect(result.metadata?.preview).toBe(true);
				expect((await app.request(result.metadata?.previewUrl as string)).status).toBe(200);
			}
		}
	});
});
