import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { WorkerHandle } from "../../../server/lib/worker-runtime/lifecycle";
import {
	SHARE_HTML_MAX_BYTES,
	SHARE_HTML_OUTPUT_MAX_BYTES,
	SHARE_HTML_TIMEOUT_MS,
	SHARE_TEXT_MAX_BYTES,
} from "../../../shared/share-preview";

const home = await mkdtemp(join(tmpdir(), "nf-share-preview-"));
const oldHome = process.env.NARRAFORK_HOME;
process.env.NARRAFORK_HOME = home;
const { shareRoutes } = await import("../../../server/routes/shares");
const { createShare, revokeShareRegistry } = await import("../../../server/lib/shares");
const { AppError } = await import("../../../server/lib/errors");
const { narraforkDir } = await import("../../../server/lib/settings");
const { shareFileTool } = await import("../../../server/lib/agent/tools/share-file");
const {
	closeSharePreviewHtmlWorkers,
	renderShareHtml,
	resetSharePreviewHtmlWorkersForTests,
	shareHtmlWorkerSpecifiers,
} = await import("../../../server/lib/share-preview-html");
const restoreSpies: (() => void)[] = [];
const nativeHandles: ReturnType<typeof WorkerHandle.thread>[] = [];

/** Fault injection still launches native threads through the production ownership primitive. */
function htmlWorkerFixture(body: string, ready = true, dispatches = 1) {
	const launch = WorkerHandle.thread;
	let dispatched = 0;
	let started!: () => void;
	const startedTask = new Promise<void>((resolve) => {
		started = resolve;
	});
	let created!: () => void;
	const createdTask = new Promise<void>((resolve) => {
		created = resolve;
	});
	const exited = new Set<ReturnType<typeof WorkerHandle.thread>>();
	const spy = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const handle = launch(
			`const { parentPort } = require("node:worker_threads");
			parentPort.on("message", path => {
				parentPort.postMessage({ ready: true, dispatched: path });
				${body}
			});
			${ready ? "parentPort.postMessage({ ready: true });" : ""}`,
			{ eval: true },
		);
		nativeHandles.push(handle);
		created();
		void handle.exited.then(() => exited.add(handle));
		handle.resource.on("message", (message) => {
			if (typeof message.dispatched === "string" && ++dispatched === dispatches) started();
		});
		return handle;
	});
	restoreSpies.push(() => spy.mockRestore());
	return {
		spy,
		createdTask,
		startedTask,
		exited,
		get dispatched() {
			return dispatched;
		},
	};
}

function forbidMainThreadHtmlRead() {
	const spy = spyOn(Bun, "file").mockImplementation(() => {
		throw new Error("HTML must not be read on the main thread");
	});
	restoreSpies.push(() => spy.mockRestore());
	return spy;
}

function shortenHtmlTimeout() {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
		timeout(ms === SHARE_HTML_TIMEOUT_MS ? 500 : ms),
	);
	restoreSpies.push(() => spy.mockRestore());
	return spy;
}
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
afterEach(async () => {
	await resetSharePreviewHtmlWorkersForTests();
	await Promise.all(nativeHandles.splice(0).map((handle) => handle.close()));
	for (const restore of restoreSpies.splice(0).reverse()) restore();
	for (const id of ids.splice(0)) revokeShareRegistry(id);
});
afterAll(async () => {
	await closeSharePreviewHtmlWorkers();
	if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = oldHome;
	await rm(home, { recursive: true, force: true });
});

