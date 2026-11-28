export const IOS_SCROLL_TO_TOP_ATTRIBUTE = "data-nf-ios-scroll-to-top";
/** AppShell's committed route lifetime; this does not intercept browser history. */
export const IOS_SCROLL_TO_TOP_ROUTE_EVENT = "nf:ios-scroll-to-top-route";

const AUTHENTICATED_ATTRIBUTE = "data-nf-authenticated-app-shell";
const DOM_TARGET_SELECTOR = ".nf-app-shell-main, .mantine-ScrollArea-viewport";
const PRIVATE_SCROLL_SELECTOR =
	'.cm-editor, .monaco-editor, .xterm, [data-terminal], [contenteditable]:not([contenteditable="false"])';
const INPUT_SELECTOR = "textarea, input, select";
const OVERLAY_SELECTOR =
	'[aria-modal="true"], [role="dialog"], .mantine-Modal-content, .mantine-Drawer-content, .mantine-Menu-dropdown, .mantine-Popover-dropdown, .nf-overlay-layer';
const MAX_ANCESTORS = 32;
const MAX_REGISTERED_TARGETS = 128;
const MAX_OVERLAYS = 32;
const SETTLE_MS = 350;
const OFFSET = 1;
const TOLERANCE = 0.25;

type Registration = { callback: () => void; hasUnprocessedScroll?: () => boolean };
const registrations = new WeakMap<Document, Map<HTMLElement, Registration>>();

/** A replacement registration owns its cleanup, even if the previous effect cleans up later. */
export function registerIOSScrollToTopTarget(
	element: HTMLElement,
	onScrollToTop: () => void,
	hasUnprocessedScroll?: () => boolean,
): () => void {
	const owner = element.ownerDocument;
	const targets = registrations.get(owner) ?? new Map<HTMLElement, Registration>();
	registrations.set(owner, targets);
	const registration = { callback: onScrollToTop, hasUnprocessedScroll };
	targets.set(element, registration);
	return () => {
		if (targets.get(element) !== registration) return;
		targets.delete(element);
		if (targets.size === 0) registrations.delete(owner);
	};
}

function ancestors(element: Element | null): HTMLElement[] {
	const path: HTMLElement[] = [];
	for (let node = element; node && path.length < MAX_ANCESTORS; node = node.parentElement) {
		path.push(node as HTMLElement);
	}
	return path;
}

function eventElement(event: Event): HTMLElement | null {
	const target = event.target as Node | null;
	if (!target) return null;
	return (target.nodeType === 1 ? target : target.parentElement) as HTMLElement | null;
}

function isIOS(targetWindow: Window): boolean {
	const { userAgent, platform, maxTouchPoints } = targetWindow.navigator;
	const touch = maxTouchPoints > 0 || "ontouchstart" in targetWindow;
	return (
		(/iPad|iPhone|iPod/.test(userAgent) && touch) ||
		(/Mac/.test(platform ?? "") && /Macintosh/.test(userAgent) && maxTouchPoints > 1)
	);
}

/** Geometry alone admits parked/occluded panels, so every action also requires hit-test exposure. */
function isVisible(element: HTMLElement, targetWindow: Window): boolean {
	if (!element.isConnected) return false;
	const path = ancestors(element);
	if (path[path.length - 1] !== element.ownerDocument.documentElement) return false;
	for (const node of path) {
		if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true")
			return false;
		const style = targetWindow.getComputedStyle(node);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0"
		)
			return false;
	}
	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function isPrivateScroll(element: Element | null): boolean {
	return ancestors(element).some((node) => node.matches(PRIVATE_SCROLL_SELECTOR));
}

function isInput(element: Element | null): boolean {
	return ancestors(element).some((node) => node.matches(INPUT_SELECTOR));
}

function pointsIn(
	element: HTMLElement,
	targetWindow: Window,
	scope: HTMLElement | null = null,
): [number, number][] {
	const rect = element.getBoundingClientRect();
	const clip = scope?.getBoundingClientRect();
	const left = Math.max(0, rect.left, clip?.left ?? 0);
	const top = Math.max(0, rect.top, clip?.top ?? 0);
	const right = Math.min(targetWindow.innerWidth, rect.right, clip?.right ?? Infinity);
	const bottom = Math.min(targetWindow.innerHeight, rect.bottom, clip?.bottom ?? Infinity);
	if (right <= left || bottom <= top) return [];
	return [
		[0.5, 0.5],
		[0.25, 0.25],
		[0.75, 0.25],
		[0.25, 0.75],
		[0.75, 0.75],
	].map(([x, y]) => [left + (right - left) * (x ?? 0.5), top + (bottom - top) * (y ?? 0.5)]);
}

