import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./background-tasks-layout.browser-fixture";

// Real component, translations, Mantine CSS and Chromium layout. Only data,
// navigation and the unrelated detail viewers are stubbed. The viewer stub tests
// the header/detail event boundary, not ContentViewer's own rendering or clipboard.
// This suite owns an ephemeral static server, never a NarraFork server/database.
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
type FixtureWindow = Window & { fixture: typeof Fixture };
const stubs: Record<string, string> = {
	useBackgroundTaskList: `export const useBackgroundTaskList=()=>({tasks:window.backgroundTaskFixture.tasks,isLoading:false,hasNextPage:false,isFetchingNextPage:false,refresh:()=>window.backgroundTaskFixture.refreshes++});`,
	usePlatform: `export const useNarratorSubagentsCapability=()=>({supported:true,background:true,detachAttach:true,reattachBlocksParent:true});`,
	useMobileDrawerHistory: `export const useMobileDrawerHistory=()=>{};`,
	NarratorDockContext: `export const useNarratorDockContext=()=>({openSubagentPanel:id=>window.backgroundTaskFixture.opened.push(id)});`,
	"react-router": `export const useNavigate=()=>()=>{throw new Error('Unexpected routing outside dock')};`,
	api: `export const api={cancelBackgroundTask:async(_parent,id)=>window.backgroundTaskFixture.cancelled.push(id),getBackgroundTaskOutputTail:async()=>({tail:window.backgroundTaskFixture.tasks[0].output,live:true,truncated:false})};`,
	ContentViewer: `export const ContentViewer=({content,bodyId})=><div style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}><pre data-output={bodyId} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{content}</pre><button data-copy={bodyId} onClick={()=>window.backgroundTaskFixture.copied.push(content)}>Copy</button></div>;`,
	ToolCallInspector: `export const ToolCallInspector=({toolUseId,opened,onClose})=>opened?<div data-inspector={toolUseId}><button onClick={onClose}>Close inspector</button></div>:null;`,
};

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [
			new URL("./background-tasks-layout.browser-fixture.tsx", import.meta.url).pathname,
		],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "controlled-task-data-and-detail-viewers",
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/(?:useBackgroundTaskList|usePlatform|useMobileDrawerHistory|NarratorDockContext|ToolCallInspector|ContentViewer|lib\/api|@tanstack\/react-router)$/,
						},
						(args) => ({ path: args.path, namespace: "task-fixture" }),
					);
					builder.onLoad({ filter: /.*/, namespace: "task-fixture" }, (args) => {
						const name = args.path.split("/").pop() as string;
						if (!stubs[name]) throw new Error(`Missing fixture stub: ${args.path}`);
						return { contents: stubs[name], loader: "jsx" };
					});
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("Production component/CSS bundle missing");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/")
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox"],
		timeout: 15_000,
	});
}, 60_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
async function start(page: Page, language: string, panelWidth: number, chromeless: boolean) {
	await page.evaluate(
		({ language, panelWidth, chromeless }) =>
			(window as unknown as FixtureWindow).fixture.start(language, panelWidth, chromeless),
		{ language, panelWidth, chromeless },
	);
	await settle(page);
}

for (const language of ["en", "zh-CN"]) {
	test(`${language}: narrow mobile and desktop dock keep icons/actions sized and text readable`, async () => {
		if (!browser || !server) throw new Error("Fixture unavailable");
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		try {
			await page.setViewport({ width: 1200, height: 844 });
			await page.goto(server.url.origin, { waitUntil: "networkidle0" });
			await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
			await start(page, language, 900, true);
			const baseline = await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.snapshot(),
			);
			expect(baseline.rows).toHaveLength(5);
			expect(baseline.rows[0].icons.map((icon) => icon.width)).toEqual([12, 14]);
			for (const row of baseline.rows) {
				expect(row.summaryTop).toBe(row.identityTop);
				for (const width of row.buttons) expect(width).toBeGreaterThanOrEqual(18);
			}
			for (const [viewport, panelWidth, chromeless] of [
				[390, 390, false],
				[320, 320, false],
				[240, 240, false],
				[1200, 260, true],
			] as const) {
				await page.setViewport({ width: viewport, height: 844 });
				await start(page, language, panelWidth, chromeless);
				const narrow = await page.evaluate(() =>
					(window as unknown as FixtureWindow).fixture.snapshot(),
				);
				expect(narrow.surfaceScrollWidth).toBeLessThanOrEqual(narrow.surfaceWidth);
				expect(narrow.documentScrollWidth).toBeLessThanOrEqual(narrow.documentWidth);
				for (const [index, row] of narrow.rows.entries()) {
					expect(row.text).toBe(baseline.rows[index].text);
					expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
					expect(row.summaryTop).toBeGreaterThanOrEqual(row.identityBottom);
					expect(row.summaryTop).toBeGreaterThanOrEqual(row.actionsBottom);
					expect(row.buttons).toEqual(baseline.rows[index].buttons);
					for (const icon of row.icons) expect(icon.width).toBe(icon.expected);
					if (index < 4) expect(row.height).toBeGreaterThan(row.lineHeight * 2);
				}
			}
			expect(errors).toEqual([]);
		} finally {
			await page.close();
		}
	}, 30_000);
}

test("narrow headers retain expand, inspect, cancel, output interaction and subagent opening", async () => {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 320, height: 844 });
		await page.goto(server.url.origin, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
		await start(page, "en", 320, false);
		const selectors = await page.evaluate(
			() => (window as unknown as FixtureWindow).fixture.selectors,
		);
		const headers = await page.$$(selectors.header);
		await headers[0].click();
		await page.waitForSelector('[data-output*="output.main"]');
		await headers[0].$eval("button:has(.tabler-icon-info-circle)", (button) =>
			(button as HTMLButtonElement).click(),
		);
		await page.waitForSelector('[data-inspector="tool-command"]');
		expect(await page.$('[data-output*="output.main"]')).not.toBeNull();
		await page.click("[data-inspector] button");
		await headers[0].$eval("button:has(.tabler-icon-x)", (button) =>
			(button as HTMLButtonElement).click(),
		);
		await settle(page);
		expect(await page.evaluate(() => window.backgroundTaskFixture.cancelled)).toEqual(["command"]);
		expect(await page.evaluate(() => window.backgroundTaskFixture.refreshes)).toBe(1);
		expect(await page.$('[data-output*="output.main"]')).not.toBeNull();
		const selected = await page.$eval('[data-output*="output.main"]', (output) => {
			const range = document.createRange();
			range.selectNodeContents(output);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			output.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			return window.getSelection()?.toString() ?? "";
		});
		expect(selected).toBe(
			await page.evaluate(() => (window as unknown as FixtureWindow).fixture.output),
		);
		await page.click('[data-copy*="output.main"]');
		expect(await page.evaluate(() => window.backgroundTaskFixture.copied)).toEqual([selected]);
		expect(await page.$('[data-output*="output.main"]')).not.toBeNull();
		await headers[0].click();
		await page.waitForSelector('[data-output*="output.main"]', { hidden: true });
		await headers[2].click();
		await headers[2].$eval("button:has(.tabler-icon-external-link)", (button) =>
			(button as HTMLButtonElement).click(),
		);
		expect(await page.evaluate(() => window.backgroundTaskFixture.opened)).toEqual([
			"child",
			"child",
		]);
		expect(await page.evaluate(() => window.backgroundTaskFixture.beforeOpen)).toBe(2);
	} finally {
		await page.close();
	}
}, 15_000);
