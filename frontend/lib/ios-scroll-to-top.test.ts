import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	IOS_SCROLL_TO_TOP_ATTRIBUTE,
	IOS_SCROLL_TO_TOP_ROUTE_EVENT,
	installIOSScrollToTopBridge,
	registerIOSScrollToTopTarget,
} from "./ios-scroll-to-top";
import { installAuthenticatedAppShellRootLock } from "./safe-area";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Layout and native scrolling are deliberately simulated here, not iOS status-bar taps. */
function realm(
	options: {
		ua?: string;
		touch?: number;
		range?: number;
		acceptsOffset?: boolean;
		throwsScroll?: boolean;
		compensates?: boolean;
	} = {},
) {
	const { document: domDocument, window: domWindow } = parseHTML(
		'<!doctype html><html><body><main class="nf-app-shell-main" id="main"><section id="panel"><div id="list"></div><textarea id="composer"></textarea></section></main></body></html>',
	);
	const document = domDocument as unknown as Document;
	const root = document.documentElement;
	root.setAttribute("data-nf-authenticated-app-shell", "true");
	let now = 0;
	let scrollY = 0;
	let nextId = 1;
	let activeElement: Element | null = null;
	let visible = true;
	const frames = new Map<number, FrameRequestCallback>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	const listeners = new Map<string, Set<EventListener>>();
	const viewportListeners = new Map<string, Set<EventListener>>();
	const observers = new Set<() => void>();
	const rects = new Map<Element, DOMRect>();
	const readRect = (element: Element) => rects.get(element) ?? rect(0, 0, 0, 0);
	function rect(left: number, top: number, width: number, height: number): DOMRect {
		return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
	}
	function hidden(element: Element) {
		for (let node: Element | null = element; node; node = node.parentElement) {
			const style = (node as HTMLElement).style;
			if (node.hasAttribute("hidden") || node.hasAttribute("inert")) return true;
			if (node.getAttribute("aria-hidden") === "true") return true;
			if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
				return true;
		}
		return false;
	}
	const visualViewport = {
		width: 390,
		height: 844,
		offsetTop: 0,
		offsetLeft: 0,
		scale: 1,
		addEventListener(type: string, listener: EventListener) {
			const entries = viewportListeners.get(type) ?? new Set<EventListener>();
			entries.add(listener);
			viewportListeners.set(type, entries);
		},
		removeEventListener(type: string, listener: EventListener) {
			viewportListeners.get(type)?.delete(listener);
		},
		emit(type: string) {
			for (const listener of [...(viewportListeners.get(type) ?? [])]) listener({} as Event);
		},
	};
	const window = {
		navigator: {
			userAgent: options.ua ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
			platform: "MacIntel",
			maxTouchPoints: options.touch ?? 5,
		},
		document,
		innerWidth: 390,
		innerHeight: 844,
		visualViewport,
		performance: { now: () => now },
		location: { href: "https://example.test/narrators/a" },
		get scrollY() {
			return scrollY;
		},
		scrollX: 0,
		scrollTo(first: number | ScrollToOptions, second?: number) {
			if (options.throwsScroll) throw new TypeError("Unsupported native scroll options");
			const requested = typeof first === "number" ? (second ?? 0) : (first.top ?? scrollY);
			scrollY = options.acceptsOffset === false ? 0 : requested;
		},
		requestAnimationFrame(callback: FrameRequestCallback) {
			const id = nextId++;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame(id: number) {
			frames.delete(id);
		},
		setTimeout(callback: () => void, delay: number) {
			const id = nextId++;
			timers.set(id, { at: now + delay, callback });
			return id;
		},
		clearTimeout(id: number) {
			timers.delete(id);
		},
		addEventListener(type: string, listener: EventListener) {
			const entries = listeners.get(type) ?? new Set<EventListener>();
			entries.add(listener);
			listeners.set(type, entries);
		},
		removeEventListener(type: string, listener: EventListener) {
			listeners.get(type)?.delete(listener);
		},
		getComputedStyle(element: HTMLElement) {
			return {
				display: element.style.display || "block",
				visibility: element.style.visibility || "visible",
				opacity: element.style.opacity || "1",
				overflowY:
					element.style.overflowY ||
					element.style.overflow ||
					(element === root && root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)
						? "auto"
						: element === root || element === document.body
							? "hidden"
							: "auto"),
				position: element.style.position || "static",
			};
		},
		MutationObserver: class {
			constructor(private callback: () => void) {}
			observe() {
				observers.add(this.callback);
			}
			disconnect() {
				observers.delete(this.callback);
			}
		},
	} as unknown as Window;
	Object.defineProperties(document, {
		defaultView: { configurable: true, value: window },
		activeElement: { configurable: true, get: () => activeElement },
		visibilityState: { configurable: true, get: () => (visible ? "visible" : "hidden") },
		scrollingElement: { configurable: true, value: root },
		elementFromPoint: {
			configurable: true,
			value: (x: number, y: number) => {
				for (const element of [...document.querySelectorAll("*")].reverse()) {
					const bounds = readRect(element);
					if (
						!hidden(element) &&
						x >= bounds.left &&
						x < bounds.right &&
						y >= bounds.top &&
						y < bounds.bottom
					)
						return element;
				}
				return null;
			},
		},
	});
	Object.defineProperties(root, {
		clientHeight: { configurable: true, value: 844 },
		scrollHeight: {
			configurable: true,
			get: () => 844 + (root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE) ? (options.range ?? 1) : 0),
		},
		scrollTop: { configurable: true, get: () => scrollY },
	});
	document.body.getBoundingClientRect = () =>
		rect(
			0,
			(root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE) && options.compensates !== false ? 1 : 0) -
				scrollY,
			390,
			844,
		);
	function box(id: string, left = 0, top = 100, width = 390, height = 500) {
		const element = document.getElementById(id) as HTMLElement;
		rects.set(element, rect(left, top, width, height));
		element.getBoundingClientRect = () => readRect(element);
		Object.defineProperties(element, {
			clientHeight: { configurable: true, value: height },
			scrollHeight: { configurable: true, value: height + 2000 },
		});
		element.scrollTop = 500;
		return element;
	}
	const main = box("main", 0, 0, 390, 844);
	box("panel", 0, 100, 390, 650);
	const list = box("list");
	const composer = box("composer", 0, 650, 390, 60);
	function emit(type: string) {
		for (const listener of [...(listeners.get(type) ?? [])]) {
			listener({ type, target: document } as unknown as Event);
		}
	}
	return {
		window,
		document,
		root,
		main,
		list,
		composer,
		visualViewport,
		box,
		install() {
			const cleanup = installIOSScrollToTopBridge(window, document);
			cleanups.push(cleanup);
			return cleanup;
		},
		register(element = list, callback = () => {}, hasUnprocessedScroll?: () => boolean) {
			const cleanup = registerIOSScrollToTopTarget(element, callback, hasUnprocessedScroll);
			cleanups.push(cleanup);
			return cleanup;
		},
		frames(count = 6) {
			for (let turn = 0; turn < count; turn++) {
				for (const [id, callback] of [...frames]) {
					frames.delete(id);
					callback(now);
				}
			}
		},
		settle(delay = 1000, frameCount = 6) {
			now += delay;
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
			this.frames(frameCount);
		},
		interact(element: Element, type = "pointerdown", fields: Record<string, unknown> = {}) {
			const event = new domWindow.Event(type, { bubbles: true });
			Object.assign(event, fields);
			element.dispatchEvent(event as unknown as Event);
		},
		focus(element: Element | null) {
			activeElement = element;
			this.interact(element ?? document.body, element ? "focusin" : "focusout");
		},
		mutate() {
			for (const callback of [...observers]) callback();
		},
		emit,
		rootTop() {
			scrollY = 0;
			emit("scroll");
		},
		hidePage(hidden: boolean) {
			visible = !hidden;
			this.interact(document.body, "visibilitychange");
		},
		pending: () => frames.size + timers.size,
		listenerCount: () =>
			[...listeners.values(), ...viewportListeners.values()].reduce(
				(sum, set) => sum + set.size,
				0,
			),
	};
}