function isExposed(element: HTMLElement, targetWindow: Window, scope: HTMLElement | null): boolean {
	if (!isVisible(element, targetWindow) || (scope && !scope.contains(element))) return false;
	return pointsIn(element, targetWindow, scope).some(([x, y]) => {
		const hit = element.ownerDocument.elementFromPoint(x, y);
		return hit !== null && element.contains(hit);
	});
}

/** Restrict popups to their painted surface, not a zero-sized Portal/Modal wrapper. */
function overlayScope(targetWindow: Window, targetDocument: Document): HTMLElement | null | false {
	const layers = targetDocument.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR);
	if (layers.length > MAX_OVERLAYS) return false;
	const selection: { element: HTMLElement | null; zIndex: number } = {
		element: null,
		zIndex: -Infinity,
	};
	for (const layer of layers) {
		if (!isVisible(layer, targetWindow)) continue;
		const rect = layer.getBoundingClientRect();
		if (
			rect.right <= 0 ||
			rect.bottom <= 0 ||
			rect.left >= targetWindow.innerWidth ||
			rect.top >= targetWindow.innerHeight
		)
			continue;
		const point = pointsIn(layer, targetWindow)[0];
		const hit = point ? targetDocument.elementFromPoint(...point) : null;
		// Covered layers cannot lend their background a scroll target.
		if (!hit || !layer.contains(hit)) continue;
		const z = Number.parseFloat(targetWindow.getComputedStyle(layer).zIndex) || 0;
		if (selection.element?.contains(layer) || z >= selection.zIndex) {
			selection.element = layer;
			selection.zIndex = z;
		}
	}
	// Even a covered modal is a barrier: absence of a usable popup never admits background.
	if (!selection.element && [...layers].some((layer) => isVisible(layer, targetWindow)))
		return false;
	return selection.element;
}

type ScrollAction = { element: HTMLElement; registration?: Registration };

function activeTarget(
	targetWindow: Window,
	targetDocument: Document,
	recent: HTMLElement | null,
): ScrollAction | null {
	if (typeof targetDocument.elementFromPoint !== "function") return null;
	const scope = overlayScope(targetWindow, targetDocument);
	if (scope === false) return null;
	const targets = registrations.get(targetDocument);
	const eligible = (element: HTMLElement) =>
		!isPrivateScroll(element) && !isInput(element) && isExposed(element, targetWindow, scope);
	const fromPath = (element: HTMLElement | null): ScrollAction | null => {
		const path = ancestors(element);
		// The semantic owner must win over a nested ordinary ScrollArea.
		for (const node of path) {
			const registration = targets?.get(node);
			if (registration) return eligible(node) ? { element: node, registration } : null;
		}
		for (const node of path) {
			// Ownership does not disappear when content fits: do not spill into Main.
			if (node.matches(DOM_TARGET_SELECTOR)) return eligible(node) ? { element: node } : null;
		}
		return null;
	};

	if (
		recent &&
		(!recent.isConnected || !isVisible(recent, targetWindow) || (scope && !scope.contains(recent)))
	)
		recent = null;
	if (recent && isPrivateScroll(recent)) return null;
	if (recent && isInput(recent) && ancestors(recent).some((node) => targets?.has(node)))
		return null;
	if (recent) {
		const recentPath = ancestors(recent);
		let best = fromPath(recent);
		if (best?.registration && !isInput(recent)) return best;
		let score = best ? recentPath.indexOf(best.element) : Infinity;
		let tied = false;
		let visited = 0;
		// Bounded registry/ancestor scans, never a query across message rows.
		for (const [element, registration] of targets ?? []) {
			if (++visited > MAX_REGISTERED_TARGETS) {
				best = null;
				break;
			}
			if (!eligible(element)) continue;
			const common = ancestors(element).find((node) => recentPath.includes(node));
			if (
				!common ||
				common === targetDocument.body ||
				common === targetDocument.documentElement ||
				common.classList.contains("nf-app-shell")
			)
				continue;
			const distance = recentPath.indexOf(common);
			if (distance < score || (distance === score && !best?.registration)) {
				best = { element, registration };
				score = distance;
				tied = false;
			} else if (distance === score && best?.element !== element) tied = true;
		}
		if (best && !tied && (!isInput(recent) || best.registration)) return best;
		if (isInput(recent)) return null;
	}

	// No remembered interaction: discover a target from painted viewport coordinates, not DOM order.
	const samples = scope
		? pointsIn(scope, targetWindow)
		: [
				[0.5, 0.4],
				[0.5, 0.65],
				[0.25, 0.4],
				[0.75, 0.4],
				[0.5, 0.85],
			].map(([x, y]) => [
				targetWindow.innerWidth * (x ?? 0.5),
				targetWindow.innerHeight * (y ?? 0.5),
			]);
	for (const [x, y] of samples) {
		const hit = targetDocument.elementFromPoint(x ?? 0, y ?? 0) as HTMLElement | null;
		if (!hit || (scope && !scope.contains(hit))) continue;
		if (isPrivateScroll(hit) || isInput(hit)) return null;
		const action = fromPath(hit);
		if (action) return action;
	}
	return null;
}

