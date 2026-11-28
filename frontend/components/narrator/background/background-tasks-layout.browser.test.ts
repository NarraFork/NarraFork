import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
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
	usePlatform: `export const useNarratorSubagentsCapability=()=>({supported:true,background:true,detachAttach:true,reattachBlocksParent:true}); export const useNarratorBrowserSessionsCapability=()=>({supported:true});`,
	useTerminals: `export const useCanOpenTerminals=id=>id && window.backgroundTaskFixture.canCreate;`,
	useMobileDrawerHistory: `export const useMobileDrawerHistory=()=>{};`,
	useNarratorActivity: `export const useNarratorActivity=ids=>new Map(ids.map(id=>[id,{tools:window.backgroundTaskFixture.activity[id]??[]}]));`,
	NarratorDockContext: `export const useNarratorDockContext=()=>({openSubagentPanel:id=>window.backgroundTaskFixture.opened.push(id)});`,
	"react-router": `export const useNavigate=()=>()=>{throw new Error('Unexpected routing outside dock')};`,
	api: `
		const create = (type, narratorId, data) => new Promise((resolve, reject) => {
			const fixture = window.backgroundTaskFixture;
			fixture.creates.push({type, narratorId, data});
			fixture.pendingCreate = (failure) => {
				fixture.pendingCreate = null;
				if (failure) reject(new Error(failure));
				else resolve({id:'created', alias:'created'});
			};
		});
		export const ApiError = Error;
		export const authorizedFetch = fetch;
		export const getToken = () => null;
		export const readFetchError = () => { throw new Error('Unexpected fetch'); };
		export const api = {
			cancelBackgroundTask: async (_parent, id) => window.backgroundTaskFixture.cancelled.push(id),
			getBackgroundTaskOutputTail: async (_narratorId, taskId) => ({tail:(window.backgroundTaskFixture.tasks.find((task)=>task.id===taskId) ?? window.backgroundTaskFixture.tasks[0]).output,live:true,truncated:false}),
			createBackgroundTask: (id, data) => create('task', id, data),
			createBrowserSession: (id, data) => create('browser', id, data),
			listBrowserSessions: async () => { window.backgroundTaskFixture.browserReads++; return []; },
			getOptionalToolState: async () => ({loaded:true}),
		};`,
	ContentViewer: `export const ContentViewer=({content,bodyId})=><div style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap'}}><pre data-output={bodyId} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{content}</pre><button data-copy={bodyId} onClick={()=>window.backgroundTaskFixture.copied.push(content)}>Copy</button></div>;`,
	ToolCallInspector: `export const ToolCallInspector=({toolUseId,opened,onClose})=>opened?<div data-inspector={toolUseId}><button onClick={onClose}>Close inspector</button></div>:null;`,
};

beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./background-tasks-layout.browser-fixture.tsx", import.meta.url)),
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
								/(?:useBackgroundTaskList|useNarratorActivity|usePlatform|useTerminals|useMobileDrawerHistory|NarratorDockContext|ToolCallInspector|ContentViewer|lib\/api|@tanstack\/react-router)$/,
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
		// Puppeteer assigns a separate profile. Windows Chrome needs the real OS
		// profile path for startup, not the temporary HOME from the Bun preload.
		env:
			process.platform === "win32" && process.env.NARRAFORK_ORIGINAL_HOME
				? { ...process.env, USERPROFILE: process.env.NARRAFORK_ORIGINAL_HOME }
				: process.env,
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
		await page.$eval('[data-copy*="output.main"]', (button) =>
			(button as HTMLButtonElement).click(),
		);
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

