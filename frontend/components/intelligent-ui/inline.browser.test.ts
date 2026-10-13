import { expect, test } from "bun:test";
import { join } from "node:path";
import type { IntelligentUiKitRequest } from "@shared/intelligent-ui-kit";
import puppeteer, { type Frame, type Page } from "puppeteer-core";
import { browserLaunchEnvironment } from "./test-fixtures";

/**
 * The chat card itself, in a real browser, against a stand-in for the API: what a reader
 * sees and can do while a `render` call streams, and the confirmation that gates a kit
 * build. Everything between the tool row's props and the server is real.
 */
const browserTest = process.env.BROWSER_EXECUTABLE ? test : test.skip;

declare global {
	interface Window {
		inlineFixture: {
			stream(source: string, live: boolean): void;
			kit(notice: unknown): void;
		};
	}
}

const MARKUP = `<Stack gap="sm">
	<Title order={4} id="title">Plans</Title>
	<TextInput id="name" label="Name" />
	<Group>
		<Button id="go" onClick={() => sendPrompt("Compare the plans")}>Compare</Button>
		<a id="link" href="https://example.com/docs">Docs</a>
	</Group>
	<Text id="tail">done</Text>
</Stack>`;

async function buttons(page: Page): Promise<string[]> {
	return page.$$eval("#card button", (nodes) => nodes.map((node) => node.textContent ?? ""));
}
async function clickButton(page: Page, label: string) {
	await page.waitForFunction(
		(text) => [...document.querySelectorAll("#card button")].some((b) => b.textContent === text),
		{},
		label,
	);
	await page.evaluate((text) => {
		const button = [...document.querySelectorAll("#card button")].find(
			(node) => node.textContent === text,
		) as HTMLButtonElement | undefined;
		button?.click();
	}, label);
}

let built: Promise<Record<string, [string, string]>> | undefined;
/** The fixture page and the built-in runtime, built once for every test in this file. */
function assets(): Promise<Record<string, [string, string]>> {
	built ??= (async () => {
		const [fixture, runtime] = await Promise.all([
			Bun.build({
				entrypoints: [join(import.meta.dir, "inline.browser.fixture.tsx")],
				target: "browser",
				define: { "process.env.NODE_ENV": '"production"' },
			}),
			Bun.build({
				entrypoints: [join(import.meta.dir, "../../plugin-runtime/vendor.ts")],
				target: "browser",
				format: "iife",
				minify: true,
				define: { "process.env.NODE_ENV": '"production"' },
			}),
		]);
		if (!fixture.success || !runtime.success)
			throw new AggregateError([...fixture.logs, ...runtime.logs], "Browser fixture build failed");
		const text = async (build: typeof fixture, extension: string) => {
			const output = build.outputs.find((file) => file.path.endsWith(extension));
			if (!output) throw new Error(`Missing ${extension} output`);
			return output.text();
		};
		return {
			"/nf/fixture.js": [await text(fixture, ".js"), "text/javascript"],
			"/nf/fixture.css": [await text(fixture, ".css"), "text/css"],
			"/nf/plugin-runtime/vendor.js": [await text(runtime, ".js"), "text/javascript"],
			"/nf/plugin-runtime/vendor.css": [await text(runtime, ".css"), "text/css"],
		};
	})();
	return built;
}

/**
 * A stand-in API that records chat messages; `kit` answers the kit routes. Runs `body`
 * against the fixture page in a fresh browser and tears both down afterwards.
 */