describe("iOS native root-scroll bridge", () => {
	test.each([
		["Mozilla/5.0 (X11; Linux x86_64)", 0, false],
		["Mozilla/5.0 (Android 15)", 5, false],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X)", 0, false],
		["Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5, true],
		["Mozilla/5.0 (iPad; CPU OS 18_0)", 5, true],
		["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", 0, false],
	])("platform gating: %s / touch=%i", (ua, touch, enabled) => {
		const env = realm({ ua, touch });
		env.install();
		env.frames();
		expect(env.root.getAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(enabled ? "true" : null);
	});

	test("requires the authenticated shell", () => {
		const env = realm();
		env.root.removeAttribute("data-nf-authenticated-app-shell");
		env.install();
		env.frames();
		expect(env.root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(false);
		expect(env.pending()).toBe(0);
	});

	test("quirks documents without a native scrollingElement stay unchanged", () => {
		const env = realm();
		Object.defineProperty(env.document, "scrollingElement", { configurable: true, value: null });
		env.install();
		env.frames();
		expect(env.root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(false);
		expect(env.pending()).toBe(0);
	});

	test.each([
		{ acceptsOffset: false },
		{ throwsScroll: true },
		{ range: 0 },
		{ range: 45 },
		{ compensates: false },
	])("rolls back when the native one-pixel range cannot be verified: %j", (options) => {
		const env = realm(options);
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		env.settle();
		expect(env.root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(false);
		expect(calls).toBe(0);
		expect(env.pending()).toBe(0);
		expect(env.listenerCount()).toBe(0);
	});

	test("registration may precede installation; initialization and own rearming never dispatch", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.rootTop();
		env.frames();
		expect(calls).toBe(0);
		expect(env.window.scrollY).toBe(1);
		env.emit("scroll");
		expect(calls).toBe(0);
	});

	test("one native zero transition dispatches once and repeated transitions work", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		env.rootTop();
		expect(calls).toBe(1);
		env.frames();
		env.rootTop();
		env.settle(200);
		env.rootTop();
		expect(calls).toBe(1);
		env.settle();
		expect(env.window.scrollY).toBe(1);
		env.rootTop();
		expect(calls).toBe(2);
	});

	test("late native zero while rearming never redispatches and unstable offsets are withdrawn", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		env.settle(350, 1);
		expect(env.window.scrollY).toBe(1);
		env.rootTop();
		env.frames();
		env.rootTop();
		expect(calls).toBe(1);
		expect(env.root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(false);
		expect(env.pending()).toBe(0);
	});

	test("zero-position semantic targets still own the action instead of scrolling Main", () => {
		const env = realm();
		env.list.scrollTop = 0;
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		expect(calls).toBe(1);
		expect(env.main.scrollTop).toBe(500);
	});

	test("replacing a registration makes stale cleanup harmless", () => {
		const env = realm();
		let oldCalls = 0;
		let newCalls = 0;
		const removeOld = env.register(env.list, () => oldCalls++);
		env.register(env.list, () => newCalls++);
		removeOld();
		env.install();
		env.frames();
		env.rootTop();
		expect(oldCalls).toBe(0);
		expect(newCalls).toBe(1);
	});

	test("unregistered and disconnected targets never receive a stale callback", () => {
		const env = realm();
		let calls = 0;
		const remove = env.register(env.list, () => calls++);
		env.install();
		env.frames();
		remove();
		env.list.remove();
		env.rootTop();
		expect(calls).toBe(0);
	});

	test("registry is scoped by ownerDocument, including registrations before any bridge", () => {
		const first = realm();
		const second = realm();
		let calls = 0;
		second.register(second.list, () => calls++);
		first.install();
		first.frames();
		first.rootTop();
		expect(calls).toBe(0);
	});

	test("Main and Mantine ScrollArea use DOM scrolling, preserving scrollLeft", () => {
		const env = realm();
		env.list.classList.add("mantine-ScrollArea-viewport");
		env.list.scrollLeft = 17;
		env.install();
		env.frames();
		env.rootTop();
		expect(env.list.scrollTop).toBe(0);
		expect(env.list.scrollLeft).toBe(17);
		expect(env.main.scrollTop).toBe(500);
		env.list.classList.remove("mantine-ScrollArea-viewport");
		env.settle();
		env.rootTop();
		expect(env.main.scrollTop).toBe(0);
	});

	test("an already-top active DOM viewport does not fall through to its parent", () => {
		const env = realm();
		env.list.classList.add("mantine-ScrollArea-viewport");
		env.list.scrollTop = 0;
		env.install();
		env.frames();
		env.rootTop();
		expect(env.main.scrollTop).toBe(500);
	});

	test.each([
		{ overflow: 0, recent: false },
		{ overflow: 0, recent: true },
		{ overflow: 1, recent: false },
		{ overflow: 1, recent: true },
	])("an active nested ScrollArea owns the action with %j", ({ overflow, recent }) => {
		const env = realm();
		env.list.classList.add("mantine-ScrollArea-viewport");
		Object.defineProperty(env.list, "scrollHeight", {
			configurable: true,
			value: env.list.clientHeight + overflow,
		});
		env.list.scrollTop = 0;
		env.install();
		env.frames();
		if (recent) env.interact(env.list);
		env.rootTop();
		expect(env.list.scrollTop).toBe(0);
		expect(env.main.scrollTop).toBe(500);
	});

	test("a textarea inside a registered viewport keeps both private and parent scrolling untouched", () => {
		const env = realm();
		env.list.innerHTML = '<textarea id="embedded-textarea"></textarea>';
		const textarea = env.box("embedded-textarea");
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.interact(textarea);
		env.rootTop();
		expect(calls).toBe(0);
		expect(textarea.scrollTop).toBe(500);
		expect(env.list.scrollTop).toBe(500);
		expect(env.main.scrollTop).toBe(500);
	});

	test("recent composer interaction outside a registered viewport selects its sibling by their closest common panel", () => {
		const env = realm();
		env.list.parentElement?.insertAdjacentHTML(
			"afterend",
			'<section id="other-panel"><div id="other"></div></section>',
		);
		env.box("panel", 0, 100, 180, 650);
		env.box("list", 0, 100, 180, 500);
		env.box("composer", 0, 650, 180, 60);
		env.box("other-panel", 200, 100, 190, 650);
		const other = env.box("other", 200, 100, 190, 500);
		let selected = "";
		env.register(env.list, () => {
			selected = "composer-panel";
		});
		env.register(other, () => {
			selected = "other";
		});
		env.install();
		env.frames();
		env.interact(env.composer);
		env.rootTop();
		expect(selected).toBe("composer-panel");
		expect(env.composer.scrollTop).toBe(500);
	});

	test("hit testing excludes the first hidden/parked registration", () => {
		const env = realm();
		env.list.insertAdjacentHTML("beforebegin", '<div id="parked" hidden></div>');
		const parked = env.box("parked");
		let selected = "";
		env.register(parked, () => {
			selected = "parked";
		});
		env.register(env.list, () => {
			selected = "visible";
		});
		env.install();
		env.frames();
		env.rootTop();
		expect(selected).toBe("visible");
	});

	test("an overlay blocks background targets even when it has no scroll target", () => {
		const env = realm();
		env.document.body.insertAdjacentHTML(
			"beforeend",
			'<div class="mantine-Modal-content" role="dialog" id="modal"></div>',
		);
		env.box("modal", 0, 0, 390, 844);
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		expect(calls).toBe(0);
		expect(env.main.scrollTop).toBe(500);
	});

	test("modal-local ScrollArea may scroll while a background registration stays untouched", () => {
		const env = realm();
		env.document.body.insertAdjacentHTML(
			"beforeend",
			'<div class="mantine-Modal-content" id="modal"><div class="mantine-ScrollArea-viewport" id="modal-list"></div></div>',
		);
		env.box("modal", 0, 0, 390, 844);
		const modalList = env.box("modal-list", 0, 100, 390, 600);
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.rootTop();
		expect(modalList.scrollTop).toBe(0);
		expect(calls).toBe(0);
	});

	test.each([
		"textarea",
		"cm-editor",
		"monaco-editor",
		"xterm",
	])("does not take over %s scrolling", (kind) => {
		const env = realm();
		env.list.innerHTML =
			kind === "textarea"
				? '<textarea id="editor"></textarea>'
				: `<div id="editor" class="${kind}"></div>`;
		const editor = env.box("editor");
		env.install();
		env.frames();
		env.interact(editor);
		env.rootTop();
		expect(editor.scrollTop).toBe(500);
		expect(env.main.scrollTop).toBe(500);
	});

	test("visual viewport scrolling is not a native-root signal", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.visualViewport.emit("scroll");
		env.frames();
		expect(calls).toBe(0);
		env.visualViewport.offsetTop = 100;
		env.visualViewport.emit("scroll");
		env.rootTop();
		env.settle();
		expect(calls).toBe(0);
	});

	test("touch chains and late momentum scrolls cannot trigger a false action", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.interact(env.list, "touchstart");
		env.rootTop();
		env.interact(env.list, "touchend");
		env.settle(200);
		env.interact(env.list, "scroll");
		env.rootTop();
		env.settle(200);
		expect(calls).toBe(0);
		env.settle();
		env.rootTop();
		expect(calls).toBe(1);
	});

	test("continuous smooth following does not postpone rearming after a touch", async () => {
		const { createSmoothFollower } = await import("./smooth-scroll");
		const env = realm();
		let calls = 0;
		let committedTop = env.list.scrollTop;
		let target = committedTop + 100;
		let writes = 0;
		const follower = createSmoothFollower({
			readCurrent: () => env.list.scrollTop,
			readTarget: () => target,
			getViewportHeight: () => 500,
			writeInstant: () => {},
			writeChase: (top) => {
				env.list.scrollTop = committedTop = top;
				writes++;
				env.interact(env.list, "scroll");
			},
			canAnimate: () => true,
			isReducedMotion: () => false,
			now: () => 0,
			raf: env.window.requestAnimationFrame,
			cancelRaf: env.window.cancelAnimationFrame,
		});
		env.register(
			env.list,
			() => calls++,
			() => env.list.scrollTop !== committedTop,
		);
		env.install();
		env.frames();
		env.interact(env.list, "touchstart");
		env.interact(env.list, "touchend");
		follower.ensure();
		for (let i = 0; i < 32; i++) {
			target += 5;
			env.settle(16, 1);
		}
		expect(writes).toBe(32);
		expect(env.window.scrollY).toBe(1);
		env.rootTop();
		expect(calls).toBe(1);

		// A distinct position from the same target is still treated as momentum.
		env.interact(env.list, "touchstart");
		env.interact(env.list, "touchend");
		env.settle(200, 1);
		env.list.scrollTop -= 10;
		env.interact(env.list, "scroll");
		env.settle(200, 1);
		expect(env.window.scrollY).toBe(0);
		env.rootTop();
		expect(calls).toBe(1);
		follower.cancel();
	});

	test("focus, existing keyboard state and zoom pause recognition until a settled reset", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.focus(env.composer);
		env.rootTop();
		env.root.setAttribute("data-virtual-keyboard-open", "");
		env.focus(null);
		env.mutate();
		env.settle();
		env.rootTop();
		expect(calls).toBe(0);
		env.root.removeAttribute("data-virtual-keyboard-open");
		env.visualViewport.scale = 1.4;
		env.visualViewport.emit("resize");
		env.settle();
		env.rootTop();
		expect(calls).toBe(0);
		env.visualViewport.scale = 1;
		env.visualViewport.emit("resize");
		env.settle();
		env.rootTop();
		expect(calls).toBe(1);
	});

	test.each([
		"resize",
		"orientationchange",
		"pageshow",
		"popstate",
		"hashchange",
	])("%s invalidates native zero transitions during recalibration", (type) => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.emit(type);
		env.rootTop();
		env.settle();
		expect(calls).toBe(0);
		env.rootTop();
		expect(calls).toBe(1);
	});

	test("route notifications clear a previously selected panel before rearming", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.interact(env.composer);
		env.interact(env.document.body, IOS_SCROLL_TO_TOP_ROUTE_EVENT);
		env.rootTop();
		env.settle();
		expect(calls).toBe(0);
		env.rootTop();
		expect(calls).toBe(1);
	});

	test("pagehide and bfcache pageshow recover without inheriting a lost touch", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.interact(env.list, "touchstart");
		env.emit("pagehide");
		env.rootTop();
		env.emit("pageshow");
		env.settle();
		expect(calls).toBe(0);
		env.rootTop();
		expect(calls).toBe(1);
	});

	test("body scroll locks and document visibility pause without polling", () => {
		const env = realm();
		let calls = 0;
		env.register(env.list, () => calls++);
		env.install();
		env.frames();
		env.document.body.setAttribute("data-scroll-locked", "1");
		env.mutate();
		env.settle();
		env.rootTop();
		expect(calls).toBe(0);
		expect(env.pending()).toBe(0);
		env.document.body.removeAttribute("data-scroll-locked");
		env.mutate();
		env.settle();
		env.hidePage(true);
		env.rootTop();
		env.hidePage(false);
		env.settle();
		expect(calls).toBe(0);
		env.rootTop();
		expect(calls).toBe(1);
	});

	test("last authenticated-shell unmount removes all bridge state and cancels pending work", () => {
		const env = realm();
		env.root.removeAttribute("data-nf-authenticated-app-shell");
		const first = installAuthenticatedAppShellRootLock(env.document);
		const listenersAfterFirstMount = env.listenerCount();
		const second = installAuthenticatedAppShellRootLock(env.document);
		expect(env.listenerCount()).toBe(listenersAfterFirstMount);
		cleanups.push(first, second);
		env.frames();
		expect(env.root.getAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe("true");
		first();
		expect(env.root.getAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe("true");
		env.emit("resize");
		second();
		second();
		env.settle();
		expect(env.root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)).toBe(false);
		expect(env.root.hasAttribute("data-nf-authenticated-app-shell")).toBe(false);
		expect(env.window.scrollY).toBe(0);
		expect(env.listenerCount()).toBe(0);
		expect(env.pending()).toBe(0);
	});
});
