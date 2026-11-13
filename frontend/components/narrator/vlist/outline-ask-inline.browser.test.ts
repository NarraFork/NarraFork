import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { OutlineAnswerHttpInput, OutlineQuestionView } from "@shared/outline-api";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./outline-ask-inline.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
const executablePath =
	process.env.NF_TEST_CHROMIUM_PATH ??
	"/home/fulcrum/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;
const requests: string[] = [];
const submissions: OutlineAnswerHttpInput[][] = [];
const errors: string[] = [];
let answered = false;
function question(id: string): OutlineQuestionView {
	const submitted = submissions[0]?.find((answer) => answer.blockId === id);
	return {
		blockId: id,
		spaceId: "space",
		sid: id,
		address: `space/${id}`,
		parentId: id === "child" ? "first" : "shared-task",
		alias: id,
		text: `Current ${id} question?`,
		options: ["Yes", "No"],
		recommend: { option: 1, text: null, reason: "Recommended" },
		proceed: false,
		state: answered ? "answered" : "open",
		to: { userId: "alice", name: "Alice" },
		answer: answered
			? {
					option: submitted?.option ?? null,
					text: "Saved answer",
					adopted: false,
					by: { userId: "alice", name: "Alice" },
					at: "2026-11-10T00:00:00Z",
					relayed: false,
					relayedVia: null,
				}
			: null,
		askedBy: { narratorId: "n", title: "Worker", hidden: false },
		createdAt: "2026-11-10T00:00:00Z",
		canAnswer: !answered,
		versionSeq: 1,
	};
}
beforeAll(async () => {
	if (!existsSync(executablePath)) throw new Error(`Chromium unavailable: ${executablePath}`);
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "outline-ask-inline.browser-fixture.tsx")],
		target: "browser",
		format: "esm",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const entry = bundle.outputs.find((output) => output.kind === "entry-point");
	if (!entry) throw new Error("Missing fixture");
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	const html = `<!doctype html><html><head>${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>html,body{margin:0}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});</script></body></html>`;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.startsWith("/api/")) requests.push(path);
			if (path === "/api/outline/questions/answer") {
				const body = (await request.json()) as { answers: OutlineAnswerHttpInput[] };
				submissions.push(body.answers);
				answered = true;
				return Response.json({ answered: body.answers.map((answer) => answer.blockId) });
			}
			const questionPath = path.match(/^\/api\/outline\/blocks\/([^/]+)\/questions$/);
			if (questionPath) {
				const id = questionPath[1];
				return Response.json({
					group: {
						blockId: id,
						spaceId: "space",
						spaceKey: "space",
						pageId: "page",
						title: "Questions",
						isQuestion: true,
					},
					questions: (id === "first" ? ["first", "child"] : ["second", "child", "foreign"]).map(
						question,
					),
					truncated: false,
				});
			}
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	page = await browser.newPage();
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.setViewport({ width: 420, height: 900 });
}, 60_000);
afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});
async function load(enabled: boolean) {
	await page.goto(`http://127.0.0.1:${server.port}/`);
	await page.waitForFunction(() => !!(window as unknown as FixtureWindow).fixture);
	await page.evaluate(
		(value) => (window as unknown as FixtureWindow).fixture.mount(value),
		enabled,
	);
}
async function expectSettledHeight() {
	await page.waitForFunction(() => {
		const card = document.querySelector("[data-nf-card-surface]")?.getBoundingClientRect();
		const canvas = document.getElementById("canvas");
		const following = document.getElementById("following")?.getBoundingClientRect();
		return (
			card &&
			canvas &&
			following &&
			Math.abs(Number(canvas.dataset.height) - card.height) <= 1 &&
			Math.abs(following.top - card.bottom - 8) <= 1
		);
	});
	return page.$eval("[data-nf-card-surface]", (node) => node.getBoundingClientRect().height);
}
test("real inline form survives folding/virtualization, submits only this Ask and shrinks without gaps", async () => {
	await load(true);
	await page
		.waitForSelector('[data-testid="outline-questions-submit"]', { timeout: 5000 })
		.catch(async (error) => {
			throw new Error(
				`${String(error)}\n${JSON.stringify(errors)}\n${await page.$eval("#root", (node) => node.textContent)}`,
			);
		});
	expect(await page.$$eval('[data-testid="outline-questions"]', (nodes) => nodes.length)).toBe(1);
	expect(
		await page.$$eval('[data-testid="outline-questions"] textarea', (nodes) => nodes.length),
	).toBe(3);
	expect(await page.$('[data-testid="outline-question-foreign"]')).toBeNull();
	expect([...new Set(requests)]).toEqual([
		"/api/outline/blocks/first/questions",
		"/api/outline/blocks/second/questions",
	]);
	const initialHeight = await expectSettledHeight();
	const selector = '[data-testid="outline-question-first"] textarea';
	const draft = "A deliberate custom answer\n".repeat(12).trim();
	await page.type(selector, draft);
	expect(await expectSettledHeight()).toBeGreaterThan(initialHeight);
	await page.click("#fold");
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="outline-questions"] textarea'),
	);
	await expectSettledHeight();
	await page.click("#fold");
	await page.waitForSelector(selector);
	expect(await page.$eval(selector, (node) => (node as HTMLTextAreaElement).value)).toBe(draft);
	await page.click("#mount");
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="outline-questions"] textarea'),
	);
	await page.click("#mount");
	await page.waitForSelector(selector);
	expect(await page.$eval(selector, (node) => (node as HTMLTextAreaElement).value)).toBe(draft);
	await page.type('[data-testid="outline-question-child"] textarea', "Child answer");
	await page.type('[data-testid="outline-question-second"] textarea', "Second answer");
	const beforeAnswer = await expectSettledHeight();
	await page.click('[data-testid="outline-questions-submit"]');
	await page.waitForFunction(
		() => document.querySelectorAll('[data-state="answered"]').length === 3,
	);
	expect(submissions).toHaveLength(1);
	expect(submissions[0]?.map((answer) => answer.blockId)).toEqual(["first", "child", "second"]);
	expect(submissions[0]?.[0]).toEqual({ blockId: "first", versionSeq: 1, text: draft });
	expect(await expectSettledHeight()).toBeLessThan(beforeAnswer);
	expect(await page.$('[data-testid="outline-questions"] textarea')).toBeNull();
	expect(await page.$('[data-testid="outline-questions-submit"]')).toBeNull();
	expect(errors).toEqual([]);
}, 30_000);
test("default/public replay makes no private outline requests", async () => {
	requests.length = 0;
	await load(false);
	await page.waitForSelector("[data-nf-card-surface]");
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	expect(await page.$('[data-testid="outline-questions"]')).toBeNull();
	expect(requests).toEqual([]);
	expect(errors).toEqual([]);
}, 15_000);