test("running and finished sections, icon kind filters, search, remembered collapse, and watches", async () => {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	try {
		await page.setViewport({ width: 420, height: 844 });
		await page.goto(server.url.origin, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
		await page.evaluate(() => localStorage.clear());
		const open = async () => {
			await page.evaluate(() =>
				(window as unknown as FixtureWindow).fixture.start(
					"en",
					420,
					true,
					false,
					"tasks",
					"watch",
				),
			);
			await settle(page);
		};
		await open();
		// Rows in DOM order, each tagged with the section it sits under.
		const rows = () =>
			page.$$eval(
				"#surface [data-background-task], #surface [data-watch-task], #surface [data-task-section]",
				(nodes) => {
					let section = "";
					const out: string[] = [];
					for (const node of nodes) {
						const name = node.getAttribute("data-task-section");
						if (name) section = name;
						else
							out.push(
								`${section}:${node.getAttribute("data-background-task") ?? node.getAttribute("data-watch-task")}`,
							);
					}
					return out;
				},
			);
		// Default: running agent/service on top, the finished build below the divider, no watches.
		expect(await rows()).toEqual(["running:agent", "running:server", "finished:old-build"]);
		const sectionText = () =>
			page.$$eval("[data-task-section]", (nodes) => nodes.map((node) => node.textContent));
		expect(await sectionText()).toEqual(["Running · 2", "Finished · 1"]);
		// The agent row carries its recent tool calls and the watch observing it.
		expect(await page.$$eval("[data-agent-recent-tools] > *", (n) => n.length)).toBe(3);
		const attachments = await page.$$eval("[data-watch-attachment]", (nodes) =>
			nodes.map((node) => node.textContent),
		);
		expect(attachments).toHaveLength(2);
		expect(attachments[0]).toMatch(/Watched.*Deadline 10m · 7m(30|29)s left/);
		expect(attachments[1]).toMatch(/Watched.*ready on.*Deadline 5m/);

		const toggleKind = async (kind: string) => {
			await page.click(`[data-kind-filter="${kind}"]`);
			await settle(page);
		};
		const pressed = () =>
			page.$$eval("[data-kind-filter]", (nodes) =>
				nodes.map(
					(node) => `${node.getAttribute("data-kind-filter")}=${node.getAttribute("aria-pressed")}`,
				),
			);
		expect(await pressed()).toEqual(["agent=true", "bash=true", "watch=false"]);
		await toggleKind("watch");
		expect(await rows()).toEqual([
			"running:agent",
			"running:server",
			"running:watch-agent",
			"running:watch-bash",
			"finished:watch-terminal",
			"finished:old-build",
		]);
		const watchRows = await page.$$eval("[data-watch-task]", (nodes) =>
			nodes.map((node) => ({
				id: node.getAttribute("data-watch-task"),
				text: node.textContent,
				bashStyled: !!node.querySelector(".tabler-icon-terminal-2, code[class*=summary]"),
			})),
		);
		for (const row of watchRows) expect(row.bashStyled).toBe(false);
		expect(watchRows[0].text).toMatch(/Agent.*Fix the login token refresh.*watching.*Deadline 10m/);
		expect(watchRows[1].text).toMatch(/Bash.*server.*for ready on.*watching.*Deadline 5m/);
		expect(watchRows[2].text).toMatch(/Terminal.*tests.*for PASS.*deadline reached.*Deadline 30m/);
		expect(watchRows[2].text).not.toContain("left");
		expect(await page.$("[data-watch-output]")).toBeNull();
		await page.click('[data-watch-task="watch-terminal"] [data-watch-toggle]');
		expect(
			await page.$eval(
				'[data-watch-task="watch-terminal"] [data-watch-output]',
				(n) => n.textContent,
			),
		).toContain('Terminal watch timed out: "PASS" did not appear');
		expect(await page.$('[data-watch-task="watch-agent"] [data-watch-toggle]')).toBeNull();

		await toggleKind("bash");
		expect(await rows()).toEqual([
			"running:agent",
			"running:watch-agent",
			"running:watch-bash",
			"finished:watch-terminal",
		]);
		await page.type("[data-background-task-search]", "login");
		await settle(page);
		expect(await rows()).toEqual(["running:agent", "running:watch-agent"]);
		expect(await sectionText()).toEqual(["Running · 2", "Finished · 0"]);
		await page.type("[data-background-task-search]", " nomatch");
		await settle(page);
		expect(await rows()).toEqual([]);
		expect(await surfaceTextOf(page)).toContain("Nothing running");

		// Kind toggles and the finished section's collapse survive reopening the panel.
		await open();
		expect(await pressed()).toEqual(["agent=true", "bash=false", "watch=true"]);
		await toggleKind("bash");
		await page.click("[data-finished-toggle]");
		await settle(page);
		expect(await rows()).toEqual([
			"running:agent",
			"running:server",
			"running:watch-agent",
			"running:watch-bash",
		]);
		await open();
		expect(await page.$eval("[data-finished-toggle]", (n) => n.getAttribute("aria-expanded"))).toBe(
			"false",
		);
		expect(await rows()).not.toContain("finished:old-build");
		await page.click("[data-finished-toggle]");
		await settle(page);
		expect(await rows()).toContain("finished:old-build");
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => localStorage.clear());
		await page.close();
	}
}, 20_000);

function surfaceTextOf(page: Page) {
	return page.$eval("#surface", (surface) => surface.textContent ?? "");
}

async function openCreationForm(page: Page) {
	await page.click("#surface button:has(.tabler-icon-plus)");
	await page.waitForSelector("#surface form");
}

async function submitCreationForm(page: Page, count = 1) {
	await page.$eval(
		"#surface form",
		(form, times) => {
			for (let i = 0; i < times; i++) (form as HTMLFormElement).requestSubmit();
		},
		count,
	);
	await settle(page);
}

