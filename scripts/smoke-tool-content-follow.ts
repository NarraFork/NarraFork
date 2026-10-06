// bun scripts/smoke-tool-content-follow.ts
// Own loopback server + fresh Chromium/profile. No application service, DB or geometry mocks.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { FollowAudit, FollowCase, FollowSnapshot } from "./smoke-tool-content-follow-fixture";

const TIMEOUT = 160_000;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const project = join(import.meta.dir, "..");
const reportDir = join(
	project,
	".narrafork",
	`tool-content-follow-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const checks: { name: string; pass: boolean; detail: unknown; screenshot?: string }[] = [];
const matrix: { options: FollowCase; mount: FollowSnapshot; growth: FollowSnapshot }[] = [];
const errors: string[] = [];
const failedRequests: string[] = [];
const geometryStages: ReturnType<FollowAudit["geometryAudit"]>[] = [];
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let bundleBytes = 0;
let screenshotCount = 0;
let timedOut = false;

async function chromePath(): Promise<string> {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
	const cache = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
	if (existsSync(cache))
		for await (const file of new Bun.Glob(
			"chrome/*/**/{chrome,chrome.exe,Google Chrome for Testing}",
		).scan({ cwd: cache, absolute: true }))
			return file;
	for (const file of [
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	])
		if (existsSync(file)) return file;
	throw new Error("Chrome unavailable; set PUPPETEER_EXECUTABLE_PATH. No automatic downloads.");
}

async function fixtureServer() {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "smoke-tool-content-follow-fixture.tsx")],
		target: "browser",
		minify: true,
		splitting: true,
		define: {
			"process.env.NODE_ENV": '"production"',
			"import.meta.env": '{"BASE_URL":"/","DEV":false,"PROD":true}',
		},
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n").slice(0, 8_000));
	bundleBytes = build.outputs.reduce((size, output) => size + output.size, 0);
	if (bundleBytes > 64 * 1024 * 1024) throw new Error("Fixture bundle exceeds 64MiB");
	const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool body follow smoke</title>${[
		...assets.keys(),
	]
		.filter((file) => file.endsWith(".css"))
		.map((file) => `<link rel="stylesheet" href="${file}">`)
		.join("")}</head><body><div id="root"></div>${build.outputs
		.filter((output) => output.kind === "entry-point" && output.path.endsWith(".js"))
		.map((output) => `<script type="module" src="/${basename(output.path)}"></script>`)
		.join("")}</body></html>`;
	const shiki = new Map<string, string>();
	for (const [part, names] of [
		["langs", ["typescript", "javascript"]],
		["themes", ["github-dark-default", "github-light-default"]],
	] as const) {
		for (const name of names)
			shiki.set(`/shiki/${part}/${name}.mjs`, Bun.resolveSync(`@shikijs/${part}/${name}`, project));
	}
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		async fetch(request) {
			if (request.method !== "GET") return new Response("read only", { status: 405 });
			const path = new URL(request.url).pathname;
			if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/api/user-preferences") return Response.json({});
			if (path === "/api/settings") return Response.json({ agent: {} });
			const grammar = shiki.get(path);
			if (grammar) {
				// Real loader and grammar; delayed transport exposes asynchronous highlight layout.
				await new Promise((resolve) => setTimeout(resolve, 180));
				const file = Bun.file(grammar);
				if (file.size > 4 * 1024 * 1024) return new Response("oversized grammar", { status: 413 });
				return new Response(file, { headers: { "content-type": "text/javascript" } });
			}
			const asset = assets.get(path);
			if (asset) return new Response(asset);
			if (failedRequests.length < 30) failedRequests.push(path.slice(0, 180));
			return new Response("isolated fixture", { status: 404 });
		},
	});
}

async function check(page: Page, name: string, pass: boolean, detail: unknown, capture = false) {
	let screenshot: string | undefined;
	if ((!pass || capture) && screenshotCount < 32) {
		screenshot = `${String(++screenshotCount).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 85)}.png`;
		await page.screenshot({ path: join(reportDir, screenshot), fullPage: false });
	}
	checks.push({ name, pass, detail, ...(screenshot ? { screenshot } : {}) });
	console.log(
		`[${pass ? "PASS" : "FAIL"}] ${name}${pass ? "" : ` ${JSON.stringify(detail).slice(0, 1100)}`}`,
	);
}