describe("share preview HTTP", () => {
	test.each([
		"request-recordings",
		"saved-request-recordings",
	])("all public share routes hide %s even after a registry path changes", async (directory) => {
		const f = await fixture("ordinary.json", "public workspace evidence");
		const privateDir = join(narraforkDir, directory, `share-privacy-${f.id}`);
		await mkdir(privateDir, { recursive: true });
		const privateFile = join(privateDir, "request.json");
		await writeFile(privateFile, "private-recording-marker");
		try {
			f.record.storagePath = privateFile;
			for (const ending of ["", "/preview", "/preview-info"]) {
				const response = await app.request(`/api/shares/${f.id}${ending}`);
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain("private-recording-marker");
			}
		} finally {
			await rm(privateDir, { recursive: true, force: true });
		}
	});
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

describe("HTML worker admission and ownership", () => {
	test("hot re-evaluation cannot reopen a production-closed HTML pool", async () => {
		const f = await fixture("closed-across-hot.html", "<p>must remain closed</p>");
		await closeSharePreviewHtmlWorkers();
		// Bun normalizes URL queries; an actual neighboring copy guarantees fresh module evaluation.
		const source = new URL("../../../server/lib/share-preview-html.ts", import.meta.url);
		const copy = new URL(
			`../../../server/lib/.share-preview-html-hot-${crypto.randomUUID()}.ts`,
			import.meta.url,
		);
		await writeFile(copy, await readFile(source, "utf8"), { flag: "wx" });
		try {
			const reloaded = await import(copy.href);
			expect(reloaded.renderShareHtml).not.toBe(renderShareHtml);
			const launch = spyOn(WorkerHandle, "thread").mockImplementation(() => {
				throw new Error("closed owner tried to create another thread");
			});
			restoreSpies.push(() => launch.mockRestore());
			await expect(
				reloaded.renderShareHtml(f.path, new AbortController().signal),
			).rejects.toMatchObject({ statusCode: 503, code: "SHARE_PREVIEW_FAILED" });
			expect(launch).not.toHaveBeenCalled();
		} finally {
			await rm(copy, { force: true });
		}
	});
	test("native worker still enforces input and sanitized output byte budgets", async () => {
		const input = await fixture("too-large.html", "x", SHARE_HTML_MAX_BYTES + 1);
		await expect(renderShareHtml(input.path, new AbortController().signal)).rejects.toMatchObject({
			statusCode: 422,
			message: "HTML preview exceeds 1 MiB",
		});
		const output = await fixture(
			"expanded.html",
			"&".repeat(Math.floor(SHARE_HTML_OUTPUT_MAX_BYTES / 5) + 1),
		);
		const response = await app.request(output.url);
		expect(response.status).toBe(422);
		expect(await response.text()).toContain("HTML preview output exceeds budget");
	});

	test("two active native workers reject the next public request with 429 and no queue", async () => {
		const f = await fixture("busy.html", "<p>busy</p>");
		const injected = htmlWorkerFixture("", true, 2);
		const controllers = [new AbortController(), new AbortController()];
		const results = Promise.allSettled(controllers.map((c) => renderShareHtml(f.path, c.signal)));
		await injected.startedTask;
		const response = await app.request(f.url);
		expect(response.status).toBe(429);
		expect(await response.text()).toContain("Preview busy; please retry");
		expect(injected.spy).toHaveBeenCalledTimes(2);
		for (const controller of controllers) controller.abort();
		for (const result of await results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason.statusCode).toBe(504);
		}
		expect(injected.exited.size).toBe(2);
	});

	test("duplicate ready messages do not dispatch again and each result closes its one-shot thread", async () => {
		const f = await fixture("one-shot.html", "unused");
		const injected = htmlWorkerFixture(
			'parentPort.postMessage({ ready: true }); parentPort.postMessage({ html: "<p>native</p>" });',
		);
		for (let n = 0; n < 2; n++) {
			const html = await renderShareHtml(f.path, new AbortController().signal);
			expect(html).toBe("<p>native</p>");
			expect(injected.exited.size).toBe(n + 1);
		}
		expect(injected.spy).toHaveBeenCalledTimes(2);
		expect(injected.dispatched).toBe(2);
	});

	test("constructor failure rejects without main-thread HTML work", async () => {
		const f = await fixture("unavailable.html", "<p>must not run inline</p>");
		const read = forbidMainThreadHtmlRead();
		const launch = spyOn(WorkerHandle, "thread").mockImplementation(() => {
			throw new Error("native worker creation denied");
		});
		restoreSpies.push(() => launch.mockRestore());
		await expect(renderShareHtml(f.path, new AbortController().signal)).rejects.toThrow(
			"native worker creation denied",
		);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(read).not.toHaveBeenCalled();
	});

	test.each([
		"throw new Error('native sanitizer crashed');",
		"process.exit(7);",
	])("native runtime failure is not replayed or run inline: %s", async (body) => {
		const f = await fixture("crash.html", "<script>unsafe()</script>");
		const injected = htmlWorkerFixture(body);
		const read = forbidMainThreadHtmlRead();
		await expect(renderShareHtml(f.path, new AbortController().signal)).rejects.toThrow();
		expect(injected.spy).toHaveBeenCalledTimes(1);
		expect(injected.dispatched).toBe(1);
		expect(injected.exited.size).toBe(1);
		expect(read).not.toHaveBeenCalled();
	});

	test.each([false, true])("total timeout covers a native worker ready=%s", async (ready) => {
		const f = await fixture("timeout.html", "<p>never inline</p>");
		const injected = htmlWorkerFixture("", ready);
		const read = forbidMainThreadHtmlRead();
		const timeout = shortenHtmlTimeout();
		await expect(renderShareHtml(f.path, new AbortController().signal)).rejects.toMatchObject({
			statusCode: 504,
			code: "SHARE_PREVIEW_TIMEOUT",
		});
		expect(timeout).toHaveBeenCalledWith(SHARE_HTML_TIMEOUT_MS);
		expect(injected.spy).toHaveBeenCalledTimes(1);
		expect(injected.dispatched).toBe(ready ? 1 : 0);
		expect(injected.exited.size).toBe(1);
		expect(read).not.toHaveBeenCalled();
	});

	test.each([
		false,
		true,
	])("production close disables admission and waits for native exit, ready=%s", async (ready) => {
		const f = await fixture("close.html", "<p>no reopening</p>");
		const injected = htmlWorkerFixture("", ready);
		const read = forbidMainThreadHtmlRead();
		const active = Promise.allSettled([renderShareHtml(f.path, new AbortController().signal)]);
		await (ready ? injected.startedTask : injected.createdTask);
		const closing = closeSharePreviewHtmlWorkers();
		expect(closeSharePreviewHtmlWorkers()).toBe(closing);
		await closing;
		for (const result of await active) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason.statusCode).toBe(503);
		}
		expect(injected.exited.size).toBe(1);
		expect(injected.dispatched).toBe(ready ? 1 : 0);
		await expect(renderShareHtml(f.path, new AbortController().signal)).rejects.toMatchObject({
			statusCode: 503,
		});
		expect(injected.spy).toHaveBeenCalledTimes(1);
		expect(read).not.toHaveBeenCalled();
	});

	test("reset is explicit and repeatable after production close", async () => {
		await closeSharePreviewHtmlWorkers();
		await resetSharePreviewHtmlWorkersForTests();
		await resetSharePreviewHtmlWorkersForTests();
		const f = await fixture("reset.html", "<p>reset</p>");
		expect(await renderShareHtml(f.path, new AbortController().signal)).toBe("<p>reset</p>");
	});
});

describe("compiled HTML preview", () => {
	test("resolves compiled worker entries", () => {
		expect(shareHtmlWorkerSpecifiers(true, "file:///$bunfs/root/app")[0]).toBe(
			"file:///$bunfs/root/lib/share-preview-worker.js",
		);
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
