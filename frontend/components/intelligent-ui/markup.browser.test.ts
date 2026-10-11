import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import { buildKit, readKitBundle } from "@server/services/intelligent-ui/kit";
import { parseUiMarkup } from "@shared/intelligent-ui-markup";
import type { WorkspaceContext } from "@shared/workspace-context";
import puppeteer, { type Frame, type Page } from "puppeteer-core";
import { createPreviewShell, type PreviewShellSource } from "./preview-shell";
import { browserLaunchEnvironment } from "./test-fixtures";

/**
 * The streaming contract, in a real browser: markup arrives a few characters at a time,
 * the frame draws what has completed so far, and what the reader already touched stays
 * put while the rest arrives.
 */
const browserTest = process.env.BROWSER_EXECUTABLE ? test : test.skip;
const THEME = { colorScheme: "light" as const, tokenCss: "" };
const HOST = `<!doctype html><html><body style="margin:0">
<iframe id="ui" sandbox="allow-scripts" style="width:900px;height:640px;border:0"></iframe>
<script>
	window.actions = [];
	window.ready = false;
	addEventListener("message", (event) => {
		if (event.data?.type === "narrafork:ui-ready") window.ready = true;
		if (event.data?.type === "narrafork:ui-action") window.actions.push([event.data.action, event.data.value]);
	});
</script></body></html>`;

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const roots: string[] = [];
beforeAll(async () => {
	if (!process.env.BROWSER_EXECUTABLE) return;
	browser = await puppeteer.launch({
		executablePath: process.env.BROWSER_EXECUTABLE,
		headless: true,
		args: ["--no-sandbox", "--no-first-run", "--disable-features=msEdgeStartupBoost"],
		env: browserLaunchEnvironment(),
		timeout: 40000,
	});
}, 60_000);
afterAll(async () => {
	const child = browser?.process();
	const exited =
		child && child.exitCode === null
			? new Promise<void>((done) => {
					child.once("exit", () => done());
				})
			: Promise.resolve();
	await browser?.close();
	// The next test file may launch its own browser; let this one be fully gone first.
	await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

async function builtinRuntime(): Promise<PreviewShellSource> {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "../../plugin-runtime/vendor.ts")],
		target: "browser",
		format: "iife",
		minify: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!build.success) throw new AggregateError(build.logs, "Runtime build failed");
	const text = (extension: string) =>
		build.outputs.find((file) => file.path.endsWith(extension))?.text() ?? "";
	return { runtimeJs: await text(".js"), runtimeCss: await text(".css") };
}

/** A project kit produced the way the product produces it: the project's own Vite. */
async function projectKit(): Promise<PreviewShellSource | null> {
	const modules = resolve(import.meta.dir, "../../../node_modules");
	if (!existsSync(join(modules, "vite"))) return null;
	const root = await mkdtemp(join(tmpdir(), "nf-ui-kit-browser-"));
	roots.push(root);
	const kit = ".narrafork/intelligent_ui/kit";
	const files: Record<string, string> = {
		"package.json": '{ "name": "kit-browser", "private": true, "type": "module" }',
		"bun.lock": "",
		"vite.config.ts": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react()] });
`,
		"src/app.css":
			":root { --brand: rgb(232, 89, 12); }\n.acme-btn { border: 3px solid var(--brand); }",
		"src/Button.tsx": `import type { ReactNode } from "react";
export function Button({ children, onClick }: { children?: ReactNode; onClick?: () => void }) {
	return <button type="button" className="acme-btn" onClick={onClick}>{children}</button>;
}
`,
		"src/Counter.tsx": `import { useState } from "react";
export function Counter({ label }: { label: string }) {
	const [count, setCount] = useState(0);
	return <button type="button" className="acme-counter" onClick={() => setCount(count + 1)}>{label}: {count}</button>;
}
`,
		[`${kit}/setup.tsx`]: `import type { ReactNode } from "react";