const frame = (page: Page, count = 45) =>
	page.evaluate((n) => window.__toolContentFollow.frames(n), count);
const snapshot = (page: Page, surface = "inline") =>
	page.evaluate((value) => window.__toolContentFollow.snapshot(value), surface);
async function set(page: Page, options: FollowCase, remount = true) {
	await page.evaluate((args) => window.__toolContentFollow.render(args.options, args.remount), {
		options,
		remount,
	});
	await frame(page);
	return snapshot(page);
}
const pinned = (value: FollowSnapshot) =>
	value.format === "diff" ? value.focusVisible === true : value.distance <= 4 && value.tailInDOM;
async function wheel(page: Page, deltaY: number, surface = "inline") {
	const point = await page.evaluate((value) => window.__toolContentFollow.point(value), surface);
	await page.mouse.move(point.x, point.y);
	await page.mouse.wheel({ deltaY });
	await frame(page, 9);
}
async function resume(page: Page, surface = "inline") {
	const point = await page.evaluate(
		(value) => window.__toolContentFollow.resumePoint(value),
		surface,
	);
	if (!point) throw new Error(`No resume button for ${surface}`);
	await page.mouse.click(point.x, point.y);
	await frame(page, 30);
}

await mkdir(reportDir, { recursive: true });
const deadline = setTimeout(() => {
	timedOut = true;
	process.exitCode = 2;
	void browser?.close();
	server?.stop(true);
}, TIMEOUT);
try {
	server = await fixtureServer();
	browser = await puppeteer.launch({
		executablePath: await chromePath(),
		headless: true,
		timeout: 25_000,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling"],
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(12_000);
	page.on("pageerror", (error) => {
		if (errors.length < 20) errors.push(String(error).slice(0, 1_500));
	});
	await page.setViewport({ width: 1_100, height: 920 });
	await page.goto(`http://127.0.0.1:${server.port}/`, {
		waitUntil: "networkidle0",
		timeout: 30_000,
	});
	await page.waitForFunction(() => !!window.__toolContentFollow);
	const paths: FollowCase[] = [
		{ kind: "write", lines: 35 },
		{ kind: "write", lines: 35, path: false },
		{ kind: "edit", lines: 35 },
		{ kind: "edit", lines: 35, path: false },
		{ kind: "edit", lines: 35, replacing: true },
		{ kind: "bash", lines: 35 },
		{ kind: "command", lines: 35 },
		{ kind: "agent", lines: 35 },
		{ kind: "send", lines: 35 },
		{ kind: "plan", lines: 35 },
		{ kind: "terminal", lines: 35 },
		{ kind: "generic", lines: 35 },
		{ kind: "read", lines: 35 },
		{ kind: "transfer", lines: 35 },
		{ kind: "bash", lines: 35, surface: "viewer" },
		{ kind: "edit", lines: 35, surface: "viewer" },
		{ kind: "bash", lines: 35, surface: "content" },
		{ kind: "bash", lines: 35, surface: "content", language: "typescript" },
	];
	for (const [index, options] of paths.entries()) {
		const mount = await set(page, options);
		const growth = await set(page, { ...options, lines: 42 }, false);
		matrix.push({ options, mount, growth });
		const isStatic = options.kind === "read" || options.kind === "terminal";
		await check(
			page,
			`path-${index + 1}-${options.kind}-${options.surface ?? "inline"}`,
			growth.viewportNode === mount.viewportNode &&
				growth.bodyId === mount.bodyId &&
				(growth.renderKind === "communication-bubble"
					? growth.tailInDOM && !growth.following
					: isStatic
						? !growth.live && growth.scrollTop <= 1
						: mount.following && growth.following && growth.live && pinned(growth)) &&
				(options.kind !== "agent" || growth.renderKind === "subagent-card"),
			{ options, mount, growth },
		);
	}

	for (const kind of ["write", "bash"] as const) {
		await set(page, { kind, lines: 35 });
		const trace = await page.evaluate(() => window.__toolContentFollow.traceGrowth(50));
		const begin = trace[0]?.scrollTop ?? 0;
		const end = trace.at(-1)?.scrollTop ?? 0;
		await check(
			page,
			`${kind}-smooth-multiframe-growth`,
			trace.some((value) => value.scrollTop > begin + 1 && value.scrollTop < end - 1) &&
				pinned(trace.at(-1) as FollowSnapshot),
			trace,
		);
	}

	for (const lines of [500, 2_000]) {
		const before = await set(page, { kind: "edit", lines, short: true });
		const after = await set(page, { kind: "edit", lines: lines + 1, short: true }, false);
		await check(
			page,
			`diff-${lines}-focus-crosses-both-budgets`,
			before.focusVisible === true &&
				after.focusVisible === true &&
				after.focus?.line === lines &&
				after.retainedChars < 16_000 &&
				after.projectionCount <= 500 &&
				after.maxRowsPainted < 100 &&
				after.viewportNode === before.viewportNode,
			{ before, after },
			true,
		);
	}
	const suffix = await set(page, {
		kind: "edit",
		lines: 80,
		oldLines: 2_000,
		replacing: true,
		short: true,
	});
	await check(
		page,
		"diff-new-focus-before-long-old-deletion-suffix",
		suffix.focusVisible === true &&
			suffix.focus?.side === "new" &&
			suffix.focus.line === 79 &&
			suffix.distance > 1_000 &&
			suffix.rowsPainted < 100,
		suffix,
		true,
	);
	const growing = {
		kind: "edit",
		lines: 1,
		replacing: true,
		oldText: "old",
		newText: "a".repeat(80),
	} satisfies FollowCase;
	const smallLine = await set(page, growing);
	const longLine = await set(page, { ...growing, newText: "a".repeat(2_000) }, false);
	await check(
		page,
		"diff-single-row-growth-follows-last-soft-wrap",
		longLine.focusVisible === true &&
			longLine.focus?.column === 2_000 &&
			longLine.scrollTop > smallLine.scrollTop + 100 &&
			longLine.visualLinesPainted < 100,
		{ smallLine, longLine },
		true,
	);
	const added = await set(page, {
		kind: "edit",
		lines: 1,
		replacing: true,
		oldText: "same",
		newText: "sam",
	});
	const context = await set(
		page,
		{ kind: "edit", lines: 1, replacing: true, oldText: "same", newText: "same" },
		false,
	);
	await check(
		page,
		"diff-added-becomes-context-with-same-canvas",
		added.focusType === "added" &&
			context.focusType === "context" &&
			context.focusVisible === true &&
			context.canvasNode === added.canvasNode &&
			context.viewportNode === added.viewportNode,
		{ added, context },
	);

	for (const options of [
		{ kind: "write" },
		{ kind: "edit" },
		{ kind: "bash" },
		{ kind: "bash", surface: "content" },
	] as const) {
		const before = await set(page, { ...options, lines: 40 });
		const after = await set(page, { ...options, lines: 40, live: false }, false);
		await check(
			page,
			`${options.kind}-${"surface" in options ? options.surface : "inline"}-40-lines-settles-same-window`,
			!after.live &&
				before.viewportNode === after.viewportNode &&
				(options.kind !== "edit" || before.canvasNode === after.canvasNode) &&
				pinned(after) &&
				before.following === after.following &&
				(options.kind === "edit"
					? Math.abs(before.scrollTop - after.scrollTop) <= 3
					: Math.abs(
							before.scrollTop + before.clientHeight - after.scrollTop - after.clientHeight,
						) <= 3),
			{ before, after },
		);
	}

	const prefix = await set(page, { kind: "bash", lines: 40, live: false, truncated: true });
	await wheel(page, 280);
	await frame(page, 24);
	const hydrated = await snapshot(page);
	await check(
		page,
		"historical-prefix-reader-hydrates-without-jump",
		prefix.scrollTop === 0 &&
			prefix.fetches === 0 &&
			hydrated.fetches === 1 &&
			hydrated.lines === 160 &&
			hydrated.viewportNode === prefix.viewportNode &&
			hydrated.scrollTop > 0 &&
			hydrated.scrollTop < 500 &&
			hydrated.distance > 500,
		{ prefix, hydrated },
		true,
	);

	await set(page, { kind: "bash", lines: 40 });
	await page.evaluate(() => window.__toolContentFollow.start(30, 50));
	await frame(page, 4);
	await wheel(page, -200);
	const paused = await snapshot(page);
	await frame(page, 16);
	const during = await snapshot(page);
	await check(
		page,
		"bash-30ms-trusted-wheel-pauses-during-stream",
		!paused.following &&
			!during.following &&
			during.lines > paused.lines &&
			Math.abs(during.scrollTop - paused.scrollTop) <= 2 &&
			during.distance > paused.distance,
		{ paused, during },
		true,
	);
	await resume(page);
	await page.waitForFunction(() => !window.__toolContentFollow.active());
	await frame(page);
	const resumed = await snapshot(page);
	await check(
		page,
		"bash-30ms-resume-catches-current-output",
		resumed.following && pinned(resumed),
		resumed,
	);
	await page.evaluate(() => window.__toolContentFollow.start(30, 50));
	const keyPoint = await page.evaluate(() => window.__toolContentFollow.point());
	await page.mouse.click(keyPoint.x, keyPoint.y);
	await page.keyboard.press("PageUp");
	// Let Chromium finish the trusted key's native scroll animation before testing drift.
	await frame(page, 20);
	const keyPaused = await snapshot(page);
	await frame(page, 12);
	const keyLater = await snapshot(page);
	await check(
		page,
		"bash-trusted-keyboard-pauses-without-grace-period",
		!keyPaused.following &&
			!keyLater.following &&
			Math.abs(keyLater.scrollTop - keyPaused.scrollTop) <= 2,
		{ keyPaused, keyLater },
	);
	await page.evaluate(() => window.__toolContentFollow.stop());

	await set(page, { kind: "write", lines: 40, path: false });
	await wheel(page, -180);
	const noPath = await snapshot(page);
	const pathArrived = await set(page, { kind: "write", lines: 40, path: true }, false);
	await check(
		page,
		"late-path-does-not-remount-or-resume-reader",
		!pathArrived.following &&
			pathArrived.viewportNode === noPath.viewportNode &&
			pathArrived.bodyId === noPath.bodyId &&
			Math.abs(pathArrived.scrollTop - noPath.scrollTop) <= 2,
		{ noPath, pathArrived },
	);

	await set(page, { kind: "bash", lines: 40, surface: "content" });
	await wheel(page, -150);
	const beforeHighlight = await snapshot(page);
	const highlighted = await set(
		page,
		{ kind: "bash", lines: 40, surface: "content", language: "typescript" },
		false,
	);
	await frame(page, 60);
	const afterHighlight = await snapshot(page);
	await check(
		page,
		"real-shiki-completion-does-not-steal-paused-position",
		afterHighlight.coloredSpans > 0 &&
			afterHighlight.viewportNode === beforeHighlight.viewportNode &&
			!afterHighlight.following &&
			Math.abs(afterHighlight.scrollTop - beforeHighlight.scrollTop) <= 2,
		{ beforeHighlight, highlighted, afterHighlight },
	);

	await set(page, {
		kind: "edit",
		lines: 1_200,
		short: true,
		surface: "pair",
		replacing: true,
		oldLines: 2_000,
	});
	await wheel(page, 3_500, "full");
	const fullBefore = await snapshot(page, "full");
	const readingLine = fullBefore.firstVisibleLine ?? -1;
	const changed = Array.from({ length: 1_900 }, (_, index) => `r${index}`).join("\n");
	await set(
		page,
		{
			kind: "edit",
			lines: 1_900,
			short: true,
			surface: "pair",
			replacing: true,
			oldLines: 2_000,
			newText: changed,
		},
		false,
	);
	const inlineAfter = await snapshot(page);
	const fullAfter = await snapshot(page, "full");
	await check(
		page,
		"two-viewports-share-live-source-not-projection-or-reader",
		fullBefore.following === false &&
			fullAfter.following === false &&
			fullAfter.firstVisibleLine === readingLine &&
			fullBefore.firstVisibleType === "removed" &&
			fullAfter.firstVisibleType === "context" &&
			fullAfter.canvasRevision === inlineAfter.canvasRevision &&
			fullAfter.projectionStart !== inlineAfter.projectionStart &&
			inlineAfter.focusVisible === true &&
			fullAfter.warning !== "range" &&
			fullAfter.viewportNode === fullBefore.viewportNode,
		{ fullBefore, fullAfter, inlineAfter },
		true,
	);

	await resume(page, "full");
	await wheel(page, -1_200);
	const inlineReader = await snapshot(page);
	await set(
		page,
		{ kind: "edit", lines: 1_999, short: true, surface: "pair", replacing: true, oldLines: 2_000 },
		false,
	);
	const inlineStill = await snapshot(page);
	const fullFollowing = await snapshot(page, "full");
	await check(
		page,
		"two-viewports-can-swap-follow-and-paused-roles",
		!inlineStill.following &&
			inlineStill.firstVisibleLine === inlineReader.firstVisibleLine &&
			fullFollowing.following &&
			fullFollowing.focusVisible === true &&
			inlineStill.canvasRevision === fullFollowing.canvasRevision,
		{ inlineReader, inlineStill, fullFollowing },
	);
	await set(
		page,
		{ kind: "edit", lines: 2_000, short: true, replacing: true, oldLines: 2_000 },
		false,
	);
	await resume(page);
	const surviving = await set(
		page,
		{ kind: "edit", lines: 2_500, short: true, replacing: true, oldLines: 2_000 },
		false,
	);
	await check(
		page,
		"closing-full-view-does-not-cancel-inline-follow",
		surviving.following &&
			surviving.focusVisible === true &&
			(await page.evaluate(() => !document.querySelector('[data-audit-surface="full"]'))),
		surviving,
	);

	const seed =
		Array.from({ length: 2_200 }, (_, index) => `s${String(index).padStart(4, "0")}`).join("\r\n") +
		"\r";
	await page.evaluate(
		(value) => window.__toolContentFollow.beginStream("old_string", value, true),
		seed,
	);
	await frame(page);
	const initialRange = await snapshot(page);
	await wheel(page, -8_000, "full");
	const retainedReader = await snapshot(page, "full");
	await page.evaluate(() => window.__toolContentFollow.append("old_string", "\n"));
	await frame(page, 6);
	const afterLF = await snapshot(page);
	const delta = Array.from(
		{ length: 400 },
		(_, index) => `s${String(index + 2_200).padStart(4, "0")}`,
	).join("\r\n");
	await page.evaluate((value) => window.__toolContentFollow.append("old_string", value), delta);
	await frame(page, 25);
	const trimmed = await snapshot(page);
	const retainedAfter = await snapshot(page, "full");
	await check(
		page,
		"real-stream-fold-crlf-split-and-16k-eviction",
		initialRange.sourceRange?.epoch === trimmed.sourceRange?.epoch &&
			afterLF.sourceRange?.endOffset === initialRange.sourceRange?.endOffset &&
			(trimmed.sourceRange?.startOffset ?? 0) > 0 &&
			trimmed.retainedChars <= 16_000 &&
			trimmed.focus?.line === 2_599 &&
			trimmed.focusVisible === true &&
			trimmed.sourceLastLine === "s2599",
		{ initialRange, afterLF, trimmed },
		true,
	);
	await check(
		page,
		"16k-retained-reader-stays-paused-on-same-source-line",
		retainedAfter.following === false &&
			retainedAfter.firstVisibleLine === retainedReader.firstVisibleLine &&
			retainedAfter.canvasRevision === trimmed.canvasRevision &&
			retainedAfter.warning !== "range",
		{ retainedReader, retainedAfter, trimmed },
	);
	await page.evaluate(() => window.__toolContentFollow.append("old_string", "x"));
	await frame(page);
	const partial = await snapshot(page);
	await check(
		page,
		"16k-partial-first-line-keeps-source-identity",
		partial.sourceRange?.epoch === trimmed.sourceRange?.epoch &&
			partial.sourceRange?.startLine === trimmed.sourceRange?.startLine &&
			partial.sourceRange?.startColumn === 1 &&
			partial.sourceRange?.startOffset === (trimmed.sourceRange?.startOffset ?? 0) + 1 &&
			partial.focus?.line === 2_599 &&
			partial.focus.column === 6 &&
			partial.focusVisible === true,
		{ trimmed, partial },
	);
	const evict = Array.from(
		{ length: 3_000 },
		(_, index) => `s${String(index + 2_600).padStart(4, "0")}`,
	).join("\r\n");
	await page.evaluate(
		(value) => window.__toolContentFollow.append("old_string", `\r\n${value}`),
		evict,
	);
	await frame(page, 25);
	const lost = await snapshot(page, "full");
	await check(
		page,
		"16k-lost-reader-clamps-boundary-with-warning-not-focus",
		!lost.following &&
			lost.warning === "range" &&
			lost.scrollTop <= 2 &&
			lost.firstVisibleLine === lost.sourceRange?.startLine &&
			lost.focusVisible === false,
		lost,
		true,
	);

	const beforeDrag = await set(page, { kind: "edit", lines: 1_000, short: true });
	const verticalThumb = await page.evaluate(() => window.__toolContentFollow.scrollbarPoint("y"));
	if (!verticalThumb) throw new Error("Missing modeled vertical scrollbar");
	await page.mouse.move(verticalThumb.x, verticalThumb.y);
	await page.mouse.down();
	await page.mouse.move(verticalThumb.x, verticalThumb.y - 60, { steps: 8 });
	await page.mouse.up();
	await frame(page);
	const afterDrag = await snapshot(page);
	await check(
		page,
		"modeled-scrollbar-native-pointer-drag-pauses-and-scrolls",
		!afterDrag.following &&
			afterDrag.scrollTop < beforeDrag.scrollTop - 100 &&
			afterDrag.viewportNode === beforeDrag.viewportNode,
		{ beforeDrag, afterDrag },
	);
	await resume(page);
	const afterResume = await snapshot(page);
	await check(
		page,
		"modeled-scrollbar-resume-returns-to-latest-change",
		afterResume.following && afterResume.focusVisible === true,
		afterResume,
	);

	const wheelThumb = await page.evaluate(() => window.__toolContentFollow.scrollbarPoint("y"));
	if (!wheelThumb) throw new Error("Missing vertical thumb for native wheel test");
	await page.mouse.move(wheelThumb.x, wheelThumb.y);
	await page.mouse.wheel({ deltaY: -140 });
	await frame(page, 15);
	const overScrollbar = await snapshot(page);
	await check(
		page,
		"modeled-scrollbar-wheel-stays-in-inner-scrollport",
		!overScrollbar.following && overScrollbar.scrollTop < afterResume.scrollTop - 50,
		{ afterResume, overScrollbar },
	);

	await set(page, {
		kind: "edit",
		lines: 1,
		replacing: true,
		oldText: "",
		newText: "wide-column-".repeat(200),
	});
	await page.evaluate(() => window.__toolContentFollow.toggleWrap());
	await frame(page);
	const horizontalThumb = await page.evaluate(() => window.__toolContentFollow.scrollbarPoint("x"));
	if (!horizontalThumb) throw new Error("Missing modeled horizontal scrollbar");
	await page.mouse.move(horizontalThumb.x, horizontalThumb.y);
	await page.mouse.down();
	await page.mouse.move(horizontalThumb.x + 100, horizontalThumb.y, { steps: 8 });
	await page.mouse.up();
	await frame(page);
	const horizontalReader = await snapshot(page);
	await check(
		page,
		"modeled-horizontal-scrollbar-does-not-resume-vertical-follow",
		horizontalReader.scrollLeft > 100 && !horizontalReader.following,
		horizontalReader,
	);

	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	await set(page, { kind: "bash", lines: 40 });
	const reduced = await page.evaluate(() => window.__toolContentFollow.traceGrowth(50));
	const first = reduced[0]?.scrollTop ?? 0;
	const last = reduced.at(-1)?.scrollTop ?? 0;
	await check(
		page,
		"reduced-motion-uses-direct-positioning",
		pinned(reduced.at(-1) as FollowSnapshot) &&
			!reduced.some((value) => value.scrollTop > first + 1 && value.scrollTop < last - 1),
		reduced,
	);
	await page.emulateMediaFeatures([]);
	// Changing mobile emulation reloads Chromium's document; collect each page lifetime.
	geometryStages.push(await page.evaluate(() => window.__toolContentFollow.geometryAudit()));
	await page.setViewport({
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		isMobile: true,
		hasTouch: true,
	});
	await page.waitForFunction(() => !!window.__toolContentFollow);
	const narrow = await set(page, { kind: "edit", lines: 2_000, short: true, theme: "light" });
	await check(
		page,
		"narrow-light-2000-line-diff-focus-and-bounded-dom",
		narrow.focusVisible === true &&
			narrow.projectionCount <= 500 &&
			narrow.rowsPainted < 100 &&
			narrow.clientWidth <= 390,
		narrow,
		true,
	);
	geometryStages.push(await page.evaluate(() => window.__toolContentFollow.geometryAudit()));
	await page.setViewport({ width: 1_100, height: 920 });
	await page.waitForFunction(() => !!window.__toolContentFollow);
	const markdown = Array.from(
		{ length: 80 },
		(_, index) => `### Step ${index}\n\nExplain audit_line_${String(index + 1).padStart(4, "0")}.`,
	).join("\n\n");
	await set(page, { kind: "plan", lines: 80, newText: markdown, surface: "viewer" });
	await wheel(page, -200);
	const markdownBefore = await snapshot(page);
	await page.evaluate(() => window.__toolContentFollow.toggleSource());
	await frame(page);
	const sourceView = await snapshot(page);
	const rawPainted = await page.evaluate(
		() =>
			document.querySelector("[data-content-scrollport]")?.textContent?.includes("### Step") ??
			false,
	);
	await page.evaluate(() => window.__toolContentFollow.toggleSource());
	await frame(page);
	const renderedAgain = await snapshot(page);
	await check(
		page,
		"markdown-source-toggle-retains-one-paused-scrollport",
		rawPainted &&
			!sourceView.following &&
			!renderedAgain.following &&
			sourceView.viewportNode === markdownBefore.viewportNode &&
			renderedAgain.viewportNode === markdownBefore.viewportNode,
		{ markdownBefore, sourceView, renderedAgain },
	);
	await page.evaluate(() => window.__toolContentFollow.unmount());
	await frame(page, 4);
	await check(
		page,
		"unmount-removes-all-content-scrollports",
		await page.evaluate(() => document.querySelectorAll("[data-content-scrollport]").length === 0),
		{},
	);
	geometryStages.push(await page.evaluate(() => window.__toolContentFollow.geometryAudit()));
	const geometry = {
		reads: geometryStages.flatMap((stage) => stage.reads),
		modeledSnapshots: geometryStages.reduce((count, stage) => count + stage.modeledSnapshots, 0),
		nativeSnapshots: geometryStages.reduce((count, stage) => count + stage.nativeSnapshots, 0),
	};
	await check(
		page,
		"modeled-diff-hosts-never-read-dom-geometry",
		geometry.reads.length === 0 && geometry.modeledSnapshots > 20,
		geometry,
	);
	await check(
		page,
		"all-18-paths-and-no-browser-exceptions",
		matrix.length === 18 && errors.length === 0,
		{ paths: matrix.length, errors, failedRequests },
	);
} catch (error) {
	errors.push(String(error).slice(0, 3_000));
	checks.push({
		name: "runner-completed-within-budget",
		pass: false,
		detail: String(error).slice(0, 3_000),
	});
	console.error(`FATAL ${String(error).slice(0, 3_000)}`);
	process.exitCode = 1;
} finally {
	clearTimeout(deadline);
	const version = browser ? await browser.version().catch(() => "closed") : "not launched";
	await browser?.close().catch(() => {});
	server?.stop(true);
	const result = {
		browser: version,
		checkedAt: new Date().toISOString(),
		timedOut,
		bundleBytes,
		checks,
		matrix,
		errors,
		failedRequests,
		cleanup: { browserClosed: !browser?.connected, serverStopped: true },
		limits: {
			timeoutMs: TIMEOUT,
			maxBundleBytes: 64 * 1024 * 1024,
			maxReportBytes: MAX_REPORT_BYTES,
			maxScreenshots: 32,
		},
	};
	let json = JSON.stringify(result, null, 2);
	if (Buffer.byteLength(json) > MAX_REPORT_BYTES) {
		checks.push({ name: "bounded-report-size", pass: false, detail: "Evidence budget exceeded" });
		json = JSON.stringify({
			...result,
			matrix: [],
			checks: checks.map(({ name, pass }) => ({ name, pass })),
			evidenceOmitted: true,
		});
	}
	await Bun.write(join(reportDir, "results.json"), json);
	const failures = checks.filter((value) => !value.pass).length;
	if (failures || timedOut) process.exitCode = timedOut ? 2 : 1;
	console.log(
		`SUMMARY ${checks.length - failures} pass / ${failures} fail; ${matrix.length}/18 paths; ${reportDir}/results.json`,
	);
}
