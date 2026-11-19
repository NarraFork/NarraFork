import { afterAll, beforeAll, expect, test } from "bun:test";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type * as Fixture from "./agent-reference.browser-fixture";

type FixtureWindow = Window & { fixture: typeof Fixture };
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
	const executablePath = process.env.NF_TEST_CHROMIUM_PATH;
	if (!executablePath) throw new Error("需要通过 NF_TEST_CHROMIUM_PATH 指定可启动的 Chromium");
	const bundle = await Bun.build({
		entrypoints: [fileURLToPath(new URL("./agent-reference.browser-fixture.tsx", import.meta.url))],
		target: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
	const script = [...assets.keys()].find((path) => path.endsWith(".js"));
	const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
	if (!script || !styles.length) throw new Error("夹具没有生成脚本或生产 CSS");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 10,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/") {
				return new Response(
					`<!doctype html><html><head><meta charset="utf-8">
					<meta name="viewport" content="width=device-width, initial-scale=1">
					${styles.map((style) => `<link rel="stylesheet" href="${style}">`).join("")}
					</head><body><div id="root"></div><script type="module">
					import * as fixture from ${JSON.stringify(script)}; window.fixture = fixture;
					</script></body></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			}
			const asset = assets.get(path);
			return asset ? new Response(asset) : new Response("Not found", { status: 404 });
		},
	});
	browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		timeout: 10_000,
		protocolTimeout: 10_000,
	});
}, 30_000);

afterAll(async () => {
	try {
		await browser?.close();
	} finally {
		server?.stop(true);
	}
});

const state = (page: Page) =>
	page.evaluate(() => (window as unknown as FixtureWindow).fixture.snapshot());
const settle = (page: Page) =>
	page.evaluate(async () => {
		for (let i = 0; i < 6; i++)
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});

async function withFixture(run: (page: Page) => Promise<void>, width = 1400) {
	if (!browser || !server) throw new Error("浏览器夹具未初始化");
	const page = await browser.newPage();
	const errors: string[] = [];
	const backendRequests: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	page.on("request", (request) => {
		if (/\/(api|ws)\//.test(request.url())) backendRequests.push(request.url());
	});
	page.setDefaultTimeout(5_000);
	try {
		await page.setViewport({ width, height: 1000 });
		await page.goto(server.url.href, { timeout: 10_000 });
		await page.waitForFunction(
			() => (window as unknown as FixtureWindow).fixture?.snapshot().ready,
		);
		await settle(page);
		await run(page);
		expect(errors).toEqual([]);
		expect(backendRequests).toEqual([]);
	} finally {
		await page.close();
	}
}

async function render(page: Page, options: Parameters<typeof Fixture.render>[0]) {
	await page.evaluate(
		(options) => (window as unknown as FixtureWindow).fixture.render(options),
		options,
	);
	await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.snapshot().ready);
	await settle(page);
}

/** DOM line boxes + Canvas horizontal ink, clipped ONLY by authored overflow, not the test box. */
const geometry = (page: Page) =>
	page.evaluate(() => {
		const metadata = (window as unknown as FixtureWindow).fixture.snapshot();
		const inkContext = document.createElement("canvas").getContext("2d");
		if (!inkContext) throw new Error("缺少 Canvas 字体墨迹测量");
		const probe = document.body.appendChild(document.createElement("span"));
		probe.style.color = "var(--mantine-color-anchor)";
		probe.style.borderRadius = "var(--mantine-radius-sm)";
		const anchorColor = getComputedStyle(probe).color;
		const referenceRadius = getComputedStyle(probe).borderRadius;
		probe.remove();
		const rect = (box: DOMRect) => ({ x: box.x, y: box.y, width: box.width, height: box.height });
		type Box = ReturnType<typeof rect>;
		const intersect = (a: Box, b: Box, x = true, y = true): Box => {
			const left = x ? Math.max(a.x, b.x) : a.x;
			const top = y ? Math.max(a.y, b.y) : a.y;
			return {
				x: left,
				y: top,
				width: Math.max(0, (x ? Math.min(a.x + a.width, b.x + b.width) : a.x + a.width) - left),
				height: Math.max(0, (y ? Math.min(a.y + a.height, b.y + b.height) : a.y + a.height) - top),
			};
		};
		return [...document.querySelectorAll<HTMLElement>("[data-case]")].map((sample) => {
			const bounds = sample.getBoundingClientRect();
			const local = (box: Box) => ({ ...box, x: box.x - bounds.x, y: box.y - bounds.y });
			const clipped = (box: Box, parent: Element | null) => {
				let visible = box;
				for (
					let ancestor = parent;
					ancestor && ancestor !== sample;
					ancestor = ancestor.parentElement
				) {
					const css = getComputedStyle(ancestor);
					visible = intersect(
						visible,
						rect(ancestor.getBoundingClientRect()),
						/hidden|clip|auto|scroll/.test(css.overflowX),
						/hidden|clip|auto|scroll/.test(css.overflowY),
					);
				}
				return local(visible);
			};
			const outsideBounds = (box: Box) =>
				box.x < -1 / 64 ||
				box.x + box.width > bounds.width + 1 / 64 ||
				box.y < -1 / 64 ||
				box.y + box.height > bounds.height + 1 / 64;
			const glyphs: Array<Box & { text: string }> = [];
			const inkGlyphs: Array<Box & { text: string }> = [];
			const overflowGlyphs: Array<Box & { text: string }> = [];
			const markerGlyphs: Array<Box & { text: string }> = [];
			const labelTops: number[] = [];
			const after: Box[] = [];
			const walker = document.createTreeWalker(sample, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (node.parentElement?.closest("[data-agent-status]")) continue;
				const text = node.textContent ?? "";
				const css = getComputedStyle(node.parentElement ?? sample);
				inkContext.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
				const afterIndex = text.indexOf(metadata.afterText);
				if (afterIndex >= 0) {
					const range = document.createRange();
					range.setStart(node, afterIndex);
					range.setEnd(node, afterIndex + metadata.afterText.length);
					after.push(local(rect(range.getBoundingClientRect())));
				}
				for (let i = 0; i < text.length; i++) {
					if (!text[i]?.trim()) continue;
					const range = document.createRange();
					range.setStart(node, i);
					range.setEnd(node, i + 1);
					const box = range.getBoundingClientRect();
					if (node.parentElement?.closest("[data-agent-label]")) labelTops.push(box.y);
					const visible = clipped(rect(box), node.parentElement);
					const isMarker = !!node.parentElement?.closest(".vlist-marker");
					if (visible.width && visible.height) {
						const target = isMarker ? markerGlyphs : glyphs;
						target.push({ text: text[i] ?? "", ...visible });
					}
					// These fixtures are horizontal LTR. Range locates each glyph but its width is
					// an advance/selection box, NOT ink (notably 。 with negative letter-spacing).
					// Keep DOM vertical line bounds and the original logical geometry; horizontal
					// paint uses this font's real bearings, without adding/removing spacing again.
					const ink = inkContext.measureText(text[i] ?? "");
					const rawInk = {
						x: box.x - ink.actualBoundingBoxLeft,
						y: box.y,
						width: ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight,
						height: box.height,
					};
					const painted = clipped(rawInk, node.parentElement);
					if (!isMarker && painted.width && painted.height)
						inkGlyphs.push({ text: text[i] ?? "", ...painted });
					// Retain the existing Range candidate oracle and all logical comparisons.
					// Before calling an outlying selection box "painted outside", confirm its
					// ink: negative spacing plus a font's side bearings can leave empty advance
					// beyond the edge. Generic font optical overhang is not a chip regression.
					const overflow = outsideBounds(visible) ? painted : visible;
					if (!isMarker && overflow.width && overflow.height)
						overflowGlyphs.push({ text: text[i] ?? "", ...overflow });
				}
			}
			const references = [...sample.querySelectorAll<HTMLElement>("[data-agent-reference]")].map(
				(root) => {
					const label = root.querySelector<HTMLElement>("[data-agent-label]");
					const marker = root.querySelector<HTMLElement>("[data-agent-status]");
					if (!label || !marker) throw new Error("胶囊缺少单个 label/status");
					const css = getComputedStyle(root);
					const labelCss = getComputedStyle(label);
					const labelRange = document.createRange();
					labelRange.selectNodeContents(label);
					const backgrounds = [root, ...root.querySelectorAll<HTMLElement>("*")].filter((node) => {
						// State icons can have their own tiny semantic badges, not extra capsule chrome.
						if (node.closest("[data-agent-status]")) return false;
						const style = getComputedStyle(node);
						return style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none";
					});
					return {
						bounds: local(rect(root.getBoundingClientRect())),
						label: local(rect(label.getBoundingClientRect())),
						status: local(rect(marker.getBoundingClientRect())),
						icons: [...marker.querySelectorAll("svg")].map((svg) => ({
							raw: local(rect(svg.getBoundingClientRect())),
							visible: clipped(rect(svg.getBoundingClientRect()), svg.parentElement),
						})),
						text: label.textContent,
						title: root.title,
						statusLabel: marker.getAttribute("aria-label"),
						statusRole: marker.getAttribute("role"),
						state: root.dataset.agentState,
						clickTargets:
							Number(root.tagName === "A") + root.querySelectorAll("a,button,[role=link]").length,
						rootRects: root.getClientRects().length,
						labelCount: root.querySelectorAll("[data-agent-label]").length,
						statusCount: root.querySelectorAll("[data-agent-status]").length,
						labelTextLines: new Set([...labelRange.getClientRects()].map((box) => box.y)).size,
						anchorColor,
						referenceRadius,
						rootOverflow: css.overflowX,
						backgrounds: backgrounds.length,
						backgroundIsRoot: backgrounds[0] === root,
						borderRadius: css.borderRadius,
						boxSizing: css.boxSizing,
						paddingX: css.paddingLeft,
						marginLeft: Number.parseFloat(css.marginLeft),
						marginRight: Number.parseFloat(css.marginRight),
						height: css.height,
						// Same font metrics across hosts; each host deliberately owns its line-height.
						font: [css.fontFamily, css.fontSize, css.fontWeight, css.fontStyle].join("|"),
						color: css.color,
						labelColor: labelCss.color,
						ellipsis: labelCss.textOverflow,
						whiteSpace: labelCss.whiteSpace,
						overflow: labelCss.overflowX,
						truncated: label.scrollWidth > label.clientWidth,
						nestedMarkdown: root.querySelectorAll("strong,em,code,.is-strong,.vlist-frag--code")
							.length,
					};
				},
			);
			const icons = references.flatMap((reference) => reference.icons.map((icon) => icon.visible));
			const overlaps = icons.flatMap((icon) =>
				glyphs.filter(
					(glyph) =>
						Math.min(icon.x + icon.width, glyph.x + glyph.width) - Math.max(icon.x, glyph.x) >
							1 / 64 &&
						Math.min(icon.y + icon.height, glyph.y + glyph.height) - Math.max(icon.y, glyph.y) >
							1 / 64,
				),
			);
			const outside = [
				...overflowGlyphs,
				...icons,
				...references.map((reference) => reference.bounds),
			].filter((box) => box.width > 0 && box.height > 0 && outsideBounds(box));
			return {
				name: sample.dataset.case ?? "",
				expectedReferences: Number(sample.dataset.referenceCount),
				measuredHeight: sample.dataset.measuredHeight
					? Number(sample.dataset.measuredHeight)
					: null,
				references,
				labelLineSpread: labelTops.length ? Math.max(...labelTops) - Math.min(...labelTops) : 0,
				layout: {
					bounds: { width: bounds.width, height: bounds.height },
					glyphs,
					markerGlyphs,
					atoms: references.map(({ bounds, label, status }) => ({ bounds, label, status })),
					after,
				},
				inkGlyphs,
				overlaps,
				outside,
			};
		});
	});

/** Independent raster check: only the test punctuation is magenta; no DOM/Canvas text metrics. */
async function punctuationPaint(page: Page) {
	const clip = await page.$eval('[data-case="prepared-public"]', (sample) => {
		sample.scrollIntoView({ block: "center", inline: "center" });
		const box = sample.getBoundingClientRect();
		const x = Math.floor(box.x);
		const y = Math.floor(box.y);
		return {
			x,
			y,
			width: Math.ceil(box.right + 16) - x,
			height: Math.ceil(box.bottom) - y,
			right: box.right,
		};
	});
	const png = await page.screenshot({
		encoding: "base64",
		clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
	});
	return page.evaluate(
		async ({ png, clip }) => {
			const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
			const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("无法读取 Chrome 截图像素");
			context.drawImage(bitmap, 0, 0);
			bitmap.close();
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			let inside = 0;
			let outside = 0;
			for (let index = 0; index < data.length; index += 4) {
				const [red = 0, green = 0, blue = 0] = data.subarray(index, index + 3);
				if (red <= green + 40 || blue <= green + 40) continue;
				const x = clip.x + ((index / 4) % canvas.width) * (clip.width / canvas.width);
				if (x >= clip.right) outside++;
				else inside++;
			}
			return { inside, outside };
		},
		{ png, clip },
	);
}

function assertLayout(
	samples: Awaited<ReturnType<typeof geometry>>,
	metadata: Awaited<ReturnType<typeof state>>,
) {
	const issues: string[] = [];
	for (const sample of samples) {
		const message = sample.name;
		expect(sample.references, message).toHaveLength(sample.expectedReferences);
		expect(sample.layout.after, message).toHaveLength(1);
		if (sample.measuredHeight !== null)
			expect(
				Math.abs(sample.layout.bounds.height - sample.measuredHeight),
				`${message}: Chrome 1/64 CSS px quantization`,
			).toBeLessThanOrEqual(1 / 64);
		for (const reference of sample.references) {
			expect(reference.clickTargets, message).toBe(sample.name.endsWith("public") ? 0 : 1);
			expect(reference.rootRects, message).toBe(1);
			expect(reference.labelCount, message).toBe(1);
			expect(reference.statusCount, message).toBe(1);
			expect(reference.labelTextLines, message).toBe(1);
			expect(reference.font, message).toBe(samples[0]?.references[0]?.font);
			if (reference.clickTargets === 1) {
				expect(reference.color, message).toBe(reference.anchorColor);
				expect(reference.labelColor, message).toBe(reference.anchorColor);
			}
			expect(reference.backgrounds, message).toBe(1);
			expect(reference.backgroundIsRoot, message).toBe(true);
			expect(reference.nestedMarkdown, message).toBe(0);
			expect(reference.statusRole, message).toBe("img");
			expect(reference.borderRadius, message).toBe(reference.referenceRadius);
			expect(reference.boxSizing, message).toBe("border-box");
			expect(reference.paddingX, message).toBe("6px");
			expect(
				Math.abs(reference.bounds.height - metadata.metrics.height),
				message,
			).toBeLessThanOrEqual(1 / 64);
			if (reference.bounds.width > Math.min(240, sample.layout.bounds.width) + 1 / 64)
				issues.push(
					`${message}: 胶囊宽 ${reference.bounds.width}px 超出 ${sample.layout.bounds.width}px 测量框`,
				);
			expect(reference.status.width, message).toBe(18);
			expect(reference.ellipsis, message).toBe("ellipsis");
			expect(reference.whiteSpace, message).toBe("nowrap");
			expect(reference.overflow, message).toBe("hidden");
			expect(reference.title, message).toBe(`${reference.text} · ${reference.statusLabel}`);
			expect(reference.icons.length, message).toBeGreaterThanOrEqual(1);
			expect(reference.icons[0]?.raw.width, message).toBe(14);
			for (const { raw, visible } of reference.icons) {
				// Very narrow nested columns may clip the fixed icon. Verify the real overflow clip,
				// while never pretending its unclipped DOM rectangle shrank.
				expect(visible.x, message).toBeGreaterThanOrEqual(reference.bounds.x);
				expect(visible.x + visible.width, message).toBeLessThanOrEqual(
					reference.bounds.x + reference.bounds.width + 1 / 64,
				);
				expect(raw.width, message).toBeLessThanOrEqual(14);
			}
			if (/-(long|list|table|heading)$/.test(sample.name)) {
				expect(reference.text, message).toBe(metadata.longTitle);
				expect(reference.truncated, message).toBe(true);
			}
		}
		if (sample.name === "flow-list" || sample.name === "prepared-list") {
			const control = samples.find(
				(candidate) => candidate.name === sample.name.replace("-list", "-control-list"),
			);
			if (!control) throw new Error("缺少无引用列表对照");
			// Existing optical bullet font boxes protrude by 1–2px. Keep their exact geometry
			// pinned to a no-reference control; no capsule/title/post-text paint is exempted.
			expect(sample.layout.markerGlyphs, `${message}: 无引用列表标记对照`).toEqual(
				control.layout.markerGlyphs,
			);
		}
		if (sample.name.endsWith("adjacent")) {
			const [first, second] = sample.references;
			if (first && second && first.bounds.y === second.bounds.y) {
				const gap = second.bounds.x - (first.bounds.x + first.bounds.width);
				expect(
					Math.abs(gap - metadata.metrics.marginX * 2),
					`${message}: 相邻chip留白`,
				).toBeLessThanOrEqual(1 / 64);
				expect(gap, message).toBeGreaterThanOrEqual(4 - 1 / 64);
			}
		}
		if (sample.name.endsWith("long")) expect(sample.labelLineSpread, message).toBe(0);
		if (sample.overlaps.length)
			issues.push(`${message}: icon/text overlap ${JSON.stringify(sample.overlaps[0])}`);
		if (sample.outside.length)
			issues.push(
				`${message}: painted outside measured box ${JSON.stringify(sample.outside[0])}; height=${sample.layout.bounds.height}`,
			);
		const lastAtomBottom = Math.max(
			...sample.references.map(({ bounds }) => bounds.y + bounds.height),
		);
		if ((sample.layout.after[0]?.y ?? 0) < lastAtomBottom)
			issues.push(`${message}: 后续段落覆盖胶囊`);
	}
	for (const kind of ["long", "adjacent"]) {
		const flow = samples.find((sample) => sample.name === `flow-${kind}`);
		const prepared = samples.find((sample) => sample.name === `prepared-${kind}`);
		if (!flow || !prepared) throw new Error(`缺少 ${kind} 对照`);
		for (let index = 0; index < flow.references.length; index++) {
			const actual = flow.references[index]?.bounds.width ?? 0;
			const predicted = prepared.references[index]?.bounds.width ?? 0;
			if (Math.abs(actual - predicted) > 1 / 64)
				issues.push(`${kind}[${index}]: flow/prepared 原子宽度 ${actual}/${predicted}px 不一致`);
		}
		const flowControl = samples.find((sample) => sample.name === "flow-control-paragraph");
		const preparedControl = samples.find((sample) => sample.name === "prepared-control-paragraph");
		if (!flowControl || !preparedControl) throw new Error("缺少无引用段落对照");
		// The generic flow p margin is .35em; prepared uses 4.9px. Subtract ONLY the
		// independently observed no-reference baseline, not any capsule-specific error.
		const heightDelta = flow.layout.bounds.height - prepared.layout.bounds.height;
		const heightBaseline = flowControl.layout.bounds.height - preparedControl.layout.bounds.height;
		const afterDelta = (flow.layout.after[0]?.y ?? 0) - (prepared.layout.after[0]?.y ?? 0);
		const afterBaseline =
			(flowControl.layout.after[0]?.y ?? 0) - (preparedControl.layout.after[0]?.y ?? 0);
		if (
			Math.abs(heightDelta - heightBaseline) > 1 / 64 ||
			Math.abs(afterDelta - afterBaseline) > 1 / 64
		)
			issues.push(
				`${kind}: 胶囊新增 height Δ=${heightDelta - heightBaseline}, following paragraph Δ=${afterDelta - afterBaseline}; 通用段落基线=${heightBaseline}/${afterBaseline}`,
			);
	}
	return issues;
}

test("预排版同行文字：chip按字体行框居中，标题与正文基线重合", async () => {
	await withFixture(async (page) => {
		const issues: string[] = [];
		for (const [fontScalePercent, lineHeightScalePercent] of [
			[100, 100],
			[70, 70],
			[135, 100],
			[100, 70],
		]) {
			await render(page, { width: 270, fontScalePercent, lineHeightScalePercent });
			const boxes = await page.evaluate(() => {
				return [...document.querySelectorAll<HTMLElement>("[data-case='prepared-alignment']")].map(
					(sample) => {
						const chip = sample.querySelector<HTMLElement>("[data-agent-reference]");
						const label = sample.querySelector<HTMLElement>("[data-agent-label]");
						if (!chip || !label) throw new Error("缺少同行对照引用");
						const walker = document.createTreeWalker(sample, NodeFilter.SHOW_TEXT);
						let normal: Range | undefined;
						for (let node = walker.nextNode(); node; node = walker.nextNode()) {
							const at = node.textContent?.indexOf("对齐") ?? -1;
							if (at < 0 || node.parentElement?.closest("[data-agent-reference]")) continue;
							normal = document.createRange();
							normal.setStart(node, at);
							normal.setEnd(node, at + 2);
							break;
						}
						const peer = normal?.startContainer.parentElement?.closest(".vlist-frag");
						if (!normal || !peer) throw new Error("缺少同行普通字体片段");
						const title = document.createRange();
						title.selectNodeContents(label);
						const body = normal.getBoundingClientRect();
						const text = title.getBoundingClientRect();
						const frame = chip.getBoundingClientRect();
						const fontBox = peer.getBoundingClientRect();
						return {
							name: sample.dataset.case,
							bodyCenter: body.y + body.height / 2,
							textCenter: text.y + text.height / 2,
							fontBoxCenter: fontBox.y + fontBox.height / 2,
							chipCenter: frame.y + frame.height / 2,
						};
					},
				);
			});
			expect(boxes).toHaveLength(1);
			for (const box of boxes) {
				// Outer chrome aligns with the peer's font line box (including its leading).
				// Independently compare identical glyphs: same baseline, not merely centered boxes.
				const labelDelta = box.textCenter - box.bodyCenter;
				const chipDelta = box.chipCenter - box.fontBoxCenter;
				if (Math.abs(labelDelta) > 1 / 64 || Math.abs(chipDelta) > 1 / 64)
					issues.push(
						`${fontScalePercent}/${lineHeightScalePercent}/${box.name}: 标题基线偏移${labelDelta}, 外框中心偏移${chipDelta}`,
					);
			}
		}
		expect(issues).toEqual([]);
	});
}, 30_000);

test("完整胶囊：深浅主题、静态/流式均为单背景单目标蓝色纯文本；正文富文本仍格式化", async () => {
	await withFixture(async (page) => {
		const issues: string[] = [];
		for (const scheme of ["dark", "light"] as const) {
			for (const streaming of [false, true]) {
				await render(page, { scheme, streaming, width: 270 });
				issues.push(...assertLayout(await geometry(page), await state(page)));
				const colors = await page.evaluate(() => {
					const probe = document.body.appendChild(document.createElement("span"));
					probe.style.color = "var(--mantine-color-anchor)";
					const expected = getComputedStyle(probe).color;
					probe.remove();
					return {
						expected,
						labels: [
							...document.querySelectorAll("a[data-agent-reference] [data-agent-label]"),
						].map((label) => getComputedStyle(label).color),
						rich: [...document.querySelectorAll("[data-case$='-rich']")].map((sample) => ({
							bold: [...sample.querySelectorAll("strong,.is-strong")].some(
								(node) =>
									node.textContent === "普通正文粗体" &&
									getComputedStyle(node).fontWeight === "700",
							),
							code: [...sample.querySelectorAll("code,.vlist-frag--code")].some(
								(node) =>
									node.textContent === "outsideCode" &&
									getComputedStyle(node).fontFamily.includes("monospace"),
							),
						})),
					};
				});
				expect(colors.labels.length).toBeGreaterThan(10);
				for (const color of colors.labels)
					expect(color, `${scheme}/${streaming}`).toBe(colors.expected);
				expect(colors.rich).toEqual([
					{ bold: true, code: true },
					{ bold: true, code: true },
				]);
			}
		}
		const client = await page.createCDPSession();
		const accessibility = await client.send("Accessibility.getFullAXTree");
		await client.detach();
		const fullTitle = (await state(page)).longTitle;
		expect(
			accessibility.nodes.filter(
				(node) =>
					node.role?.value === "link" &&
					typeof node.name?.value === "string" &&
					node.name.value.includes(fullTitle),
			),
		).toHaveLength(8);
		expect([...new Set(issues)]).toEqual([]);
	});
}, 30_000);

for (const width of [90, 180, 270]) {
	test(`真实 ${width}px：正文、嵌套列表、表格、标题不溢出，状态/主题不改变几何`, async () => {
		await withFixture(
			async (page) => {
				const issues: string[] = [];
				for (const streaming of [false, true]) {
					await render(page, { width, streaming, scheme: "dark" });
					const before = await geometry(page);
					issues.push(...assertLayout(before, await state(page)));
					expect((await state(page)).subscriptions).toEqual([
						{ ids: ["Child_A"], kind: "activity" },
					]);
					for (const sample of before)
						for (const reference of sample.references)
							expect(reference.statusLabel).toBe("子代理状态未知");
					for (const [status, substatus, label] of [
						["working", [], "工作中"],
						["idle", [], "空闲"],
						["waiting", [], "等待中"],
						["idle", ["error"], "错误"],
						["working", ["reasoning"], "推理中"],
					] as const) {
						await page.evaluate(
							({ status, substatus }) =>
								(window as unknown as FixtureWindow).fixture.status(
									status,
									[...substatus],
									status === "working",
								),
							{ status, substatus },
						);
						await settle(page);
						const after = await geometry(page);
						issues.push(...assertLayout(after, await state(page)));
						const active = after.filter((sample) => !sample.name.endsWith("public"));
						const expectedStatuses = active.reduce(
							(sum, sample) => sum + sample.expectedReferences,
							0,
						);
						// Inspect Chrome's actual accessibility tree, not just authored ARIA attributes.
						expect(
							await page.$$eval(
								`aria/${label}`,
								(nodes) => nodes.filter((node) => node.hasAttribute("data-agent-status")).length,
							),
						).toBe(expectedStatuses);
						expect(
							after.map((sample) => sample.layout),
							`${status}/${substatus}`,
						).toEqual(before.map((sample) => sample.layout));
						for (const sample of active)
							for (const reference of sample.references) {
								expect(reference.statusLabel).toBe(label);
								expect(reference.state).toBe(status);
							}
					}
					await render(page, { width, streaming, scheme: "light" });
					expect(
						(await geometry(page)).map((sample) => sample.layout),
						"深浅主题几何一致",
					).toEqual(before.map((sample) => sample.layout));
				}
				expect([...new Set(issues)]).toEqual([]);
			},
			width < 270 ? 390 : 1400,
		);
	}, 30_000);
}

test("放大字体与正负字距：100%/135% 正文和预排版保留同一原子尺寸与后文位置", async () => {
	await withFixture(async (page) => {
		const issues: string[] = [];
		for (const [fontScalePercent, letterSpacingPercent] of [
			[100, 0],
			[135, 8],
			[135, -3],
		])
			for (const width of [90, 180, 270]) {
				await render(page, { width, fontScalePercent, letterSpacingPercent });
				issues.push(
					...assertLayout(await geometry(page), await state(page)).map(
						(issue) => `${fontScalePercent}%/${letterSpacingPercent}%/${width}px: ${issue}`,
					),
				);
			}
		expect([...new Set(issues)]).toEqual([]);
	});
}, 30_000);

test("负字距末尾句号：区分逻辑框与 ink，并检测真实绘制越界和 overflow 裁切", async () => {
	await withFixture(async (page) => {
		await render(page, { width: 270, fontScalePercent: 135, letterSpacingPercent: -3 });
		await page.evaluate(() => {
			const sample = document.querySelector('[data-case="prepared-public"]');
			const fragment = [...(sample?.querySelectorAll(".vlist-frag--body") ?? [])].find((node) =>
				node.textContent?.includes("。"),
			);
			const text = fragment?.firstChild;
			if (!sample || !text || text.nodeType !== Node.TEXT_NODE)
				throw new Error("缺少公开引用后文的句号");
			const index = text.textContent?.indexOf("。") ?? -1;
			const range = document.createRange();
			range.setStart(text, index);
			range.setEnd(text, index + 1);
			const punctuation = document.createElement("span");
			punctuation.dataset.inkProbe = "";
			punctuation.style.cssText = "position:relative;color:rgb(255,0,255)";
			range.surroundContents(punctuation);
			// Reproduce the CI edge precisely with the actual installed font, not a pinned
			// font or wider tolerance: logical right=270.453125px while ink still fits.
			punctuation.style.left = `${sample.getBoundingClientRect().right - range.getBoundingClientRect().right + 0.453125}px`;
		});
		const safe = await geometry(page);
		const publicSample = safe.find((sample) => sample.name === "prepared-public");
		if (!publicSample) throw new Error("缺少公开引用样本");
		const logicalRight = Math.max(
			...publicSample.layout.glyphs.map((glyph) => glyph.x + glyph.width),
		);
		expect(Math.abs(logicalRight - 270.453125)).toBeLessThanOrEqual(1 / 64);
		const ink = publicSample.inkGlyphs.find((glyph) => glyph.text === "。" && glyph.x > 240);
		if (!ink) throw new Error("缺少靠边句号 ink");
		expect(ink.x + ink.width).toBeLessThanOrEqual(270);
		expect(assertLayout(safe, await state(page))).toEqual([]);
		const safePaint = await punctuationPaint(page);
		expect(safePaint.inside).toBeGreaterThan(0);
		expect(safePaint.outside).toBe(0);

		// Move half the real ink beyond the box. This must fail the same production
		// layout assertion, and the independent Chrome raster must show outside pixels.
		await page.$eval(
			"[data-ink-probe]",
			(punctuation, delta) => {
				const element = punctuation as HTMLElement;
				element.style.left = `${Number.parseFloat(element.style.left) + delta}px`;
			},
			270 - ink.x - ink.width / 2,
		);
		const overflowing = await geometry(page);
		expect(assertLayout(overflowing, await state(page))).toContainEqual(
			expect.stringContaining("prepared-public: painted outside measured box"),
		);
		expect((await punctuationPaint(page)).outside).toBeGreaterThan(0);

		const clipBox = await page.$eval("[data-ink-probe]", (punctuation) => {
			const line = punctuation.closest<HTMLElement>("[data-vlist-line]");
			const sample = punctuation.closest<HTMLElement>("[data-case]");
			if (!line || !sample) throw new Error("缺少实际绘制行或裁切边界");
			const column = sample.getBoundingClientRect();
			// Reproduce the inherited max-content floor independently of installed fonts.
			line.style.minWidth = `${column.width + 16}px`;
			const expandedWidth = line.getBoundingClientRect().width;
			// This is an authored clipping control, not a production layout change.
			// Width alone cannot override min-width:max-content on the normal copy-safe line.
			line.style.minWidth = "0";
			line.style.width = `${column.width}px`;
			line.style.overflow = "hidden";
			const actual = line.getBoundingClientRect();
			return {
				expandedWidth,
				columnWidth: column.width,
				actualWidth: actual.width,
				leftDelta: actual.left - column.left,
				rightDelta: actual.right - column.right,
			};
		});
		expect(clipBox.expandedWidth).toBeGreaterThan(clipBox.columnWidth);
		expect(Math.abs(clipBox.actualWidth - clipBox.columnWidth)).toBeLessThanOrEqual(1 / 64);
		expect(Math.abs(clipBox.leftDelta)).toBeLessThanOrEqual(1 / 64);
		expect(Math.abs(clipBox.rightDelta)).toBeLessThanOrEqual(1 / 64);
		const clipped = await geometry(page);
		expect(assertLayout(clipped, await state(page))).toEqual([]);
		const clippedInk = clipped
			.find((sample) => sample.name === "prepared-public")
			?.inkGlyphs.find((glyph) => glyph.text === "。" && glyph.x > 240);
		if (!clippedInk) throw new Error("句号应保留未裁切的半边 ink");
		expect(clippedInk.width).toBeLessThan(ink.width);
		expect(clippedInk.x + clippedInk.width).toBeLessThanOrEqual(270);
		const clippedPaint = await punctuationPaint(page);
		expect(clippedPaint.inside).toBeGreaterThan(0);
		expect(clippedPaint.outside).toBe(0);
	});
}, 15_000);

test("极窄 8/16px：固定图标确实被胶囊裁切，而不是用未裁切 DOM 矩形假装不溢出", async () => {
	await withFixture(async (page) => {
		for (const width of [8, 16]) {
			await render(page, { width });
			for (const sample of (await geometry(page)).filter((sample) =>
				sample.name.endsWith("long"),
			)) {
				expect(sample.references).toHaveLength(1);
				const reference = sample.references[0];
				if (!reference) throw new Error("缺少极窄胶囊");
				expect(reference.marginLeft).toBe(2);
				expect(reference.marginRight).toBe(2);
				expect(reference.bounds.width + reference.marginLeft + reference.marginRight).toBe(width);
				expect(reference.rootOverflow).toBe("hidden");
				const icon = reference.icons[0];
				if (!icon) throw new Error("缺少极窄状态图标");
				expect(icon.raw.width).toBe(14);
				expect(icon.raw.x + icon.raw.width).toBeGreaterThan(
					reference.bounds.x + reference.bounds.width,
				);
				expect(icon.visible.width).toBeLessThan(icon.raw.width);
				expect(icon.visible.x + icon.visible.width).toBeLessThanOrEqual(
					reference.bounds.x + reference.bounds.width,
				);
			}
		}
	});
}, 15_000);

test("权限拒绝：胶囊降为只读且不泄露状态、不改变布局；公开引用不订阅", async () => {
	await withFixture(async (page) => {
		const before = await geometry(page);
		expect((await state(page)).subscriptions).toEqual([{ ids: ["Child_A"], kind: "activity" }]);
		await page.evaluate(() => (window as unknown as FixtureWindow).fixture.denied());
		await settle(page);
		const after = await geometry(page);
		expect(after.map((sample) => sample.layout)).toEqual(before.map((sample) => sample.layout));
		for (const sample of after)
			for (const reference of sample.references) {
				expect(reference.clickTargets).toBe(0);
				expect(reference.statusLabel).toBe(
					sample.name.endsWith("public") ? "子代理状态未知" : "子代理不存在或无权访问",
				);
				expect(reference.title).toBe(`${reference.text} · ${reference.statusLabel}`);
			}
	});
}, 15_000);

test("真实桌面 host：右侧 Dock 打开与重复点击去重，保存无测试框线的实际胶囊截图", async () => {
	await withFixture(async (page) => {
		await page.setViewport({ width: 1600, height: 620 });
		await render(page, { dock: true, gallery: true, width: 300 });
		await page.click('[data-case="flow-long"] a[data-agent-reference]');
		await page.waitForSelector('[data-child-panel="Child_A"]');
		await settle(page);
		const first = await state(page);
		expect(first.opened).toEqual(["Child_A"]);
		expect(first.panels).toHaveLength(2);
		expect(first.child?.x).toBeGreaterThanOrEqual((first.chat?.x ?? 0) + (first.chat?.width ?? 0));
		expect(first.child?.width).toBeGreaterThan(300);
		expect(first.panels?.find((panel) => panel.id === first.childPanelId)?.params).toEqual({
			panelType: "subagent",
			subagentNarratorId: "Child_A",
		});
		await page.click('[data-case="prepared-long"] a[data-agent-reference]');
		await page.click('[data-case="flow-long"] a[data-agent-reference]');
		await settle(page);
		const repeated = await state(page);
		expect(repeated.opened).toEqual(["Child_A", "Child_A", "Child_A"]);
		expect(repeated.panels).toHaveLength(2);
		expect(repeated.child).toEqual(first.child);
		expect(repeated.pathname).toBe("/");
		await page.evaluate(() =>
			(window as unknown as FixtureWindow).fixture.status("working", ["reasoning"], true),
		);
		await page.mouse.move(1500, 900);
		await settle(page);
		await page.screenshot({
			path: fileURLToPath(
				new URL("../../../../.narrafork/子代理引用-统一胶囊.png", import.meta.url),
			),
		});
	}, 1600);
}, 15_000);

test("真实 390px host：flow/prepared 都经产品 opener 路由至目标会话且页面不横向溢出", async () => {
	await withFixture(async (page) => {
		for (const renderer of ["flow", "prepared"]) {
			await render(page, { dock: false, width: 180 });
			await page.click(`[data-case="${renderer}-long"] a[data-agent-reference]`);
			await page.waitForFunction(
				() =>
					(window as unknown as FixtureWindow).fixture.snapshot().pathname === "/narrators/Child_A",
			);
			expect((await state(page)).opened).toEqual(["Child_A"]);
			expect(await page.$('[data-route-target="Child_A"]')).not.toBeNull();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				390,
			);
		}
	}, 390);
}, 15_000);
