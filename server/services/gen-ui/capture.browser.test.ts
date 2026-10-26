import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseUiMarkup, type UiNode } from "@shared/gen-ui-markup";
import { createPreviewShell } from "@shared/gen-ui-preview-shell";
import { captureGenUiSnapshot } from "./capture";

// Requires a sandbox-capable Chrome. Never add --no-sandbox to make this suite pass.
const browserTests = process.env.NF_TEST_GEN_UI_CAPTURE === "1" ? describe : describe.skip;
const viewport = { width: 640, height: 480 };
const paint = 'parent.postMessage({type:"narrafork:preview-painted"},"*")';
const html = (script: string) => `<h1>Sandbox capture</h1><script>${script}</script>`;
const capture = (source: string, signal = new AbortController().signal, tree?: UiNode[]) =>
	captureGenUiSnapshot({ html: source, viewport, signal, tree });

async function runtime() {
	const build = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("../../../frontend/plugin-runtime/vendor.ts", import.meta.url)),
		],
		target: "browser",
		format: "iife",
		minify: true,
	});
	if (!build.success) throw new AggregateError(build.logs, "Runtime build failed");
	const js = build.outputs.find((output) => output.path.endsWith(".js"));
	const css = build.outputs.find((output) => output.path.endsWith(".css"));
	if (!js || !css) throw new Error("Missing runtime JS or CSS output");
	return { runtimeJs: await js.text(), runtimeCss: await css.text() };
}