export default function Setup({ children }: { children?: ReactNode }) {
	return <div data-kit-setup="acme">{children}</div>;
}
`,
		[`${kit}/kit.json`]: JSON.stringify({
			version: 1,
			setup: "./setup.tsx",
			styles: ["../../../src/app.css"],
			components: [
				{ name: "Button", from: "../../../src/Button" },
				{ name: "Counter", from: "../../../src/Counter" },
			],
		}),
	};
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	try {
		await symlink(
			modules,
			join(root, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch {
		return null;
	}
	const backend = new LocalBackend();
	const workspace: WorkspaceContext = {
		revision: 1,
		deviceId: "local",
		cwd: root,
		pathFlavor: backend.pathFlavor === "windows" ? "windows" : "posix",
		contextKey: "workspace",
		capabilities: { switchDirectory: true },
	};
	const options = {
		authorize: async (path: string) => path,
		authorizeWrite: async () => {},
		signal: new AbortController().signal,
	};
	const built = await buildKit(backend, workspace, options);
	if (!built.ok) throw new Error(`kit build failed:\n${built.log}`);
	const bundle = await readKitBundle(backend, workspace, options.authorize, options.signal);
	return { runtimeJs: bundle.js, runtimeCss: bundle.css };
}

async function open(
	source: PreviewShellSource,
	kit: boolean,
): Promise<{ page: Page; frame: Frame }> {
	if (!browser) throw new Error("browser not started");
	const page = await browser.newPage();
	page.setDefaultTimeout(8000);
	await page.setContent(HOST);
	const srcdoc = createPreviewShell(source, THEME, "Render failed", { mode: "markup", kit });
	await page.evaluate((html) => {
		(document.getElementById("ui") as HTMLIFrameElement).srcdoc = html;
	}, srcdoc);
	await page.waitForFunction(() => (window as unknown as { ready: boolean }).ready === true);
	const frame = await (await page.$("#ui"))?.contentFrame();
	if (!frame) throw new Error("missing frame");
	return { page, frame };
}

/** What the chat does on every streamed chunk: parse what has arrived, post the tree. */
async function post(page: Page, source: string, complete: boolean) {
	const { nodes } = parseUiMarkup(source, { complete });
	await page.evaluate(
		(tree) => {
			(document.getElementById("ui") as HTMLIFrameElement).contentWindow?.postMessage(
				{ type: "narrafork:ui-tree", nodes: tree },
				"*",
			);
		},
		nodes as unknown as never,
	);
}
const actions = (page: Page) =>
	page.evaluate(() => (window as unknown as { actions: [string, string][] }).actions);

browserTest(
	"built-in kit: UI appears while it streams, typed state survives, actions reach the host",
	async () => {
		const { page, frame } = await open(await builtinRuntime(), false);
		const markup = `<Stack gap="sm">
	<Title order={4} id="title">Plans</Title>
	<TextInput id="name" label="Name" />
	<Group>
		<Badge id="badge">Active</Badge>
		<Button id="go" onClick={() => sendPrompt("Compare the plans")}>Compare</Button>
	</Group>
	<Nope />
	<a id="link" href="https://example.com/docs">Docs</a>
	<Text id="tail">done</Text>
