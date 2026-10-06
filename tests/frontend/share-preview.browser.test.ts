import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import puppeteer from "puppeteer-core";
import { classifySharePreview, type SharePreviewRef } from "../../shared/share-preview";

const cache = join(homedir(), ".cache/puppeteer");
const cached = existsSync(cache)
	? new Bun.Glob("chrome/*/chrome-linux64/chrome").scanSync({ cwd: cache, onlyFiles: true })
	: [];
const candidates = [
	process.env.PUPPETEER_EXECUTABLE_PATH,
	"/usr/bin/chromium",
	"/usr/bin/google-chrome",
	...Array.from(cached, (p) => join(homedir(), ".cache/puppeteer", p)),
];
const chrome = candidates.find((p): p is string => !!p && existsSync(p));
const browserTest = chrome ? test : test.skip;

browserTest(
	"share previews in Chromium: large media, native PDF, sandbox HTML, text, modal and unmount",
	async () => {
		const home = await mkdtemp(join(tmpdir(), "nf-share-browser-"));
		const oldHome = process.env.NARRAFORK_HOME;
		process.env.NARRAFORK_HOME = home;
		const { shareRoutes } = await import("../../server/routes/shares");
		const { createShare, revokeShareRegistry } = await import("../../server/lib/shares");
		const { AppError } = await import("../../server/lib/errors");
		const refs: Record<string, SharePreviewRef> = {};
		const ids: string[] = [];
		const bundle = await Bun.build({
			entrypoints: [join(import.meta.dir, "share-preview.browser.fixture.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!bundle.success) throw new Error(bundle.logs.join("\n"));
		const js = bundle.outputs.find((o) => o.path.endsWith(".js"));
		const css = bundle.outputs.find((o) => o.path.endsWith(".css"));
		if (!js) throw new Error("Missing browser bundle");
		const app = new Hono();
		app.onError((error, c) =>
			c.json({ error: error.message }, (error instanceof AppError ? error.statusCode : 500) as 400),
		);
		app.route("/api/shares", shareRoutes);
		app.get("/fixtures", (c) => c.json(refs));
		app.get(
			"/app.js",
			() => new Response(js, { headers: { "Content-Type": "application/javascript" } }),
		);
		app.get("/app.css", () => new Response(css ?? "", { headers: { "Content-Type": "text/css" } }));
		app.get("/", (c) =>
			c.html(
				'<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
			),
		);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
		const browser = await puppeteer.launch({
			executablePath: chrome,
			headless: true,
			// Chromium's built-in PDF reader is an extension; default Puppeteer disables extensions.
			enableExtensions: true,
			args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
			timeout: 15_000,
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 900, height: 1000 });
			await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle0" });
			// Generate a tiny real WebM with browser APIs: no FFmpeg dependency.
			const encoded = await page.evaluate(async () => {
				const canvas = document.createElement("canvas");
				canvas.width = 320;
				canvas.height = 180;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("No canvas context");
				const stream = canvas.captureStream(10);
				const chunks: Blob[] = [];
				const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
				const stopped = new Promise<void>((resolve) => {
					recorder.onstop = () => resolve();
				});
				recorder.ondataavailable = (event) => chunks.push(event.data);
				recorder.start();
				const paint = setInterval(() => {
					context.fillStyle = "#3040a0";
					context.fillRect(0, 0, 320, 180);
					context.fillStyle = "white";
					context.fillText(String(Date.now()), 10, 30);
				}, 100);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				recorder.stop();
				await stopped;
				clearInterval(paint);
				for (const track of stream.getTracks()) track.stop();
				return btoa(String.fromCharCode(...new Uint8Array(await new Blob(chunks).arrayBuffer())));
			});
			const add = async (
				name: string,
				filename: string,
				data: Uint8Array | string,
				padBytes = 0,
			) => {
				const path = join(home, filename);
				await writeFile(path, data);
				if (padBytes) {
					const fd = await open(path, "r+");
					try {
						await fd.truncate(padBytes);
					} finally {
						await fd.close();
					}
				}
				const id = `browser-${name}`;
				ids.push(id);
				createShare({
					id,
					originalName: filename,
					storagePath: path,
					size: Bun.file(path).size,
					createdBy: "browser-test",
				});
				refs[name] = {
					...classifySharePreview(filename),
					filename,
					url: `/api/shares/${id}/preview`,
					downloadUrl: `/api/shares/${id}`,
				};
			};
			const video = Buffer.from(encoded, "base64");
			// Append a valid EBML Void element so the video exceeds the old 25 MiB blob limit.
			const voidHeader = new Uint8Array(9);
			voidHeader[0] = 0xec;
			voidHeader[1] = 1;
			new DataView(voidHeader.buffer).setUint32(5, 32 * 1024 * 1024);
			await add(
				"video",
				"big.webm",
				Buffer.concat([video, voidHeader]),
				video.length + 9 + 32 * 1024 * 1024,
			);
			const wav = new Uint8Array(44);
			const view = new DataView(wav.buffer);
			wav.set(new TextEncoder().encode("RIFF"), 0);
			view.setUint32(4, 32 * 1024 * 1024 + 36, true);
			wav.set(new TextEncoder().encode("WAVEfmt "), 8);
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 44100, true);
			view.setUint32(28, 88200, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			wav.set(new TextEncoder().encode("data"), 36);
			view.setUint32(40, 32 * 1024 * 1024, true);
			await add("audio", "big.wav", wav, 44 + 32 * 1024 * 1024);
			await add(
				"html",
				"page.html",
				'<h1>Safe HTML</h1><div id="layout-bar" style="width:100px;height:20px;background-color:red"></div><script>window.top.hacked=true</script><img src="https://evil.invalid/track">',
			);
			await add("markdown", "note.md", "# Shared Markdown\n\n**Works**");
			await add("json", "data.json", '{"answer":42}');
			await add("zip", "archive.zip", "archive");
			await add(
				"image",
				"pixel.png",
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfkAAAAASUVORK5CYII=",
					"base64",
				),
			);
			// A visible text page, not a blank PDF that could pass with an empty iframe.
			const pdfText = "Shared PDF preview";
			const pdfContent = `q 1 0 0 rg 20 160 100 30 re f Q\nBT /F1 18 Tf 20 100 Td (${pdfText}) Tj ET`;
			let pdf = "%PDF-1.4\n";
			const objects = [
				"<< /Type /Catalog /Pages 2 0 R >>",
				"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
				`<< /Length ${pdfContent.length} >>\nstream\n${pdfContent}\nendstream`,
				"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			];
			const offsets = objects.map((object, index) => {
				const offset = pdf.length;
				pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
				return offset;
			});
			const xref = pdf.length;
			pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
			await add("pdf", "report.pdf", pdf);
			const ranges: string[] = [];
			page.on("request", (request) => {
				if (request.url().includes("/preview") && request.headers().range)
					ranges.push(request.headers().range);
			});
			await page.reload({ waitUntil: "networkidle0" });
			const before = await page.$eval(
				'[data-case="video"]',
				(el) => el.getBoundingClientRect().height,
			);
			const load = async (name: string) => {
				await page.$eval(`[data-case="${name}"]`, (el) => {
					const button = [...el.querySelectorAll("button")].find(
						(b) => b.textContent === "Load preview",
					);
					if (!button) throw new Error("missing load button");
					button.click();
				});
			};
			await load("video");
			await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2, {
				timeout: 15_000,
			});
			await page.$eval("video", async (video) => {
				video.muted = true;
				await video.play();
			});
			await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 0.2);
			await page.$eval("video", (video) => {
				video.currentTime = 0.8;
			});
			await page.waitForFunction(() => !document.querySelector("video")?.seeking);
			expect(await page.$eval("video", (video) => video.src.startsWith("blob:"))).toBe(false);
			expect(
				await page.$eval('[data-case="video"]', (el) => el.getBoundingClientRect().height),
			).toBe(before);
			await load("audio");
			await page.waitForFunction(() => (document.querySelector("audio")?.readyState ?? 0) >= 2);
			await page.$eval("audio", async (audio) => {
				await audio.play();
				audio.currentTime = 60;
			});
			await page.waitForFunction(
				() =>
					!document.querySelector("audio")?.seeking &&
					(document.querySelector("audio")?.currentTime ?? 0) >= 60,
			);
			expect(ranges.length).toBeGreaterThan(0);
			await load("html");
			await page.waitForSelector('[data-case="html"] iframe');
			const frame = await (await page.$('[data-case="html"] iframe'))?.contentFrame();
			expect(await frame?.$eval("h1", (el) => el.textContent)).toBe("Safe HTML");
			expect(
				await frame?.$eval("#layout-bar", (el) => ({
					width: el.getBoundingClientRect().width,
					height: el.getBoundingClientRect().height,
				})),
			).toEqual({ width: 100, height: 20 });
			expect(await page.evaluate(() => "hacked" in window)).toBe(false);
			expect(
				await page.$eval('[data-case="html"] iframe', (el) => el.getAttribute("sandbox")),
			).toBe("");
			await page.$eval('[data-case="pdf"]', (el) => el.scrollIntoView());
			await load("pdf");
			await page.waitForSelector('[data-case="pdf"] iframe');
			expect(
				await page.$eval('[data-case="pdf"] iframe', (el) => el.getAttribute("sandbox")),
			).toBeNull();
			const pdfFrame = await (await page.$('[data-case="pdf"] iframe'))?.contentFrame();
			if (!pdfFrame) throw new Error("Missing PDF frame");
			const viewerFrame = await page.waitForFrame(
				(candidate) =>
					candidate.parentFrame() === pdfFrame && candidate.url().startsWith("chrome-extension://"),
				{ timeout: 15_000 },
			);
			// URL updates precede the final extension document/context; wait through that navigation.
			await viewerFrame.waitForSelector("pdf-viewer", { timeout: 15_000 });
			// Chromium-specific reader state: decoded page dimensions must be available.
			// Evaluate in its main world; isolated-world custom-element registries differ.
			const pdfState = await viewerFrame.evaluate(async () => {
				await customElements.whenDefined("pdf-viewer");
				const viewer = document.querySelector("pdf-viewer") as HTMLElement & {
					loadState_?: string;
					initialLoadComplete_?: boolean;
					documentDimensions?: { pageDimensions: unknown[] };
				};
				const deadline = Date.now() + 5000;
				while (viewer.loadState_ === "loading" && Date.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					state: viewer.loadState_,
					loaded: viewer.initialLoadComplete_,
					pages: viewer.documentDimensions?.pageDimensions.length,
				};
			});
			expect(pdfState).toEqual({ state: "success", loaded: true, pages: 1 });
			// Inspect the actual iframe screenshot in memory. A blank iframe or an unloaded
			// reader cannot paint the PDF's red rectangle; iframe existence alone is insufficient.
			const pdfElement = await page.$('[data-case="pdf"] iframe');
			if (!pdfElement) throw new Error("Missing visible PDF iframe");
			const image = Buffer.from(await pdfElement.screenshot()).toString("base64");
			const redPixels = await page.evaluate(async (encoded) => {
				const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
				const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
				try {
					const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					const context = canvas.getContext("2d");
					if (!context) throw new Error("Missing screenshot pixel context");
					context.drawImage(bitmap, 0, 0);
					const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
					let red = 0;
					for (let index = 0; index < pixels.length; index += 4) {
						if (pixels[index] > 220 && pixels[index + 1] < 50 && pixels[index + 2] < 50) red++;
					}
					return red;
				} finally {
					bitmap.close();
				}
			}, image);
			expect(redPixels).toBeGreaterThan(1000);
			await load("markdown");
			await page.waitForSelector('[data-case="markdown"] h1');
			await load("json");
			await page.waitForFunction(() =>
				document.querySelector('[data-case="json"]')?.textContent?.includes('"answer": 42'),
			);
			expect(await page.$eval('[data-case="zip"]', (el) => el.textContent)).toContain(
				"cannot be previewed",
			);
			await page.waitForFunction(
				() =>
					(document.querySelector('[data-case="image"] img') as HTMLImageElement | null)
						?.naturalWidth === 1,
			);
			// Expanding removes inline media; closing never silently resumes playback.
			await page.$eval('[data-case="video"]', (el) =>
				(
					[...el.querySelectorAll("button")].find(
						(b) => b.textContent === "Expand preview",
					) as HTMLButtonElement
				).click(),
			);
			await page.waitForSelector('[role="dialog"] video');
			expect(await page.$('[data-case="video"] video')).toBeNull();
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
			expect(await page.$('[data-case="video"] video')).toBeNull();
			const released = await page.evaluate(() => {
				const audio = document.querySelector("audio");
				(
					window as unknown as { sharePreviewHarness: { unmount(): void } }
				).sharePreviewHarness.unmount();
				return new Promise<{ paused: boolean; source: string | null }>((resolve) =>
					setTimeout(
						() =>
							resolve({
								paused: audio?.paused ?? false,
								source: audio?.getAttribute("src") ?? null,
							}),
						0,
					),
				);
			});
			expect(released).toEqual({ paused: true, source: null });
		} finally {
			await browser.close();
			server.stop(true);
			for (const id of ids) revokeShareRegistry(id);
			if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = oldHome;
			await rm(home, { recursive: true, force: true });
		}
	},
	90_000,
);