browserTests("GenUI real sandbox browser", () => {
	test("captures host PNG and never accepts frame-provided image payloads or actions", async () => {
		const result = await capture(
			html(
				`parent.postMessage({type:"narrafork:ui-action",action:"sendPrompt",value:"must not execute"},"*");parent.postMessage({type:"screenshot",base64:"fake"},"*");${paint}`,
			),
		);
		expect(result.diagnostics).toEqual([]);
		expect(result.failed).toBe(false);
		expect(result.images).toHaveLength(1);
		const png = Buffer.from(result.images[0]?.base64 ?? "", "base64");
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(png.readUInt32BE(16)).toBe(viewport.width);
		expect(png.readUInt32BE(20)).toBe(viewport.height);
		expect(png.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
	}, 15_000);

	test("delivers markup nodes only after ui-ready", async () => {
		const result = await capture(
			html(
				`addEventListener("message",event=>{if(event.source===parent&&event.data.type==="narrafork:ui-tree"&&event.data.nodes[0].text==="expected"){document.querySelector("h1").textContent=event.data.nodes[0].text;${paint};}});parent.postMessage({type:"narrafork:ui-ready"},"*");`,
			),
			undefined,
			parseUiMarkup("expected").nodes,
		);
		expect(result.failed).toBe(false);
		expect(result.diagnostics).toEqual([]);
	}, 15_000);

	test("offline image and font warnings retain a successful React screenshot; crashes still fail", async () => {
		const built = await runtime();
		for (const crash of [false, true]) {
			const result = await capture(
				createPreviewShell(
					{
						...built,
						css: "@font-face{font-family:OfflineFont;src:url(https://example.com/font.woff2)}body{font-family:OfflineFont}",
						js: `const React=globalThis.__nfPluginRuntime.React;globalThis.__nfGenUiApp=()=>{${crash ? 'throw new Error("React capture exploded")' : 'return React.createElement("div",{style:{fontFamily:"OfflineFont"}},"Offline preview",React.createElement("img",{src:"https://example.com/image.png"}))'}};`,
					},
					{ colorScheme: "light", tokenCss: "" },
					"Render failed",
					{ inspection: true },
				),
			);
			expect(result.images).toHaveLength(1);
			expect(result.failed).toBe(crash);
			if (crash) expect(result.diagnostics.join(" ")).toContain("React capture exploded");
			else {
				expect(result.limited).toBe(true);
				expect(result.diagnostics.join(" ")).toContain("img-src");
				expect(result.diagnostics.join(" ")).toContain("font-src");
				expect(result.diagnostics.join(" ")).not.toContain("paint");
			}
		}
	}, 30_000);

	test("warning floods cannot hide a later runtime failure", async () => {
		const result = await capture(
			html(
				`for(let i=0;i<100;i++)parent.postMessage({type:"narrafork:preview-diagnostic",severity:"warning",message:"Blocked "+"错误😀".repeat(3000)},"*");parent.postMessage({type:"narrafork:preview-diagnostic",severity:"error",message:"actual error"},"*");${paint};`,
			),
		);
		expect(result.failed).toBe(true);
		expect(result.limited).toBe(true);
		expect(result.images).toHaveLength(1);
		expect(result.diagnostics.length).toBeLessThanOrEqual(20);
		expect(
			result.diagnostics.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0),
		).toBeLessThanOrEqual(16384);
	}, 15_000);

	test("blocks loopback, workers, popups and data navigations", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("forbidden");
			},
		});
		try {
			const result = await capture(
				html(
					`addEventListener("securitypolicyviolation",event=>parent.postMessage({type:"narrafork:preview-diagnostic",message:"Blocked CSP "+event.violatedDirective},"*"));fetch("http://127.0.0.1:${server.port}/probe").catch(()=>{});try{new Worker(URL.createObjectURL(new Blob(["while(true){}"],{type:"text/javascript"})));}catch{};if(window.open("https://example.com"))throw Error("popup unexpectedly opened");location.href="data:text/html,navigation";setTimeout(()=>{${paint}},100);`,
				),
			);
			expect(requests).toBe(0);
			expect(result.failed).toBe(true);
			expect(result.diagnostics.some((entry) => entry.includes("Blocked"))).toBe(true);
		} finally {
			await server.stop(true);
		}
	}, 15_000);

	test("bounds diagnostics received from hostile frame messages", async () => {
		const result = await capture(
			html(
				`for(let i=0;i<100;i++)parent.postMessage({type:"narrafork:preview-diagnostic",message:i+"错误😀".repeat(3000)},"*");${paint};`,
			),
		);
		expect(result.failed).toBe(true);
		expect(result.diagnostics.length).toBeLessThanOrEqual(20);
		expect(result.diagnostics.every((entry) => Buffer.byteLength(entry) <= 2048)).toBe(true);
		expect(
			result.diagnostics.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0),
		).toBeLessThanOrEqual(16384);
	}, 15_000);

	test("kills long-fragment CDP flooding before an oversized event reaches JSON.parse", async () => {
		const start = performance.now();
		const result = await capture(html(`location.hash="x".repeat(6*1024*1024);${paint};`));
		expect(result.failed).toBe(true);
		expect(result.diagnostics.join(" ")).toContain("CDP transport");
		expect(result.diagnostics.join(" ")).toContain("4MiB");
		expect(performance.now() - start).toBeLessThan(10_000);
		expect(result.images).toEqual([]);
		// The owned process has been torn down and the next isolated capture still works.
		expect((await capture(html(paint))).failed).toBe(false);
	}, 15_000);

	test("rejects a third concurrent job and aborts only its isolated browsers", async () => {
		const controller = new AbortController();
		const start = performance.now();
		const first = capture(html("while(true){}"), controller.signal);
		const second = capture(html("while(true){}"), controller.signal);
		const busy = await capture(html(paint));
		expect(busy.failed).toBe(true);
		expect(busy.diagnostics.join(" ")).toContain("maximum two");
		setTimeout(() => controller.abort(new Error("cancel hostile frames")), 2500);
		const results = await Promise.all([first, second]);
		expect(results.every((result) => result.failed)).toBe(true);
		expect(performance.now() - start).toBeLessThan(5000);
		// Capacity is released, and cleanup did not touch subsequent browsers.
		expect((await capture(html(paint))).failed).toBe(false);
	}, 15_000);
});
