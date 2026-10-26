// e2e 公共工具：启动无头 Chromium、打开原型页、记录每项检查的结果。
import { createRequire } from "node:module";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

let shared = null;

export async function env() {
	if (!shared) {
		const { srv, url } = await startServer();
		const browser = await chromium.launch();
		shared = { srv, url, browser };
	}
	return shared;
}

export async function closeEnv() {
	if (!shared) return;
	await shared.browser.close();
	shared.srv.close();
	shared = null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一个新的页面（新的上下文：服务端、客户端都是全新的）。 */
export async function open(query = "", { viewport = { width: 1400, height: 1000 } } = {}) {
	const { url, browser } = await env();
	const context = await browser.newContext({ viewport });
	const origin = new URL(url).origin;
	await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(url + query);
	await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
	const cdp = await context.newCDPSession(page);
	const ev = (f, ...a) => page.evaluate(f, ...a);
	const idle = async () => {
		await page.evaluate(() => window.proto.idle());
		await sleep(5);
		await page.evaluate(() => window.proto.idle());
	};
	return {
		page,
		cdp,
		ev,
		idle,
		errors,
		close: () => context.close(),
		focus: (view, block, offset, headOffset, headBlock) =>
			page.evaluate(
				([v, b, o, ho, hb]) => window.proto.focus(v, b, o, ho, hb),
				[view, block, offset, headOffset, headBlock],
			),
		text: (client, block) => page.evaluate(([c, b]) => window.proto.text(c, b), [client, block]),
		serverText: (block) => page.evaluate((b) => window.proto.serverText(b), block),
		viewText: (view, block) =>
			page.evaluate(([v, b]) => window.proto.viewBlockText(v, b), [view, block]),
		serverOutline: (pageId) => page.evaluate((p) => window.proto.serverOutline(p), pageId),
		viewOutline: (view) => page.evaluate((v) => window.proto.viewOutline(v), view),
		clientOutline: (client, pageId) =>
			page.evaluate(([c, p]) => window.proto.outline(c, p), [client, pageId]),
		selection: (view) => page.evaluate((v) => window.proto.selection(v), view),
		insertVia: (view, block, offset, text) =>
			page.evaluate(
				([v, b, o, t]) => window.proto.insertVia(v, b, o, t),
				[view, block, offset, text],
			),
		cmd: (view, name, block, offset = 0) =>
			page.evaluate(([v, n, b, o]) => window.proto.cmd(v, n, b, o), [view, name, block, offset]),
		hold: (client, on) => page.evaluate(([c, o]) => window.proto.net.hold(c, o), [client, on]),
		ime: {
			set: (text) =>
				cdp.send("Input.imeSetComposition", {
					text,
					selectionStart: text.length,
					selectionEnd: text.length,
				}),
			commit: (text) => cdp.send("Input.insertText", { text }),
			/** 组合期间按键：真实输入法下 keydown 的 keyCode 是 229，按键由输入法处理。 */
			key: async (code, key = "Process") => {
				await cdp.send("Input.dispatchKeyEvent", {
					type: "rawKeyDown",
					windowsVirtualKeyCode: 229,
					nativeVirtualKeyCode: 229,
					key,
					code,
				});
				await cdp.send("Input.dispatchKeyEvent", {
					type: "keyUp",
					windowsVirtualKeyCode: 229,
					key,
					code,
				});
			},
		},
	};
}

/** 一个验收项：若干条检查。 */
export class Item {
	constructor(id, title) {
		this.id = id;
		this.title = title;
		this.checks = [];
		this.metrics = {};
		this.notes = [];
	}
	check(name, ok, info) {
		this.checks.push({ name, ok: !!ok, info: info === undefined ? undefined : info });
		return ok;
	}
	eq(name, got, want) {
		const ok = JSON.stringify(got) === JSON.stringify(want);
		return this.check(name, ok, ok ? undefined : { got, want });
	}
	note(s) {
		this.notes.push(s);
	}
	get status() {
		if (!this.checks.length) return "未测";
		return this.checks.every((c) => c.ok) ? "通过" : "失败";
	}
}