async function withFixturePage(
	kit: (path: string, incoming: Request) => Promise<Response | null> | Response | null,
	body: (page: Page, messages: Array<{ token: string | null; body: unknown }>) => Promise<void>,
) {
	const files = await assets();
	const messages: Array<{ token: string | null; body: unknown }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(incoming) {
			const path = new URL(incoming.url).pathname;
			if (path.endsWith("/api/narrators/n1/messages")) {
				messages.push({
					token: incoming.headers.get("Authorization"),
					body: await incoming.json(),
				});
				return Response.json({ ok: true });
			}
			const answered = await kit(path, incoming);
			if (answered) return answered;
			if (files[path])
				return new Response(files[path][0], { headers: { "Content-Type": files[path][1] } });
			return new Response(
				'<!doctype html><html><head><base href="/nf/"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
	try {
		browser = await puppeteer.launch({
			executablePath: process.env.BROWSER_EXECUTABLE,
			headless: true,
			args: ["--no-sandbox", "--no-first-run"],
			env: browserLaunchEnvironment(),
			timeout: 30000,
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(8000);
		await page.setViewport({ width: 1000, height: 800 });
		await page.goto(`http://127.0.0.1:${server.port}/nf/`);
		await page.waitForFunction(() => typeof window.inlineFixture?.stream === "function");
		await body(page, messages);
	} finally {
		await browser?.close();
		await server.stop(true);
	}
}

async function cardText(page: Page): Promise<string> {
	return page.$eval("#card", (node) => node.textContent ?? "");
}

browserTest(
	"inline card: streams into one frame, sends the reader's click as a chat message, gates the kit build",
	async () => {
		let request: IntelligentUiKitRequest | null = {
			id: "req-1",
			kind: "build",
			state: "pending",
			reason: "no kit",
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const approvals: unknown[] = [];
		let kitReads = 0;
		const kit = async (path: string, incoming: Request) => {
			if (path.endsWith("/intelligent-ui/kit/approve")) {
				approvals.push(await incoming.json());
				if (request) request = { ...request, state: "approved" };
				return Response.json({ status: { state: "builtin", components: [] }, request });
			}
			if (path.endsWith("/intelligent-ui/kit")) {
				kitReads++;
				return Response.json({ status: { state: "builtin", components: [] }, request });
			}
			return null;
		};
		await withFixturePage(kit, async (page, messages) => {
			// The first chunks arrive: a frame appears and shows what has completed.
			const cut = MARKUP.indexOf("<Group>");
			for (let length = 6; length < cut; length += 9)
				await page.evaluate((s) => window.inlineFixture.stream(s, true), MARKUP.slice(0, length));
			await page.evaluate((s) => window.inlineFixture.stream(s, true), MARKUP.slice(0, cut));
			const handle = await page.waitForSelector('#card iframe[title="Plans"]');
			const frame = (await handle?.contentFrame()) as Frame;
			await frame.waitForSelector("#name");
			expect(await frame.$("#go")).toBeNull();
			// While it streams, the header says so.
			expect(await page.$eval("#card", (node) => node.textContent)).toContain("Generating Plans");
			expect(await handle?.evaluate((node) => node.getAttribute("sandbox"))).toBe("allow-scripts");
			await frame.type("#name", "kept");

			// The rest arrives; the SAME frame keeps what the reader typed.
			for (let length = cut; length < MARKUP.length; length += 9)
				await page.evaluate((s) => window.inlineFixture.stream(s, true), MARKUP.slice(0, length));
			await page.evaluate((s) => window.inlineFixture.stream(s, false), MARKUP);
			await frame.waitForSelector("#tail");
			expect(await frame.$eval("#name", (node) => (node as HTMLInputElement).value)).toBe("kept");
			expect((await page.$$("#card iframe")).length).toBe(1);
			expect(await page.$eval("#card", (node) => node.textContent)).not.toContain("Generating");
			// The card never outgrew the height its row reserved.
			expect(await page.$eval("#card > div", (node) => (node as HTMLElement).offsetHeight)).toBe(
				400,
			);

			// A click on generated UI becomes the user's next chat message, sent as the user.
			await frame.click("#go");
			await page.waitForFunction(() => true);
			// The built-in runtime's gesture check is the guard here: one click, no bar.
			expect(await cardText(page)).not.toContain("Send this to the chat?");
			for (let waited = 0; messages.length === 0 && waited < 40; waited++)
				await new Promise((done) => setTimeout(done, 50));
			expect(messages).toHaveLength(1);
			expect(messages[0]?.body).toMatchObject({ message: "Compare the plans" });
			expect(messages[0]?.token).toBe("Bearer fixture-private-token");
			// A double click is one message.
			await frame.click("#go");
			await new Promise((done) => setTimeout(done, 300));
			expect(messages).toHaveLength(1);

			// A link is shown to the reader before anything opens.
			await frame.click("#link");
			await page.waitForFunction(() =>
				document.querySelector("#card")?.textContent?.includes("Open https://example.com/docs?"),
			);
			expect(await page.$eval('#card a[href="https://example.com/docs"]', (a) => a.target)).toBe(
				"_blank",
			);
			await clickButton(page, "Cancel");

			// The result lands with a kit request: the reader is asked, once, and confirms.
			expect(await buttons(page)).not.toContain("Confirm");
			await page.evaluate(() =>
				window.inlineFixture.kit({
					state: "builtin",
					request: { id: "req-1", kind: "build", state: "pending" },
				}),
			);
			await clickButton(page, "Confirm");
			await page.waitForFunction(() =>
				document.querySelector("#card")?.textContent?.includes("Confirmed"),
			);
			expect(approvals).toEqual([{ requestId: "req-1" }]);
			expect(await buttons(page)).not.toContain("Confirm");
			// Asking did not disturb the UI the reader was using.
			expect(await frame.$eval("#name", (node) => (node as HTMLInputElement).value)).toBe("kept");
			expect(kitReads).toBeGreaterThan(0);

			// A notice for a request the server no longer has shows nothing to click.
			request = null;
			await page.evaluate(() =>
				window.inlineFixture.kit({
					state: "builtin",
					request: { id: "req-gone", kind: "build", state: "pending" },
				}),
			);
			await new Promise((done) => setTimeout(done, 400));
			expect(await buttons(page)).not.toContain("Confirm");
		});
	},
	120_000,
);

browserTest(
	"inline card: a project kit's own sendPrompt is held for the reader to confirm",
	async () => {
		// Kit code runs in the same frame as the gesture check, so it can post the action
		// itself without the reader touching anything.
		const forged =
			'parent.postMessage({type:"narrafork:ui-action",action:"sendPrompt",value:"pwned"},"*")';
		const kit = (path: string) => {
			if (path.endsWith("/intelligent-ui/kit/bundle"))
				return Response.json({
					js: forged,
					css: "",
					hash: "forged",
					components: [],
					hasSetup: false,
				});
			if (path.endsWith("/intelligent-ui/kit"))
				return Response.json({
					status: { state: "ready", components: [], hash: "forged" },
					request: null,
				});
			return null;
		};
		await withFixturePage(kit, async (page, messages) => {
			await page.evaluate(() => window.inlineFixture.stream("<Stack><p>hello</p></Stack>", true));
			const handle = await page.waitForSelector('#card iframe[title="Plans"]');
			const frame = (await handle?.contentFrame()) as Frame;
			await page.waitForFunction(() =>
				document.querySelector("#card")?.textContent?.includes("Send this to the chat? pwned"),
			);
			expect(await page.$eval('#card [title="pwned"]', (node) => node.textContent)).toBe(
				"Send this to the chat? pwned",
			);
			// Shown, not sent. A later post keeps the text already on the bar.
			await frame.evaluate(() =>
				parent.postMessage(
					{ type: "narrafork:ui-action", action: "sendPrompt", value: "swapped" },
					"*",
				),
			);
			await new Promise((done) => setTimeout(done, 300));
			expect(await page.$eval('#card [title="pwned"]', (node) => node.textContent)).toBe(
				"Send this to the chat? pwned",
			);
			expect(messages).toEqual([]);

			// The reader's click is what sends it, once, as the user.
			await clickButton(page, "Send");
			for (let waited = 0; messages.length === 0 && waited < 40; waited++)
				await new Promise((done) => setTimeout(done, 50));
			expect(messages).toHaveLength(1);
			expect(messages[0]?.body).toEqual({ message: "pwned" });
			expect(messages[0]?.token).toBe("Bearer fixture-private-token");
			expect(await cardText(page)).not.toContain("Send this to the chat?");

			// Another forged prompt, declined: nothing more is sent.
			await frame.evaluate(() =>
				parent.postMessage(
					{ type: "narrafork:ui-action", action: "sendPrompt", value: "pwned again" },
					"*",
				),
			);
			await page.waitForFunction(() =>
				document
					.querySelector("#card")
					?.textContent?.includes("Send this to the chat? pwned again"),
			);
			await clickButton(page, "Cancel");
			await page.waitForFunction(
				() => !document.querySelector("#card")?.textContent?.includes("Send this to the chat?"),
			);
			await new Promise((done) => setTimeout(done, 1200));
			expect(messages).toHaveLength(1);
		});
	},
	120_000,
);
