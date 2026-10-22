import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type * as Fixture from "./git-slot.browser-fixture";

// Real Chromium, production Mantine CSS and the actual Git bar components.
// Discovery/authorization hooks are fixture-controlled; no application server,
// production database or existing NarraFork process is touched.
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
type FixtureWindow = Window & { fixture: typeof Fixture };
const hookStubs: Record<string, string> = {
	useGit: `export const useGitWorkspace=()=>window.gitFixtureWorkspace; export const useGitStatus=()=>({data:undefined}); export const useGitLineStats=()=>({data:undefined,isFetching:false,error:null}); export const gitWorkspaceTarget=(_id,workspace)=>workspace?.state==='ready'&&workspace.capabilities.read?{narratorId:'n'}:null;`,
	useWorkspaceContext: `export const useWorkspaceContext=()=>({data:window.gitFixtureContext});`,
	"react-i18next": `export const useTranslation=()=>({t:key=>key});`,
	NarratorDockContext: `export const useNarratorDockContext=()=>null;`,
	NarratorWorktreeControls: `export const NarratorWorktreeControls=()=>null;`,
};
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [new URL("./git-slot.browser-fixture.tsx", import.meta.url).pathname],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			{
				name: "controlled-discovery-only",
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/(?:useGit|useWorkspaceContext|react-i18next|NarratorDockContext|NarratorWorktreeControls|lib\/api)$/,
						},
						(args) => ({ path: args.path, namespace: "git-fixture" }),
					);
					builder.onLoad({ filter: /.*/, namespace: "git-fixture" }, (args) => {
						const name = args.path.split("/").pop() as string;
						return { contents: hookStubs[name] ?? `export const ${name}=()=>null;`, loader: "js" };
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
					`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}<style>html,body{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(script)});</script></body></html>`,
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
for (const width of [1200, 390]) {
	for (const scenario of ["git", "notgit", "cached-notgit"]) {
		test(`${width}px ${scenario}: 2s discovery never shifts message viewport/slot`, async () => {
			if (!browser || !server) throw new Error("Fixture not initialized");
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			try {
				await page.setViewport({ width, height: 844 });
				await page.goto(server.url.origin, { waitUntil: "networkidle0" });
				await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
				await page.evaluate(
					(mode) => (window as unknown as FixtureWindow).fixture.start(mode),
					scenario,
				);
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
						),
				);
				const before = await page.evaluate(() =>
					(window as unknown as FixtureWindow).fixture.snapshot(),
				);
				expect(before.ready).toBe(true);
				expect(before.completed).toBe(false);
				expect(before.slotHeight).toBe(30);
				if (scenario.includes("notgit")) expect(before.canOpen).toBe(false);
				await page.waitForFunction(
					() => (window as unknown as FixtureWindow).fixture.snapshot().completed,
					{ timeout: 5000 },
				);
				const after = await page.evaluate(() =>
					(window as unknown as FixtureWindow).fixture.snapshot(),
				);
				expect(after.top).toBe(before.top);
				expect(after.height).toBe(before.height);
				expect(after.slotHeight).toBe(before.slotHeight);
				if (scenario.includes("notgit")) {
					expect(after.text).toContain("/repo");
					expect(after.canOpen).toBe(false);
					await page.click("[data-git-slot]");
					expect(
						await page.evaluate(
							() => (window as unknown as FixtureWindow).fixture.snapshot().gitOpenCount,
						),
					).toBe(0);
				}
				if (scenario.includes("cached-notgit")) {
					await page.evaluate(() => (window as unknown as FixtureWindow).fixture.initializeGit());
					await page.waitForFunction(
						() => (window as unknown as FixtureWindow).fixture.snapshot().completed,
						{ timeout: 5000 },
					);
					const initialized = await page.evaluate(() =>
						(window as unknown as FixtureWindow).fixture.snapshot(),
					);
					expect(initialized.text).toContain("initialized-branch");
					expect(initialized.text).toContain("workspace.readOnly");
					expect(initialized.canOpen).toBe(true);
					expect(initialized.height).toBe(before.height);
					expect(initialized.top).toBe(before.top);
					expect(initialized.slotHeight).toBe(30);
					await page.click('[data-git-slot][role="button"], [data-git-slot] [role="button"]');
					expect(
						await page.evaluate(
							() => (window as unknown as FixtureWindow).fixture.snapshot().gitOpenCount,
						),
					).toBe(1);
				}
				if (scenario === "git" || scenario.includes("cached-notgit")) {
					await page.evaluate(() => (window as unknown as FixtureWindow).fixture.revise());
					await page.evaluate(
						() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
					);
					const waiting = await page.evaluate(() =>
						(window as unknown as FixtureWindow).fixture.snapshot(),
					);
					expect(waiting.text).not.toContain("branch-ready");
					expect(waiting.text).not.toContain("initialized-branch");
					expect(waiting.canOpen).toBe(false);
					expect(waiting.height).toBe(before.height);
					expect(waiting.top).toBe(before.top);
					expect(waiting.slotHeight).toBe(30);
					await page.waitForFunction(
						() => (window as unknown as FixtureWindow).fixture.snapshot().completed,
						{ timeout: 5000 },
					);
					const revised = await page.evaluate(() =>
						(window as unknown as FixtureWindow).fixture.snapshot(),
					);
					expect(revised.text).toContain("new-revision-branch");
					expect(revised.height).toBe(before.height);
					expect(revised.top).toBe(before.top);
					expect(revised.slotHeight).toBe(30);
					expect(revised.cwdTitle).toBe("remote: /new-repo");
					expect(revised.canOpen).toBe(true);
				}
				expect(errors).toEqual([]);
			} finally {
				await page.close();
			}
		}, 15_000);
	}
}
