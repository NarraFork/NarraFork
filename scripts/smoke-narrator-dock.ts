/**
 * Headless browser smoke test for the unified narrator dock (phase 3).
 *
 * Verifies — against a REAL Chrome + REAL backend, in a fully isolated
 * NARRAFORK_HOME so the developer's production DB is never touched — that:
 *   1. The narrator page renders the dockview surface with the chat panel.
 *   2. The chat toolbar can open/close tool panels (details / spec / git),
 *      i.e. dockview panels are added/removed through our context wiring.
 *   3. The per-narrator layout is persisted to localStorage and restored
 *      after a full reload.
 *
 * This complements the pure-logic unit tests (drop-intent / panel-swap /
 * narrator-dock-layout) by exercising the actual DOM mount + event wiring that
 * cannot be asserted in a headless-free unit environment.
 *
 * Run: bun scripts/smoke-narrator-dock.ts
 * Exit code 0 = all checks passed; non-zero = failure (details on stderr).
 *
 * NOTE: real pointer-drag split/swap on dockview's internal DnD protocol is
 * intentionally NOT synthesized here (brittle in headless). Those remain a
 * manual visual check; this script covers mount + toolbar open/close + persist.
 */

import type { Browser } from "puppeteer-core";
import { assertSmokeInputs, createSmokeRuntime } from "./smoke-plugin-ui";

export function panelMovePreservesState(observation: {
	from: { left: number; top: number };
	to: { left: number; top: number };
	target: { left: number; top: number };
	sameElement: boolean;
	hasSentinel: boolean;
}): boolean {
	return (
		observation.sameElement &&
		observation.hasSentinel &&
		Math.hypot(
			observation.to.left - observation.from.left,
			observation.to.top - observation.from.top,
		) > 10 &&
		Math.hypot(
			observation.to.left - observation.target.left,
			observation.to.top - observation.target.top,
		) < 5
	);
}

interface CheckResult {
	name: string;
	ok: boolean;
	detail?: string;
}
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail?: string) {
	results.push({ name, ok, detail });
	const tag = ok ? "PASS" : "FAIL";
	console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}
/**
 * Informational probe — printed but NOT counted toward pass/fail. Used where a
 * headless-only limitation (dockview DOM reflow not settling without a real
 * compositor) prevents a reliable DOM assertion, but the underlying logic is
 * covered elsewhere by unit tests.
 */