test("manual task and service creation keeps a failed draft, prevents double POST, and refreshes", async () => {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 320, height: 844 });
		await page.goto(server.url.origin, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
		await start(page, "en", 320, false);
		expect(await page.$("#surface button:has(.tabler-icon-plus)")).toBeNull();
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.start("en", 320, false, true),
		);
		await page.waitForSelector("#surface button:has(.tabler-icon-plus)");
		await openCreationForm(page);
		await submitCreationForm(page);
		await page.waitForSelector("form textarea[aria-invalid=true]");
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([]);
		await page.select("form select", "service");
		await page.type("form textarea", "bun run dev");
		await page.type("form input:not([inputmode])", "Preview server");
		await submitCreationForm(page, 2);
		const create = {
			type: "task" as const,
			narratorId: "parent",
			data: { kind: "service", command: "bun run dev", title: "Preview server" },
		};
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([create]);
		await page.waitForSelector("form fieldset:disabled");
		await page.evaluate(() => window.backgroundTaskFixture.pendingCreate?.("Start refused"));
		await page.waitForFunction(() =>
			document.querySelector("form")?.textContent?.includes("Start refused"),
		);
		expect(await page.$eval("form textarea", (input) => input.value)).toBe("bun run dev");
		expect(await page.$eval("form input:not([inputmode])", (input) => input.value)).toBe(
			"Preview server",
		);
		expect(await page.evaluate(() => window.backgroundTaskFixture.refreshes)).toBe(0);
		await submitCreationForm(page);
		await page.evaluate(() => window.backgroundTaskFixture.pendingCreate?.());
		await page.waitForSelector("#surface form", { hidden: true });
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([
			create,
			create,
		]);
		expect(await page.evaluate(() => window.backgroundTaskFixture.refreshes)).toBe(1);
		await openCreationForm(page);
		expect(await page.$eval("form textarea", (input) => input.value)).toBe("");
		expect(await page.$eval("form select", (select) => select.value)).toBe("task");
		await page.type("form textarea", "bun run test");
		await page.type("form input[inputmode=numeric]", "120000");
		await submitCreationForm(page);
		await page.evaluate(() => window.backgroundTaskFixture.pendingCreate?.());
		await page.waitForSelector("#surface form", { hidden: true });
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates.at(-1))).toEqual({
			type: "task",
			narratorId: "parent",
			data: { kind: "task", command: "bun run test", timeoutMs: 120000 },
		});
	} finally {
		await page.close();
	}
}, 20_000);

test("manual browser creation is write-only, validates URL and TTL, and reloads the existing list", async () => {
	if (!browser || !server) throw new Error("Fixture unavailable");
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 320, height: 844 });
		await page.goto(server.url.origin, { waitUntil: "networkidle0" });
		await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.start("zh-CN", 320, true, false, "browser"),
		);
		await page.waitForFunction(() => window.backgroundTaskFixture.browserReads === 1);
		expect(await page.$("#surface button:has(.tabler-icon-plus)")).toBeNull();
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.start("zh-CN", 320, true, true, "browser"),
		);
		await page.waitForSelector("#surface button:has(.tabler-icon-plus)");
		await openCreationForm(page);
		await page.type("form input[type=url]", "file:///example.html");
		await page.type("form input[inputmode=numeric]", "999");
		await submitCreationForm(page);
		expect(await page.$$("form input[aria-invalid=true]")).toHaveLength(2);
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([]);
		await page.click("form input[type=url]", { clickCount: 3 });
		await page.type("form input[type=url]", "https://example.com/");
		await page.click("form input[inputmode=numeric]", { clickCount: 3 });
		await page.type("form input[inputmode=numeric]", "86400001");
		await submitCreationForm(page);
		expect(await page.$$("form input[aria-invalid=true]")).toHaveLength(1);
		await page.click("form input[inputmode=numeric]", { clickCount: 3 });
		await page.type("form input[inputmode=numeric]", "86400000");
		await submitCreationForm(page, 2);
		const create = {
			type: "browser" as const,
			narratorId: "parent",
			data: { url: "https://example.com/", ttlMs: 86400000 },
		};
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([create]);
		await page.evaluate(() => window.backgroundTaskFixture.pendingCreate?.("Browser unavailable"));
		await page.waitForFunction(() =>
			document.querySelector("form")?.textContent?.includes("Browser unavailable"),
		);
		expect(await page.$eval("form input[type=url]", (input) => input.value)).toBe(
			"https://example.com/",
		);
		expect(await page.$eval("form input[inputmode=numeric]", (input) => input.value)).toBe(
			"86400000",
		);
		const reads = await page.evaluate(() => window.backgroundTaskFixture.browserReads);
		await submitCreationForm(page);
		await page.evaluate(() => window.backgroundTaskFixture.pendingCreate?.());
		await page.waitForSelector("#surface form", { hidden: true });
		await page.waitForFunction(
			(before) => window.backgroundTaskFixture.browserReads > before,
			{},
			reads,
		);
		expect(await page.evaluate(() => window.backgroundTaskFixture.creates)).toEqual([
			create,
			create,
		]);
	} finally {
		await page.close();
	}
}, 20_000);