</Stack>`;
		const afterInput = markup.indexOf("<Group>");
		// Nothing of the later widgets exists while only the first ones have arrived.
		for (let length = 5; length < afterInput; length += 7)
			await post(page, markup.slice(0, length), false);
		await post(page, markup.slice(0, afterInput), false);
		await frame.waitForSelector("#name");
		expect(await frame.$eval("#title", (node) => node.textContent)).toBe("Plans");
		expect(await frame.$("#go")).toBeNull();
		expect(await frame.$("#tail")).toBeNull();
		// The reader starts using the UI before it has finished arriving.
		await frame.type("#name", "kept");
		for (let length = afterInput; length < markup.length; length += 7)
			await post(page, markup.slice(0, length), false);
		await post(page, markup, true);
		await frame.waitForSelector("#tail");
		expect(await frame.$eval("#tail", (node) => node.textContent)).toBe("done");
		// The input was reconciled in place, not rebuilt: its value is still there.
		expect(await frame.$eval("#name", (node) => (node as HTMLInputElement).value)).toBe("kept");
		// A tag the kit does not provide is shown as such instead of breaking the rest.
		expect(await frame.$eval("#root", (node) => node.textContent)).toContain("<Nope>");
		expect(await frame.$eval("#failure", (node) => (node as HTMLElement).hidden)).toBe(true);
		await frame.click("#go");
		await frame.click("#link");
		await page.waitForFunction(
			() => (window as unknown as { actions: unknown[] }).actions.length >= 2,
		);
		expect(await actions(page)).toEqual([
			["sendPrompt", "Compare the plans"],
			["openLink", "https://example.com/docs"],
		]);
		// The link was handed to the host; the frame itself went nowhere.
		expect(await frame.$("#tail")).not.toBeNull();
		await page.close();
	},
	90_000,
);

browserTest(
	"markup cannot introduce script: disallowed tags and props never reach the document",
	async () => {
		const { page, frame } = await open(await builtinRuntime(), false);
		await post(
			page,
			`<Stack><script>window.pwned = 1</script><iframe src="https://example.com" /><div id="safe" onClick="window.pwned = 2" dangerouslySetInnerHTML={{ __html: "<img src=x onerror='window.pwned = 3'>" }}>text</div></Stack>`,
			true,
		);
		await frame.waitForSelector("#safe");
		await frame.click("#safe");
		expect(await frame.$("#root script, #root iframe, #root img")).toBeNull();
		expect(
			await frame.evaluate(() => (window as unknown as { pwned?: number }).pwned),
		).toBeUndefined();
		expect(await frame.$eval("#safe", (node) => node.textContent)).toBe("text");
		await page.close();
	},
	60_000,
);

browserTest(
	"markup is data: literals cannot pose as elements, and nothing fires without the reader's click",
	async () => {
		const { page, frame } = await open(await builtinRuntime(), false);
		const settle = () => new Promise((done) => setTimeout(done, 400));
		const pwn = `parent.postMessage({type:'narrafork:ui-action',action:'sendPrompt',value:'pwned'},'*')`;

		// An object literal shaped like an element is still a literal. As a child and as
		// an attribute value it must not become markup, least of all raw HTML.
		const forged = `{kind:"el", $node:"el", name:"div", props:{id:"forged", dangerouslySetInnerHTML:{__html:"<img src=x onerror=\\"${pwn}\\">"}}, children:[]}`;
		await post(
			page,
			`<Stack><Text id="ok">ok</Text>{${forged}}<Box id="slot" data-x={${forged}} title={[${forged}]} /></Stack>`,
			true,
		);
		await frame.waitForSelector("#ok");
		await settle();
		expect(await frame.$("#forged, #root img")).toBeNull();

		// Handlers that run without a gesture never carry a host action, whatever the
		// markup names them; neither does an action smuggled in as a literal.
		await post(
			page,
			`<Stack><Text id="ok2">ok</Text><img id="pic" src="data:,broken" onError={sendPrompt("auto-error")} onLoad={sendPrompt("auto-load")} /><Box id="b" onAnimationStart={sendPrompt("auto-anim")} renderRoot={sendPrompt("auto-root")} ref={sendPrompt("auto-ref")} onClick={{$action:"sendPrompt", value:"literal"}}>x</Box></Stack>`,
			true,
		);
		await frame.waitForSelector("#ok2");
		await settle();
		expect(await actions(page)).toEqual([]);
		// A real click on a real handler still works.
		await post(page, `<Button id="real" onClick={sendPrompt("clicked")}>Go</Button>`, true);
		await frame.waitForSelector("#real");
		await frame.click("#real");
		await page.waitForFunction(
			() => (window as unknown as { actions: unknown[] }).actions.length >= 1,
		);
		expect(await actions(page)).toEqual([["sendPrompt", "clicked"]]);

		// A polymorphic prop must not turn a layout component into a tag markup may not use.
		await post(
			page,
			`<Stack><Box id="poly" component="meta" httpEquiv="refresh" content="0;url=https://example.invalid/leak" /><Box id="poly2" component="section">fine</Box></Stack>`,
			true,
		);
		await frame.waitForSelector("#poly2");
		await settle();
		expect(await frame.$("#root meta")).toBeNull();
		expect(await frame.$eval("#poly2", (node) => node.tagName)).toBe("SECTION");
		// Still the same document: nothing navigated the frame away.
		expect(await frame.evaluate(() => location.href)).toBe("about:srcdoc");
		await page.close();
	},
	90_000,
);

browserTest(
	"a tree the frame cannot render costs that tree, not the card",
	async () => {
		const { page, frame } = await open(await builtinRuntime(), false);
		const send = (nodes: unknown) =>
			page.evaluate((tree) => {
				(document.getElementById("ui") as HTMLIFrameElement).contentWindow?.postMessage(
					{ type: "narrafork:ui-tree", nodes: tree },
					"*",
				);
			}, nodes as never);
		// Not something the parser emits, but the frame must not depend on that.
		for (const broken of [
			[{ kind: "el", $node: "el", name: 5, props: {}, children: [] }],
			[{ kind: "el", $node: "el", name: "Stack", props: null, children: "nope" }],
			[null, 7, "text", { $node: "el" }],
		]) {
			await send(broken);
			await new Promise((done) => setTimeout(done, 150));
		}
		await post(page, `<Text id="after">recovered</Text>`, true);
		await frame.waitForSelector("#after");
		expect(await frame.$eval("#after", (node) => node.textContent)).toBe("recovered");
		expect(await frame.$eval("#failure", (node) => (node as HTMLElement).hidden)).toBe(true);
		await page.close();
	},
	60_000,
);

browserTest(
	"project kit: the project's own components, wrapper and styles render, and keep their state",
	async () => {
		const kit = await projectKit();
		if (!kit) return;
		const { page, frame } = await open(kit, true);
		const markup = `<div id="page"><Counter label="Clicks" /><Button onClick={sendPrompt("from kit")}>Go</Button><Stack /></div>`;
		await post(page, markup.slice(0, markup.indexOf("<Button")), false);
		await frame.waitForSelector(".acme-counter");
		await frame.click(".acme-counter");
		await frame.click(".acme-counter");
		await post(page, markup, true);
		await frame.waitForSelector(".acme-btn");
		// The component's own React state survived the rest of the UI streaming in.
		expect(await frame.$eval(".acme-counter", (node) => node.textContent)).toBe("Clicks: 2");
		// Rendered inside the project's setup wrapper and styled by the project's CSS.
		expect(await frame.$("[data-kit-setup='acme'] .acme-btn")).not.toBeNull();
		expect(await frame.$eval(".acme-btn", (node) => getComputedStyle(node).borderTopColor)).toBe(
			"rgb(232, 89, 12)",
		);
		// The built-in Mantine set is not part of this workspace's kit.
		expect(await frame.$eval("#page", (node) => node.textContent)).toContain("<Stack>");
		await frame.click(".acme-btn");
		await page.waitForFunction(
			() => (window as unknown as { actions: unknown[] }).actions.length >= 1,
		);
		expect(await actions(page)).toEqual([["sendPrompt", "from kit"]]);
		await page.close();
	},
	180_000,
);