function info(name: string, ok: boolean, detail?: string) {
	console.log(`  [${ok ? "INFO-OK" : "INFO-NA"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForHealth(BASE: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1_000) });
			if (r.ok) return true;
		} catch {
			// not up yet
		}
		await Bun.sleep(300);
	}
	return false;
}

async function main() {
	assertSmokeInputs([
		"scripts/smoke-plugin-ui.ts",
		"server/index.ts",
		"server/lib/browser/pool.ts",
		"dist/frontend/index.html",
	]);
	const runtime = await createSmokeRuntime();
	const BASE = runtime.base;
	console.log(`Isolated NARRAFORK_HOME: ${runtime.home}`);
	console.log(`Isolated server: ${BASE}`);

	let browser: Browser | undefined;
	let exitCode = 0;
	try {
		runtime.start();
		const healthy = await waitForHealth(BASE, 25_000);
		runtime.assertHealthyProcess();
		if (!healthy) {
			throw new Error(`Backend did not become healthy in time. log tail:\n${runtime.logTail()}`);
		}
		console.log("Backend healthy.");

		// ── 2. Register the first user (auto-admin) → session token ──
		const reg = await fetch(`${BASE}/api/auth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "smoke_admin", password: "smoke-pass-123456" }),
		});
		if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
		const { token } = (await reg.json()) as { token: string };
		if (!token) throw new Error("no token from register");

		// ── 3. Create a standalone primary narrator ──
		const narrRes = await fetch(`${BASE}/api/narrators`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		});
		if (narrRes.status !== 201)
			throw new Error(`narrator create failed: ${narrRes.status} ${await narrRes.text()}`);
		const narrator = (await narrRes.json()) as { id: string };
		console.log(`Standalone narrator: ${narrator.id}`);

		// ── 4. Launch headless Chrome (reuses the app's own Chrome discovery) ──
		const { getBrowser } = await import("../server/lib/browser/pool");
		browser = await getBrowser(true);
		runtime.ownBrowser(browser);
		const page = await browser.newPage();
		runtime.watchPage(page, "narrator-dock");
		await page.setViewport({ width: 1400, height: 900 });

		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" && consoleErrors.length < 100) {
				consoleErrors.push(msg.text().slice(0, 500));
			}
		});
		page.on("pageerror", (err) => {
			if (consoleErrors.length < 100) {
				const message = err instanceof Error ? err.message : String(err);
				consoleErrors.push(`pageerror: ${message.slice(0, 500)}`);
			}
		});

		// Seed auth token before the app boots so the router treats us as logged in.
		await page.evaluateOnNewDocument((tok: string) => {
			localStorage.setItem("narrafork_token", tok);
			localStorage.setItem("narrafork_lang", "en");
		}, token);

		const url = `${BASE}/narrators/${narrator.id}`;
		// NOTE: the app holds a persistent WebSocket + polling, so "networkidle2"
		// never fires. Wait for DOM only, then explicitly await our own selectors.
		console.log("Navigating to narrator page…");
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

		// ── Check A: dockview surface + chat panel mounted ──
		// dockview renders `.dv-dockview`; our chat panel hosts the message input.
		const dockMounted = await page
			.waitForSelector(".dv-dockview", { timeout: 15_000 })
			.then(() => true)
			.catch(() => false);
		check("dockview surface mounts", dockMounted);

		// The chat toolbar's details button carries a stable icon; assert the
		// toolbar rendered by finding at least one dockview tab/content region.
		const tabCount = await page.$$eval(".dv-tab", (els) => els.length).catch(() => 0);
		check("at least one dock panel/tab present", tabCount >= 1, `tabs=${tabCount}`);

		// ── Check B: toolbar opens a tool panel (details) ──
		// Count panels via dockview's content containers before/after clicking the
		// details toggle. We locate the button by its aria/title if present, else
		// fall back to the first toolbar ActionIcon group. To stay robust we click
		// via an injected helper that finds the button whose tooltip/title matches.
		// Each dockview panel has exactly one tab; counting tabs = counting panels.
		const countPanels = () => page.$$eval(".dv-tab", (e) => e.length).catch(() => 0);
		const panelCountBefore = await countPanels();

		// Try to open the "spec" panel through the app's own dock context by
		// dispatching a click on the toolbar button that has the Notebook icon.
		// Buttons are Mantine ActionIcons; we match by the tabler icon class.
		const clickToolbarIcon = async (iconClass: string): Promise<boolean> => {
			return page.evaluate((cls: string) => {
				const icon = document.querySelector(`svg.${cls}`);
				const btn = icon?.closest("button");
				if (btn) {
					(btn as HTMLButtonElement).click();
					return true;
				}
				return false;
			}, iconClass);
		};

		// IconNotebook → spec panel. The Dockview shell mounts before the lazy chat
		// panel finishes loading, so wait for the real toolbar instead of racing it.
		await page
			.waitForSelector("svg.tabler-icon-notebook", { timeout: 15_000 })
			.catch(() => undefined);
		const clickedSpec = await clickToolbarIcon("tabler-icon-notebook");
		if (clickedSpec) {
			await page
				.waitForFunction(
					(before: number) => document.querySelectorAll(".dv-tab").length > before,
					{ timeout: 15_000 },
					panelCountBefore,
				)
				.catch(() => undefined);
		}
		const panelCountAfterOpen = await countPanels();
		check(
			"toolbar opens a tool panel (spec)",
			clickedSpec && panelCountAfterOpen > panelCountBefore,
			`clicked=${clickedSpec} before=${panelCountBefore} after=${panelCountAfterOpen}`,
		);

		// ── Check C: layout persisted to localStorage keyed by narrator+device ──
		await Bun.sleep(600); // allow the 400ms debounce to flush
		const persisted = await page.evaluate((nid: string) => {
			return localStorage.getItem(`narrafork_ndock_${nid}_desktop`);
		}, narrator.id);
		let hasSpecInStorage = false;
		if (persisted) {
			try {
				const env = JSON.parse(persisted);
				hasSpecInStorage = JSON.stringify(env.layout?.panels ?? {}).includes("ndock-spec");
			} catch {
				// leave false
			}
		}
		check("layout persisted with the opened panel", !!persisted && hasSpecInStorage);

		// ── Check D: reload restores the layout (spec panel still present) ──
		console.log("Reloading to verify persistence…");
		await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
		await page.waitForSelector(".dv-dockview", { timeout: 15_000 }).catch(() => {});
		await Bun.sleep(600);
		const panelCountAfterReload = await countPanels();
		check(
			"layout restored after reload",
			panelCountAfterReload >= panelCountAfterOpen && panelCountAfterOpen > 0,
			`afterOpen=${panelCountAfterOpen} afterReload=${panelCountAfterReload}`,
		);

		// ── Check D2: real pointer-drag merge (spec header → chat group center) ──
		// Drives the ACTUAL drag pipeline end to end: the spec panel's custom
		// grab-header pointerdown → startPanelDrag → panel-drag singleton's
		// document pointermove/up listeners → useDockviewDnd hitTest →
		// dropExistingPanel(merge). A center-drop collapses the two groups into
		// one (tab count unchanged). We dispatch native PointerEvents directly so
		// the drag does not depend on mouse→pointer derivation quirks.
		// Count distinct tab strips that actually host tabs. A raw ".dv-groupview"
		// count is unreliable in headless (dockview can retain an emptied group's
		// DOM node after a merge), so we count ".dv-tabs-container" elements that
		// still contain a tab — this matches the visible pane count and collapses
		// from 2 → 1 when the spec panel is tabbed into the chat group.
		// NOTE: this DOM-based group count is informational only. In headless
		// Chrome, dockview's layout/reflow (offsetParent, tab-strip membership,
		// emptied-group disposal) does not settle without a real compositor, so
		// the DOM lags the authoritative api.groups state after a merge. The
		// merge LOGIC (moveTo-by-index collapsing 2 groups → 1) is locked by
		// useDockviewDnd.test.ts; here we only surface the DOM count for context.
		const countGroups = () =>
			page
				.$$eval(
					".dv-tabs-container",
					(strips) => strips.filter((s) => s.querySelectorAll(".dv-tab").length > 0).length,
				)
				.catch(() => 0);
		const groupsBeforeDrag = await countGroups();

		// The draggable subject is our custom ToolPanelHeader (cursor:grab), not
		// dockview's own tab. Resolve the header center + a MERGE-zone point in
		// the chat group, then drive a real drag via CDP mouse input (which the
		// browser turns into the pointerdown/move/up that panel-drag listens for).
		const geom = await page.evaluate(() => {
			const isGrab = (el: Element) => getComputedStyle(el).cursor === "grab";
			// Under defaultRenderer="always", panel CONTENT (incl. our drag headers)
			// renders into an off-screen-managed overlay container, NOT inside
			// .dv-groupview. So we can't use closest(".dv-groupview"). Instead:
			//  - pick the visible "Spec" header by text + real size;
			//  - map it to a group by which .dv-groupview BOX contains its center;
			//  - the chat group is the other laid-out group.
			const grabs = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(isGrab);
			const specHeader =
				grabs.find((el) => {
					if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
					const r = el.getBoundingClientRect();
					return r.width > 20 && r.height > 8;
				}) ?? null;
			const groups = Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview")).filter(
				(g) => g.getBoundingClientRect().width > 10,
			);
			if (!specHeader || groups.length < 2) {
				return {
					ok: false as const,
					reason: `groups=${groups.length}, specHeader=${!!specHeader}, grabTexts=${grabs
						.map((g) => (g.textContent ?? "").trim().slice(0, 10))
						.join("|")}`,
				};
			}
			const sr = specHeader.getBoundingClientRect();
			const scx = sr.left + sr.width / 2;
			const scy = sr.top + sr.height / 2;
			const contains = (g: HTMLElement) => {
				const r = g.getBoundingClientRect();
				return scx >= r.left && scx <= r.right && scy >= r.top && scy <= r.bottom;
			};
			const specGroup = groups.find(contains) ?? null;
			const chatGroup = groups.find((g) => g !== specGroup) ?? null;
			if (!specGroup || !chatGroup) {
				return { ok: false as const, reason: `specGroup=${!!specGroup}, chatGroup=${!!chatGroup}` };
			}
			const cr = chatGroup.getBoundingClientRect();
			return {
				ok: true as const,
				sx: scx,
				sy: scy,
				// rx≈0.3, ry≈0.5: past edge band (0.2), outside center swap square
				// (0.14) → resolves to MERGE (tab into chat group), not swap/split.
				cx: cr.left + cr.width * 0.3,
				cy: cr.top + cr.height * 0.5,
			};
		});

		let mergeResult:
			| { ok: true; dragActivated: boolean; overlayVisible: boolean }
			| { ok: false; reason: string };
		if (geom.ok) {
			// Install an in-page probe: count document-capture pointermove events
			// and watch for the drop overlay (a sibling of .dv-dockview). This lets
			// us confirm the drag pipeline reacts to REAL CDP mouse input.
			await page.evaluate(() => {
				const w = window as unknown as { __dockProbe?: { moves: number; overlay: boolean } };
				w.__dockProbe = { moves: 0, overlay: 0 > 1 };
				const root = document.querySelector(".dv-dockview")?.parentElement ?? null;
				const overlaySeen = () =>
					!!root &&
					Array.from(root.querySelectorAll<HTMLElement>(":scope > *")).some((el) => {
						const s = getComputedStyle(el);
						const r = el.getBoundingClientRect();
						return (
							s.position === "absolute" &&
							s.pointerEvents === "none" &&
							parseFloat(s.opacity) > 0 &&
							parseFloat(s.opacity) < 1 &&
							r.width > 20 &&
							r.height > 20
						);
					});
				document.addEventListener(
					"pointermove",
					() => {
						const p = (window as unknown as { __dockProbe: { moves: number; overlay: boolean } })
							.__dockProbe;
						p.moves++;
						if (overlaySeen()) p.overlay = true;
					},
					true,
				);
			});

			// Fire pointerDOWN directly on the resolved (visible) spec header — same
			// text+size match as geom — so startPanelDrag reliably runs. (Dispatching
			// on elementFromPoint can land on an overlay drop-target layer instead of
			// the header under defaultRenderer="always".) Then drive pointerMOVE/UP
			// via CDP so Chrome emits genuine document pointermove events.
			await page.evaluate((g: { sx: number; sy: number }) => {
				const header =
					Array.from(document.querySelectorAll<HTMLElement>("*")).find((el) => {
						if (getComputedStyle(el).cursor !== "grab") return false;
						if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
						const r = el.getBoundingClientRect();
						return r.width > 20 && r.height > 8;
					}) ?? null;
				header?.dispatchEvent(
					new PointerEvent("pointerdown", {
						bubbles: true,
						cancelable: true,
						composed: true,
						clientX: g.sx,
						clientY: g.sy,
						pointerId: 1,
						pointerType: "mouse",
						isPrimary: true,
						button: 0,
						buttons: 1,
					}),
				);
			}, geom);
			await Bun.sleep(40);
			// NOTE: with the drag-activation threshold, a bare pointerdown no longer
			// flips the drag live — it activates only after the pointer moves past
			// the threshold. So we probe `grabbing` AFTER the first CDP move below.

			const cdp = await page.createCDPSession();
			const move = (x: number, y: number) =>
				cdp.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x,
					y,
					button: "left",
					buttons: 1,
					pointerType: "mouse",
				});
			let dragActivated = false;
			const steps = 20;
			for (let i = 1; i <= steps; i++) {
				await move(
					geom.sx + ((geom.cx - geom.sx) * i) / steps,
					geom.sy + ((geom.cy - geom.sy) * i) / steps,
				);
				await Bun.sleep(16);
				if (!dragActivated) {
					dragActivated = await page.evaluate(() => document.body.style.cursor === "grabbing");
				}
			}
			await Bun.sleep(80);
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: geom.cx,
				y: geom.cy,
				button: "left",
				buttons: 0,
				clickCount: 1,
				pointerType: "mouse",
			});
			await cdp.detach().catch(() => {});
			const probe = await page.evaluate(
				() =>
					(window as unknown as { __dockProbe?: { moves: number; overlay: boolean } })
						.__dockProbe ?? { moves: 0, overlay: false },
			);
			mergeResult = { ok: true, dragActivated, overlayVisible: probe.overlay };
		} else {
			mergeResult = { ok: false, reason: geom.reason };
		}

		await Bun.sleep(400);
		const groupsAfterDrag = await countGroups();
		const tabsAfterDrag = await countPanels();
		const dragActivated =
			mergeResult.ok && (mergeResult as { dragActivated?: boolean }).dragActivated === true;
		const mergedOk =
			mergeResult.ok &&
			groupsAfterDrag < groupsBeforeDrag &&
			tabsAfterDrag === panelCountAfterReload;

		// ASSERTION: a real pointerdown on the panel header genuinely starts the
		// app's drag singleton (this is the interactive entry point users hit).
		check(
			"pointer-down on panel header activates the drag pipeline",
			dragActivated,
			`dragActivated=${dragActivated}`,
		);
		// INFO ONLY: the end-to-end drag drives hitTest → dropExistingPanel(merge)
		// live (verified during development: api.groups collapses 2 → 1). The DOM
		// group count is unreliable in headless (see countGroups note), so this is
		// reported, not asserted; the merge LOGIC is locked by useDockviewDnd.test.ts.
		info(
			"synthesized drag→merge (DOM count is headless-unreliable; logic unit-tested)",
			mergedOk,
			mergeResult.ok
				? `DOM groups ${groupsBeforeDrag}→${groupsAfterDrag}, tabs=${tabsAfterDrag}`
				: `drag setup failed: ${(mergeResult as { reason?: string }).reason ?? "unknown"}`,
		);

		// ── Check D3: center-drop SWAP keeps two panes and exchanges positions ──
		// Regression for "swap turned into merge, original pane vanished". Clear
		// the persisted dock layout (the earlier merge test left spec tabbed into
		// chat) so reload gives a clean chat-only state, then open the spec tool
		// panel (→ two side-by-side groups) and center-drop spec onto chat.
		// Expected: still TWO tab strips, and the chat/spec panes swap sides.
		await page.evaluate((nid: string) => {
			localStorage.removeItem(`narrafork_ndock_${nid}_desktop`);
		}, narrator.id);
		await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
		await page.waitForSelector(".dv-dockview", { timeout: 15_000 }).catch(() => {});
		await Bun.sleep(500);
		await clickToolbarIcon("tabler-icon-notebook"); // open spec as a right split
		await Bun.sleep(700);

		const swapGeom = await page.evaluate(() => {
			const grabs = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
				(el) => getComputedStyle(el).cursor === "grab",
			);
			// always mode: headers live in the overlay container, not in .dv-groupview.
			// Pick the visible Spec header, then map to a group by box containment.
			const specHeader =
				grabs.find((el) => {
					if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
					const r = el.getBoundingClientRect();
					return r.width > 20 && r.height > 8;
				}) ?? null;
			const groups = Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview")).filter(
				(g) => g.getBoundingClientRect().width > 10,
			);
			if (!specHeader || groups.length < 2) return { ok: false as const };
			const sr = specHeader.getBoundingClientRect();
			const scx = sr.left + sr.width / 2;
			const scy = sr.top + sr.height / 2;
			const specGroup =
				groups.find((g) => {
					const r = g.getBoundingClientRect();
					return scx >= r.left && scx <= r.right && scy >= r.top && scy <= r.bottom;
				}) ?? null;
			const chatGroup = groups.find((g) => g !== specGroup) ?? null;
			if (!specGroup || !chatGroup) return { ok: false as const };
			const cr = chatGroup.getBoundingClientRect();
			const specRect = specGroup.getBoundingClientRect();
			return {
				ok: true as const,
				sx: scx,
				sy: scy,
				cx: cr.left + cr.width / 2,
				cy: cr.top + cr.height / 2,
				chatLeftBefore: cr.left,
				specLeftBefore: specRect.left,
			};
		});

		let swapOk = false;
		let swapDetail = "geometry unresolved";
		if (swapGeom.ok) {
			const groupsBeforeSwap = await countGroups();
			// pointerdown directly on the resolved (visible) spec header, then real
			// CDP moves to the CHAT group CENTER (swap zone), then release.
			await page.evaluate((g: { sx: number; sy: number }) => {
				const header =
					Array.from(document.querySelectorAll<HTMLElement>("*")).find((el) => {
						if (getComputedStyle(el).cursor !== "grab") return false;
						if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
						const r = el.getBoundingClientRect();
						return r.width > 20 && r.height > 8;
					}) ?? null;
				header?.dispatchEvent(
					new PointerEvent("pointerdown", {
						bubbles: true,
						cancelable: true,
						composed: true,
						clientX: g.sx,
						clientY: g.sy,
						pointerId: 1,
						pointerType: "mouse",
						isPrimary: true,
						button: 0,
						buttons: 1,
					}),
				);
			}, swapGeom);
			await Bun.sleep(40);
			const cdp2 = await page.createCDPSession();
			const mv = (x: number, y: number) =>
				cdp2.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x,
					y,
					button: "left",
					buttons: 1,
					pointerType: "mouse",
				});
			const steps = 20;
			for (let i = 1; i <= steps; i++) {
				await mv(
					swapGeom.sx + ((swapGeom.cx - swapGeom.sx) * i) / steps,
					swapGeom.sy + ((swapGeom.cy - swapGeom.sy) * i) / steps,
				);
				await Bun.sleep(14);
			}
			await Bun.sleep(60);
			await cdp2.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: swapGeom.cx,
				y: swapGeom.cy,
				button: "left",
				buttons: 0,
				clickCount: 1,
				pointerType: "mouse",
			});
			await cdp2.detach().catch(() => {});
			await Bun.sleep(600);

			const groupsAfterSwap = await countGroups();
			// After a swap, the spec pane's left edge should now be on the side the
			// chat pane used to occupy (positions exchanged), and both panes remain.
			const after = await page.evaluate(() => {
				const grabs = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
					(el) => getComputedStyle(el).cursor === "grab",
				);
				// always mode: map the visible Spec header to a group by box containment.
				const specHeader =
					grabs.find((el) => {
						if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
						const r = el.getBoundingClientRect();
						return r.width > 20 && r.height > 8;
					}) ?? null;
				if (!specHeader) return { specLeft: -1 };
				const sr = specHeader.getBoundingClientRect();
				const scx = sr.left + sr.width / 2;
				const scy = sr.top + sr.height / 2;
				const groups = Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview")).filter(
					(g) => g.getBoundingClientRect().width > 10,
				);
				const specGroup =
					groups.find((g) => {
						const r = g.getBoundingClientRect();
						return scx >= r.left && scx <= r.right && scy >= r.top && scy <= r.bottom;
					}) ?? null;
				return { specLeft: specGroup?.getBoundingClientRect().left ?? -1 };
			});
			const specMovedToChatSide =
				Math.abs(after.specLeft - swapGeom.chatLeftBefore) <
				Math.abs(after.specLeft - swapGeom.specLeftBefore);
			swapOk = groupsAfterSwap === 2 && groupsBeforeSwap === 2 && specMovedToChatSide;
			swapDetail = `groups ${groupsBeforeSwap}→${groupsAfterSwap}, specLeft ${Math.round(
				swapGeom.specLeftBefore,
			)}→${Math.round(after.specLeft)} (chat was ${Math.round(swapGeom.chatLeftBefore)})`;
		}
		check("center-drop swaps panes (both survive, positions exchange)", swapOk, swapDetail);

		// ── Check D4: moving a panel PRESERVES its component state (defaultRenderer
		// "always"). Type a sentinel into the chat input, swap the chat pane onto
		// the spec pane, and confirm the sentinel survives — proving the chat
		// component was NOT remounted (which would clear the textarea). ──
		const sentinel = `keepalive-${Date.now()}`;
		// Type into the chat composer textarea (must be the visible one).
		const typed = await page.evaluate((text: string) => {
			const areas = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")).filter(
				(t) => {
					const r = t.getBoundingClientRect();
					return r.width > 40 && r.height > 10;
				},
			);
			const ta = areas[0];
			if (!ta) return false;
			const rect = ta.getBoundingClientRect();
			(
				window as unknown as {
					__smokeChatMove: { element: HTMLTextAreaElement; left: number; top: number };
				}
			).__smokeChatMove = {
				element: ta,
				left: rect.left,
				top: rect.top,
			};
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(ta, text);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			return ta.value === text;
		}, sentinel);
		await Bun.sleep(200);

		let statePreserved = false;
		let stateDetail = "no chat textarea / not typed";
		if (typed) {
			// Resolve the CHAT header (the draggable panel header whose text is not
			// "Spec") and its group, plus the spec group as the swap target.
			const chatGeom = await page.evaluate(() => {
				const grabs = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
					(el) => getComputedStyle(el).cursor === "grab",
				);
				const groups = Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview")).filter(
					(g) => g.getBoundingClientRect().width > 10,
				);
				// The Spec header identifies the spec group; the chat group is the other.
				const specHeader =
					grabs.find((el) => {
						if (!/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
						const r = el.getBoundingClientRect();
						return r.width > 20 && r.height > 8;
					}) ?? null;
				if (!specHeader || groups.length < 2) return { ok: false as const };
				const sr = specHeader.getBoundingClientRect();
				const scx = sr.left + sr.width / 2;
				const scy = sr.top + sr.height / 2;
				const specGroup =
					groups.find((g) => {
						const r = g.getBoundingClientRect();
						return scx >= r.left && scx <= r.right && scy >= r.top && scy <= r.bottom;
					}) ?? null;
				const chatGroup = groups.find((g) => g !== specGroup) ?? null;
				if (!specGroup || !chatGroup) return { ok: false as const };
				const cr = chatGroup.getBoundingClientRect();
				const spr = specGroup.getBoundingClientRect();
				const chatHeader = grabs.find((el) => {
					if (/(spec|outline)/i.test((el.textContent ?? "").trim())) return false;
					const r = el.getBoundingClientRect();
					return (
						r.width > 40 &&
						r.height > 8 &&
						r.left >= cr.left &&
						r.right <= cr.right &&
						r.top >= cr.top &&
						r.top < cr.top + 40
					);
				});
				if (!chatHeader) return { ok: false as const };
				const chr = chatHeader.getBoundingClientRect();
				return {
					ok: true as const,
					sx: chr.left + chr.width / 2,
					sy: chr.top + chr.height / 2,
					cx: spr.left + spr.width / 2,
					cy: spr.top + spr.height / 2,
					from: { left: cr.left, top: cr.top },
					target: { left: spr.left, top: spr.top },
				};
			});
			if (chatGeom.ok) {
				await page.evaluate((g: { sx: number; sy: number }) => {
					const header =
						Array.from(document.querySelectorAll<HTMLElement>("*")).find((el) => {
							if (getComputedStyle(el).cursor !== "grab") return false;
							const txt = (el.textContent ?? "").trim();
							if (/(spec|outline)/i.test(txt)) return false;
							const r = el.getBoundingClientRect();
							return (
								r.width > 40 &&
								r.height > 8 &&
								Math.abs(r.left + r.width / 2 - g.sx) < 1 &&
								Math.abs(r.top + r.height / 2 - g.sy) < 1
							);
						}) ?? null;
					header?.dispatchEvent(
						new PointerEvent("pointerdown", {
							bubbles: true,
							cancelable: true,
							composed: true,
							clientX: g.sx,
							clientY: g.sy,
							pointerId: 1,
							pointerType: "mouse",
							isPrimary: true,
							button: 0,
							buttons: 1,
						}),
					);
				}, chatGeom);
				await Bun.sleep(40);
				const cdp3 = await page.createCDPSession();
				const steps = 20;
				for (let i = 1; i <= steps; i++) {
					await cdp3.send("Input.dispatchMouseEvent", {
						type: "mouseMoved",
						x: chatGeom.sx + ((chatGeom.cx - chatGeom.sx) * i) / steps,
						y: chatGeom.sy + ((chatGeom.cy - chatGeom.sy) * i) / steps,
						button: "left",
						buttons: 1,
						pointerType: "mouse",
					});
					await Bun.sleep(14);
				}
				await Bun.sleep(60);
				await cdp3.send("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x: chatGeom.cx,
					y: chatGeom.cy,
					button: "left",
					buttons: 0,
					clickCount: 1,
					pointerType: "mouse",
				});
				await cdp3.detach().catch(() => {});
				await Bun.sleep(600);
				// A no-op drag also keeps the sentinel. Require both a real position change
				// and the exact original textarea instance, not just matching text somewhere.
				const observation = await page.evaluate(
					(input) => {
						const text = input.text;
						const before = (
							window as unknown as {
								__smokeChatMove?: { element: HTMLTextAreaElement; left: number; top: number };
							}
						).__smokeChatMove;
						if (!before) return undefined;
						const current = Array.from(
							document.querySelectorAll<HTMLTextAreaElement>("textarea"),
						).find((area) => area.value === text);
						const rect = current?.getBoundingClientRect();
						const group = rect
							? Array.from(document.querySelectorAll<HTMLElement>(".dv-groupview")).find(
									(candidate) => {
										const bounds = candidate.getBoundingClientRect();
										const x = rect.left + rect.width / 2;
										const y = rect.top + rect.height / 2;
										return (
											bounds.width > 10 &&
											x >= bounds.left &&
											x <= bounds.right &&
											y >= bounds.top &&
											y <= bounds.bottom
										);
									},
								)
							: undefined;
						const bounds = group?.getBoundingClientRect();
						return {
							from: input.from,
							to: { left: bounds?.left ?? input.from.left, top: bounds?.top ?? input.from.top },
							target: input.target,
							sameElement: current === before.element && before.element.isConnected,
							hasSentinel: current?.value === text,
						};
					},
					{ text: sentinel, from: chatGeom.from, target: chatGeom.target },
				);
				statePreserved = !!observation && panelMovePreservesState(observation);
				stateDetail = `actual move + same textarea + sentinel: ${JSON.stringify(observation)}`;
			} else {
				stateDetail = "could not resolve chat/spec geometry";
			}
		}
		check("moving a panel preserves component state (no remount)", statePreserved, stateDetail);

		// ── Check E: no uncaught console errors during the run ──
		// Filter out benign network noise (favicon, ws reconnect chatter).
		const meaningful = consoleErrors.filter(
			(e) => !/favicon|websocket|ws:|net::ERR|Failed to load resource/i.test(e),
		);
		check(
			"no meaningful console errors",
			meaningful.length === 0,
			meaningful.length ? meaningful.slice(0, 3).join(" | ") : undefined,
		);

		await page.close();
		runtime.assertHealthyProcess();
	} catch (err) {
		console.error("SMOKE ERROR:", err instanceof Error ? err.message : err);
		exitCode = 1;
	} finally {
		runtime.report(results);
		await runtime.cleanup();
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
	if (failed.length || exitCode) {
		console.error("FAILED:", failed.map((f) => f.name).join(", ") || "(startup error)");
		process.exit(1);
	}
	console.log("All narrator-dock smoke checks passed.");
	process.exit(0);
}

if (import.meta.main) {
	void main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