/**
 * Preserve a verified native root-scroll range on iOS. A root transition is only a
 * compatibility signal, not proof of a system status-bar tap; WebKit has no DOM event for it.
 * CSS keeps all existing viewport/keyboard heights and compensates the one-pixel root offset.
 */
export function installIOSScrollToTopBridge(
	targetWindow: Window,
	targetDocument: Document,
): () => void {
	const root = targetDocument.documentElement;
	const body = targetDocument.body;
	const scrollingElement = targetDocument.scrollingElement;
	if (
		!root ||
		!body ||
		scrollingElement !== root ||
		!isIOS(targetWindow) ||
		root.getAttribute(AUTHENTICATED_ATTRIBUTE) !== "true" ||
		typeof targetWindow.requestAnimationFrame !== "function" ||
		typeof targetWindow.scrollTo !== "function" ||
		Math.abs(targetWindow.scrollY) > TOLERANCE ||
		typeof targetWindow.getComputedStyle !== "function"
	)
		return () => {};

	type Phase = "paused" | "calibrating" | "armed" | "handling" | "disposed";
	let phase: Phase = "paused";
	let frame = 0;
	let timer = 0;
	let touching = false;
	let gestureSettling = false;
	let pageActive = true;
	let recent: HTMLElement | null = null;
	let armedEnvironment = "";
	let armedViewport = "";
	let observedEnvironment = "";
	const disposers: (() => void)[] = [];
	const visualViewport = targetWindow.visualViewport;

	const viewportKey = () =>
		[
			targetWindow.innerWidth,
			targetWindow.innerHeight,
			visualViewport?.width,
			visualViewport?.height,
			visualViewport?.scale,
			visualViewport?.offsetTop,
			visualViewport?.offsetLeft,
		].join("|");
	const environmentKey = () =>
		[
			root.getAttribute(AUTHENTICATED_ATTRIBUTE),
			root.hasAttribute("data-virtual-keyboard-open"),
			root.style.cssText,
			root.className,
			body.style.cssText,
			body.className,
			body.getAttribute("data-scroll-locked"),
			targetDocument.visibilityState,
			targetWindow.location.href,
		].join("|");
	const blocked = () => {
		const lock = body.getAttribute("data-scroll-locked");
		return (
			!pageActive ||
			touching ||
			targetDocument.visibilityState === "hidden" ||
			root.getAttribute(AUTHENTICATED_ATTRIBUTE) !== "true" ||
			root.hasAttribute("data-virtual-keyboard-open") ||
			isInput(targetDocument.activeElement) ||
			isPrivateScroll(targetDocument.activeElement) ||
			(lock !== null && lock !== "0") ||
			[body, root].some((node) =>
				/^(hidden|clip)$/.test(node.style.overflowY || node.style.overflow),
			) ||
			(root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE) &&
				!/^(auto|scroll)$/.test(targetWindow.getComputedStyle(root).overflowY)) ||
			targetWindow.getComputedStyle(body).position === "fixed" ||
			Math.abs((visualViewport?.scale ?? 1) - 1) > 0.01 ||
			Math.abs(visualViewport?.offsetTop ?? 0) > TOLERANCE ||
			Math.abs(visualViewport?.offsetLeft ?? 0) > TOLERANCE
		);
	};
	const cancelWork = () => {
		if (frame) targetWindow.cancelAnimationFrame(frame);
		if (timer) targetWindow.clearTimeout(timer);
		frame = 0;
		timer = 0;
	};
	const writeOffset = (top: number) => {
		try {
			targetWindow.scrollTo({ top, left: targetWindow.scrollX, behavior: "instant" });
			return true;
		} catch {
			return false;
		}
	};
	const removeOffset = () => {
		if (!root.hasAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE)) return;
		root.removeAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE);
		writeOffset(0);
	};
	const pause = () => {
		if (phase === "disposed") return;
		phase = "paused";
		cancelWork();
		removeOffset();
	};
	const dispose = () => {
		if (phase === "disposed") return;
		phase = "disposed";
		cancelWork();
		for (const cleanup of disposers.splice(0)) cleanup();
		removeOffset();
		recent = null;
	};
	const nextFrame = (callback: () => void) => {
		frame = targetWindow.requestAnimationFrame(() => {
			frame = 0;
			if (phase !== "disposed") callback();
		});
	};
	const calibrate = () => {
		if (phase === "disposed") return;
		pause();
		gestureSettling = false;
		if (blocked()) return;
		phase = "calibrating";
		nextFrame(() => {
			if (blocked()) {
				pause();
				return;
			}
			const before = body.getBoundingClientRect().top;
			root.setAttribute(IOS_SCROLL_TO_TOP_ATTRIBUTE, "true");
			const range = scrollingElement.scrollHeight - scrollingElement.clientHeight;
			const overflow = targetWindow.getComputedStyle(root).overflowY;
			if (
				!Number.isFinite(range) ||
				range < OFFSET - TOLERANCE ||
				range > OFFSET + 1 ||
				(overflow !== "auto" && overflow !== "scroll")
			) {
				dispose();
				return;
			}
			if (!writeOffset(OFFSET)) {
				dispose();
				return;
			}
			nextFrame(() => {
				if (blocked()) {
					pause();
					return;
				}
				if (
					Math.abs(targetWindow.scrollY - OFFSET) > TOLERANCE ||
					Math.abs(body.getBoundingClientRect().top - before) > TOLERANCE
				) {
					dispose();
					return;
				}
				// Drain initialization/own scroll delivery before accepting a zero transition.
				nextFrame(() => {
					if (blocked()) {
						pause();
						return;
					}
					if (Math.abs(targetWindow.scrollY - OFFSET) > TOLERANCE) {
						dispose();
						return;
					}
					armedEnvironment = environmentKey();
					armedViewport = viewportKey();
					observedEnvironment = armedEnvironment;
					phase = "armed";
				});
			});
		});
	};
	const settle = () => {
		if (phase === "disposed") return;
		pause();
		timer = targetWindow.setTimeout(() => {
			timer = 0;
			calibrate();
		}, SETTLE_MS);
	};
	const onRootScroll = (event: Event) => {
		if (
			event.target !== targetWindow &&
			event.target !== targetDocument &&
			event.target !== root &&
			event.target !== body
		)
			return;
		if (gestureSettling) {
			settle();
			return;
		}
		if (phase !== "armed") return;
		if (blocked() || environmentKey() !== armedEnvironment || viewportKey() !== armedViewport) {
			settle();
			return;
		}
		const y = targetWindow.scrollY;
		if (Math.abs(y - OFFSET) <= TOLERANCE) return;
		if (Math.abs(y) > TOLERANCE) {
			settle();
			return;
		}
		phase = "handling";
		const action = activeTarget(targetWindow, targetDocument, recent);
		try {
			if (action?.registration) action.registration.callback();
			else if (action) {
				if (typeof action.element.scrollTo === "function") {
					action.element.scrollTo({ top: 0, behavior: "instant" });
				} else action.element.scrollTop = 0;
			}
		} finally {
			// Keep the native range withdrawn while the same status-bar animation can still
			// report zero. Its late frames must not become a second action after our rearm.
			// Removing both offsets synchronously avoids painting the temporary +1px body.
			settle();
		}
	};
	const remember = (event: Event) => {
		recent = eventElement(event);
	};
	const startGesture = (event: Event) => {
		remember(event);
		touching = true;
		gestureSettling = true;
		pause();
	};
	const endGesture = () => {
		touching = false;
		gestureSettling = true;
		settle();
	};
	const pointerDown = (event: Event) => {
		remember(event);
		if (
			(event as PointerEvent).pointerType === "touch" ||
			(event as PointerEvent).pointerType === "pen"
		)
			startGesture(event);
	};
	const pointerUp = (event: Event) => {
		if (
			(event as PointerEvent).pointerType === "touch" ||
			(event as PointerEvent).pointerType === "pen"
		)
			endGesture();
	};
	const onContentScroll = (event: Event) => {
		if (!gestureSettling || touching) return;
		const target = eventElement(event);
		if (
			target &&
			registrations.get(targetDocument)?.get(target)?.hasUnprocessedScroll?.() === false
		)
			return;
		settle();
	};
	const onFocus = (event: Event) => {
		remember(event);
		settle();
	};
	const onRoute = () => {
		recent = null;
		settle();
	};
	const onViewportScroll = () => {
		// Native root scrolling may emit visualViewport.scroll without changing its metrics.
		// Only changed metrics suspend; this event can never dispatch a scroll-to-top action.
		if (viewportKey() !== armedViewport) settle();
	};
	const listen = (target: EventTarget, type: string, listener: EventListener, capture = false) => {
		target.addEventListener(type, listener, { passive: true, capture });
		disposers.push(() => target.removeEventListener(type, listener, { capture }));
	};
	listen(targetWindow, "scroll", onRootScroll);
	for (const type of ["resize", "orientationchange", "popstate", "hashchange"])
		listen(targetWindow, type, onRoute);
	listen(targetWindow, "pagehide", () => {
		pageActive = false;
		touching = false;
		pause();
	});
	listen(targetWindow, "pageshow", () => {
		pageActive = true;
		touching = false;
		onRoute();
	});
	listen(targetWindow, "blur", () => {
		pageActive = false;
		touching = false;
		pause();
	});
	listen(targetWindow, "focus", () => {
		pageActive = true;
		settle();
	});
	listen(targetDocument, "visibilitychange", () => {
		touching = false;
		if (targetDocument.visibilityState === "hidden") pause();
		else {
			pageActive = true;
			onRoute();
		}
	});
	listen(targetDocument, IOS_SCROLL_TO_TOP_ROUTE_EVENT, onRoute);
	listen(targetDocument, "pointerdown", pointerDown, true);
	listen(targetDocument, "pointerup", pointerUp, true);
	listen(targetDocument, "pointercancel", pointerUp, true);
	listen(targetDocument, "touchstart", startGesture, true);
	listen(targetDocument, "touchmove", startGesture, true);
	listen(targetDocument, "touchend", endGesture, true);
	listen(targetDocument, "touchcancel", endGesture, true);
	listen(
		targetDocument,
		"wheel",
		(event) => {
			remember(event);
			gestureSettling = true;
			settle();
		},
		true,
	);
	listen(targetDocument, "scroll", onContentScroll, true);
	listen(targetDocument, "focusin", onFocus, true);
	listen(targetDocument, "focusout", onFocus, true);
	if (visualViewport) {
		listen(visualViewport, "resize", settle);
		listen(visualViewport, "scroll", onViewportScroll);
	}
	const Observer = (targetWindow as Window & typeof globalThis).MutationObserver;
	if (typeof Observer === "function") {
		observedEnvironment = environmentKey();
		const observer = new Observer(() => {
			const next = environmentKey();
			if (next === observedEnvironment) return;
			observedEnvironment = next;
			settle();
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: [AUTHENTICATED_ATTRIBUTE, "data-virtual-keyboard-open", "style", "class"],
		});
		observer.observe(body, {
			attributes: true,
			attributeFilter: ["style", "class", "data-scroll-locked"],
		});
		disposers.push(() => observer.disconnect());
	}
	calibrate();
	return dispose;
}
