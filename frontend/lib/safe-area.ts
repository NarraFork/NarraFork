import type { CSSProperties } from "react";

export const SAFE_AREA_INSET_TOP = "env(safe-area-inset-top, 0px)";
export const SAFE_AREA_INSET_LEFT = "env(safe-area-inset-left, 0px)";
export const SAFE_AREA_INSET_RIGHT = "env(safe-area-inset-right, 0px)";
export const PHYSICAL_SAFE_AREA_INSET_BOTTOM = "env(safe-area-inset-bottom, 0px)";
export const SAFE_AREA_INSET_BOTTOM = `var(--app-safe-area-inset-bottom, ${PHYSICAL_SAFE_AREA_INSET_BOTTOM})`;
/**
 * The visible bottom edge of the app.
 *
 * The tracker publishes this from the engine's own dynamic viewport (`100dvh`),
 * which is resolved in the same coordinate system as `env(safe-area-inset-*)`.
 * `visualViewport.height` only ever *shrinks* it, and only while the virtual
 * keyboard is up — the one occlusion iOS does not fold into `dvh`. `100dvh` is
 * also the no-JS fallback, so the two paths agree by construction.
 */
export const APP_VIEWPORT_BOTTOM = "var(--app-viewport-bottom, 100dvh)";

export const AUTHENTICATED_APP_SHELL_ATTRIBUTE = "data-nf-authenticated-app-shell";
export const APP_SHELL_CLASSNAME = "nf-app-shell";
export const APP_SHELL_MAIN_CLASSNAME = "nf-app-shell-main";
export const APP_SHELL_MAIN_ID = "nf-app-main";

export const TOP_NOTIFICATION_SAFE_AREA_CLASSNAME = "nf-notifications-safe-area";

export const TOP_BANNER_SAFE_AREA_STYLE = {
	top: `calc(8px + ${SAFE_AREA_INSET_TOP})`,
} satisfies CSSProperties;

/**
 * The Navbar is the one layer that still names the viewport, because it cannot
 * derive from the shell.
 *
 * Mantine's `layout="alt"` forces `top: 0; height: 100dvh` on it, so both have to
 * be overridden. And the Navbar is `position: fixed`, whose containing block is
 * the initial containing block — not `.nf-app-shell`. So the `height: 100%`
 * derivation the route layer moved to resolves here against the *full* viewport
 * instead of `html`'s height, and stops tracking the shell exactly when the shell
 * stops equalling the viewport: measured 107px/60px of overhang past the visible
 * bottom at rest, and 443px/396px with the virtual keyboard up (390x844 top=47 and
 * 414x736 insets=0, headless Chromium with the insets overridden). `100%` minus the
 * top offset, and `100dvh` minus it, are both correct at rest and still overhang by
 * 336px while the keyboard is up, since neither follows the published height.
 *
 * What makes naming the viewport safe here — and different from the route-layer
 * subtractions this replaced — is that the subtrahend is the *same token* as the
 * Navbar's own `top`, not a second, independently resolved quantity. `top +
 * height` collapses to the visible bottom whatever those tokens resolve to, so a
 * wrong assumption about one of them cannot leave a gap; the route-layer bug
 * needed two terms from two coordinate systems to compound. Measured error was 0
 * across both breakpoints, both viewports, keyboard open/closed, iOS visual-
 * viewport panning, and all seven candidate `visualViewport.height` semantics.
 *
 * So `top` and the height must stay in lockstep. On mobile both are Mantine's
 * `--app-shell-header-offset`, which is its own resolution of `header.height` and
 * therefore already carries the top inset (`calc(60px + env(top))`, measured 107px
 * on a 47px-inset device) — the Header owns that inset and the Navbar clears all of
 * it. At the desktop breakpoint the Navbar is its own full-height column beside the
 * Header, so both terms are the physical top inset, which is 0 on ordinary desktops.
 */
export const APP_SHELL_HEADER_OFFSET = "var(--app-shell-header-offset, 60px)";
export const APP_SHELL_HEADER_HEIGHT = `calc(60px + ${SAFE_AREA_INSET_TOP})`;
export const APP_SHELL_MOBILE_NAVBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${APP_SHELL_HEADER_OFFSET})`;
export const APP_SHELL_DESKTOP_NAVBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${SAFE_AREA_INSET_TOP})`;

/**
 * Bottom gutter for the scroll container: `max()`, not a sum.
 *
 * `100dvh` extends to the *physical* bottom of the screen. Measured on an iPhone 11 PWA:
 * `100lvh` 896 − `100dvh` 847.984 = 48.016 ≡ `env(safe-area-inset-top)` 48, and
 * `screen.height` 896 − 48 = 848 ≈ `100dvh`. So the engine only excludes the top inset —
 * the home indicator strip is inside the dynamic viewport, and content may paint there.
 *
 * Adding the bottom inset to a spacing value therefore reserved that strip twice: once by
 * `100dvh` already reaching past it, once by the padding. That produced 50px of dead space
 * below the last row where only the 34px indicator clearance was intended.
 *
 * `max()` keeps whichever gutter is larger: the home indicator clearance where one exists
 * (Apple HIG — content under the gesture strip reads badly and is harder to hit), and the
 * ordinary `md` gutter on desktop and on devices with no inset, where `env()` is 0.
 */
export const APP_SHELL_MAIN_PADDING_BOTTOM = `max(var(--mantine-spacing-md), ${SAFE_AREA_INSET_BOTTOM})`;

/**
 * The same `max()` rule for the Navbar, whose base gutter is not always `md`.
 *
 * The Navbar had the additive form this rule exists to remove, split across two
 * declarations so neither looked wrong on its own: a `data-safe-area="bottom"`
 * spacer of exactly `env(safe-area-inset-bottom)`, *plus* the Navbar's own
 * symmetric padding underneath it. Measured on iPhone 11 PWA metrics (414x896,
 * insets 48/34, headless Chromium with the insets overridden): last nav row ended
 * at y=846 against a visible bottom of 896 — a 50px gutter where 34px of home-
 * indicator clearance was intended, the same 50px this file already documents for
 * Main. The Navbar is `position: fixed`, so it never pushed Main's content; it was
 * a second, independent reservation of the same strip inside its own box.
 *
 * The spacer is now the Navbar's only bottom gutter and the Navbar declares no
 * `padding-bottom` (it uses `px`/`pt`, not `p`, so there is no precedence question
 * between the two). `basePadding` is whatever gutter that state would have used, so
 * every no-inset case is unchanged: `max(4px, 0px)` is still 4px on a collapsed
 * desktop nav, `max(0px, 0px)` still 0 in the wizard.
 */
export function appShellNavbarBottomGutter(basePadding: string): string {
	return `max(${basePadding}, ${SAFE_AREA_INSET_BOTTOM})`;
}

export const APP_SHELL_SAFE_HEADER_STYLE = {
	boxSizing: "border-box",
	paddingTop: SAFE_AREA_INSET_TOP,
} satisfies CSSProperties;

export const NARRATOR_STATUS_INLINE_STYLE = {
	boxSizing: "border-box",
	width: "100%",
	minWidth: 0,
} satisfies CSSProperties;

export const NARRATOR_STATUS_SAFE_INLINE_STYLE = {
	...NARRATOR_STATUS_INLINE_STYLE,
	paddingInlineStart: SAFE_AREA_INSET_LEFT,
	paddingInlineEnd: SAFE_AREA_INSET_RIGHT,
} satisfies CSSProperties;

export function getNarratorStatusInlineStyle(ownsHorizontalSafeArea = false): CSSProperties {
	return ownsHorizontalSafeArea ? NARRATOR_STATUS_SAFE_INLINE_STYLE : NARRATOR_STATUS_INLINE_STYLE;
}

/**
 * Full-height AppShell route content, derived rather than recomputed.
 *
 * These used to be `calc(viewport − header − bottom-inset)`, which mixed two
 * coordinate systems: `visualViewport.height` is a WebKit runtime measurement,
 * `env(safe-area-inset-*)` is a static CSS value, and nothing contracts whether
 * the former already excludes the latter. Whenever that unverified assumption was
 * wrong the subtraction happened twice and the shortfall showed up as a large
 * blank band under the page (measured 34px when the assumption held, 81–158px
 * when it did not).
 *
 * `.nf-app-shell-main` is now the single owner of the header offset and the
 * bottom inset (its padding box), and it fills the shell height. So route content
 * only has to fill its parent: `100%` of Main's content box is already inset-
 * correct, in one coordinate system, with no subtraction to get wrong.
 *
 * The full-bleed variant additionally cancels Main's padding, which the routes
 * that use it already do with negative margins.
 *
 * APP_SHELL_CONTENT_HEIGHT fills Main's content box; it is already clear of the
 * header and the bottom inset because Main's padding expresses both.
 */
export const APP_SHELL_CONTENT_HEIGHT = "100%";
/**
 * Fills Main's content box *plus* its symmetric `md` gutter, for routes that cancel
 * that gutter with negative margins to draw edge to edge. It stops short of the
 * header offset and the bottom inset, which are the asymmetric part of Main's
 * padding and stay reserved.
 */
export const APP_SHELL_FULL_BLEED_HEIGHT = "calc(100% + var(--mantine-spacing-md) * 2)";

/**
 * How much of the dynamic viewport must be occluded before it reads as a keyboard.
 *
 * Both terms are load-bearing, and which one binds depends on the device — the
 * floor is not redundant with the ratio. Measured: iPhone 11 PWA `dvh` 847.984
 * makes the ratio 152.6 and the ratio binds; iPhone 8 Plus `dvh` 617 makes it
 * 111.1, below the floor, so 120 binds there. Real occlusions clear whichever
 * bound applies by ~2.2-2.4x (362px and 258px respectively), so the pair has
 * margin on both without either term being reachable-only-in-theory.
 */
const KEYBOARD_MIN_OCCLUSION_PX = 120;
const KEYBOARD_MIN_OCCLUSION_RATIO = 0.18;
/**
 * How far the dynamic viewport may fall short of the large viewport before the
 * gap counts as real browser chrome rather than rounding noise. Sub-pixel
 * disagreement is routine on iOS (halves and thirds); a toolbar never is.
 */
const VIEWPORT_CHROME_TOLERANCE_PX = 1;

export interface AppViewportMeasurement {
	/**
	 * The engine's dynamic viewport height (CSS `100dvh`), which already accounts
	 * for retracted browser chrome and is expressed in the same coordinate system
	 * as `env(safe-area-inset-*)`.
	 */
	dynamicViewportHeight: number;
	/** The engine's large viewport height (CSS `100lvh`): chrome-retracted, full screen. */
	largeViewportHeight: number;
	/**
	 * The engine's `env(safe-area-inset-top)`.
	 *
	 * Needed because `100lvh` measures the *screen*, top inset included, while
	 * `100dvh` starts below it — so their difference is not the bottom chrome on
	 * its own. See `resolveAppViewportState`. Absent is read as 0, which is what
	 * every non-inset device reports anyway.
	 */
	topInset?: number;
	visualViewportHeight?: number;
	visualViewportOffsetTop?: number;
	editableFocused: boolean;
	virtualKeyboardCapable: boolean;
	/** True in PWA/standalone display modes, where no browser toolbar can occlude. */
	standalone: boolean;
}

export interface AppViewportState {
	/**
	 * Visible bottom edge in layout coordinates. Equals the dynamic viewport
	 * except while the virtual keyboard shrinks the visual viewport.
	 */
	viewportBottom: number;
	keyboardVisible: boolean;
	/**
	 * Whether the visible viewport reaches the physical bottom of the screen. False
	 * when a browser toolbar sits over the home indicator, in which case that inset
	 * describes space outside the visible viewport and must not be subtracted.
	 */
	reachesPhysicalBottom: boolean;
}

function positiveFinite(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The fallback a CSS length falls back to when the engine drops the expression.
 *
 * `height` is assigned twice in the probe, so an expression CSSOM rejects leaves
 * this value behind instead of collapsing to `auto`. A viewport unit falls back
 * to `100vh`, which on engines without `dvh`/`lvh` *is* the large viewport and so
 * the right approximation. An `env()` inset must fall back to `0px` instead: an
 * engine with no `env()` support has no insets to report, and inheriting `100vh`
 * there would be read as a screen-tall top inset, which cancels the toolbar
 * detection in `resolveAppViewportState` outright.
 */
function cssLengthFallback(expression: string): string {
	return expression.trimStart().startsWith("env(") ? "0px" : "100vh";
}

/**
 * Measure a CSS length by laying it out, so viewport units are resolved by the
 * engine instead of being reconstructed from JS numbers.
 */
export function measureCssViewportHeight(
	targetDocument: Document,
	unit: string,
	fallbackUnit = cssLengthFallback(unit),
): number {
	const body = targetDocument.body;
	if (!body?.append) return 0;
	const probe = targetDocument.createElement("div");
	probe.setAttribute("aria-hidden", "true");
	probe.setAttribute("data-nf-viewport-probe", unit);
	probe.style.cssText =
		"position:fixed;top:0;left:0;width:0;padding:0;border:0;margin:0;" +
		"visibility:hidden;pointer-events:none;contain:strict;";
	probe.style.height = fallbackUnit;
	probe.style.height = unit;
	body.append(probe);
	const height = probe.getBoundingClientRect?.().height ?? 0;
	probe.remove();
	return Number.isFinite(height) ? height : 0;
}

/**
 * Snap the published shell height up to a whole CSS pixel.
 *
 * Scope: this now applies to the keyboard case only, because that is the only
 * time `--app-viewport-bottom` is published at all. At rest the engine's own
 * `100dvh` governs, and the engine is happy to resolve it to a fraction — an
 * iPhone 11 PWA reports `100dvh` 847.984 and lays `html` out at 847.984375px
 * with no seam, because every layer below derives from that same used height
 * with `height: 100%`.
 *
 * The keyboard case is different in that the published value is a JS sum
 * (`visualViewport.height + offsetTop`) that iOS reports in fractional CSS
 * pixels — halves and thirds are both routine on the same device. Measured on
 * an iPhone 8 Plus in Safari: 358.65625 + 42.65625 = 401.3125, published as
 * `402px`. That report is the one real-device sample where this rounding
 * actually changed the value; the other two keyboard samples (617, 557) were
 * already whole.
 *
 * Whole CSS pixels are also the only values that survive layout exactly: both
 * engines round a used height down to an internal 1/64px grid, so publishing
 * `735.6667px` lays out as `735.6563px` and any sub-pixel seam it opens stays
 * open. Device-pixel granularity is not enough for the same reason.
 *
 * Rounding *up* is what keeps this safe: the edge only ever moves outward, by
 * less than one CSS pixel, so the shell can never stop above the visible bottom
 * — that shortfall is the unreachable-dead-space bug the tracker already guards
 * against, and it is far more visible than a sub-pixel overhang.
 */
export function snapViewportBottomForPaint(viewportBottom: number): number {
	return Number.isFinite(viewportBottom) ? Math.ceil(viewportBottom) : viewportBottom;
}

/**
 * Resolve the visible bottom edge from the engine's own viewport units, using
 * `visualViewport` only for the one thing those units do not express.
 *
 * The dynamic viewport (`100dvh`) is already the visible height with browser
 * chrome accounted for, in the same coordinate system as `env(safe-area-inset-*)`.
 * So it is the baseline, and no layer needs to guess whether a JS-reported height
 * includes the insets. `visualViewport` contributes exactly two facts:
 *
 *  - the virtual keyboard, which iOS does *not* fold into `dvh`: it shrinks the
 *    visual viewport instead, so a large shortfall against `dvh` while an editable
 *    control has focus is a keyboard.
 *  - panning, when iOS scrolls the visual viewport to keep a focused input on
 *    screen; `offsetTop` puts the visible bottom back into layout coordinates.
 *
 * Everything else the old implementation tracked (retained maxima, rotation
 * detection, sub-pixel clamping against `innerHeight`) existed to reconstruct the
 * visible height from two disagreeing JS numbers. Reading `dvh` measures it
 * directly instead, so a stale or out-of-sync `innerHeight` can no longer move
 * the shell at all.
 */
export function resolveAppViewportState(
	measurement: AppViewportMeasurement,
	previous?: AppViewportState,
): AppViewportState {
	const dynamicHeight = positiveFinite(
		measurement.dynamicViewportHeight,
		previous?.viewportBottom ?? 1,
	);
	const largeHeight = positiveFinite(measurement.largeViewportHeight, dynamicHeight);
	const visualHeight = positiveFinite(measurement.visualViewportHeight, dynamicHeight);
	const visualOffsetTop = Math.max(0, measurement.visualViewportOffsetTop ?? 0);

	// Only an occlusion the engine did not already account for matters here, and it
	// only counts while something is focused (or a keyboard was already up), so
	// toolbar animation frames can never masquerade as a keyboard.
	const occludedHeight = Math.max(0, dynamicHeight - visualHeight);
	const keyboardThreshold = Math.max(
		KEYBOARD_MIN_OCCLUSION_PX,
		dynamicHeight * KEYBOARD_MIN_OCCLUSION_RATIO,
	);
	const keyboardVisible =
		measurement.virtualKeyboardCapable &&
		occludedHeight >= keyboardThreshold &&
		(measurement.editableFocused || previous?.keyboardVisible === true);

	// While the keyboard is up the visual viewport is the visible region, and iOS may
	// pan it; otherwise `dvh` is authoritative and `visualViewport` is ignored so it
	// can never shrink the shell below what the engine says is visible.
	const viewportBottom = keyboardVisible
		? Math.max(1, visualHeight + visualOffsetTop)
		: dynamicHeight;

	// Does the visible viewport actually extend to the physical bottom of the screen?
	// `env(safe-area-inset-bottom)` describes the home indicator's position relative
	// to the *screen*. In Safari browser mode the bottom toolbar covers that strip, so
	// it lies outside the visible viewport and subtracting it removes space that was
	// never there.
	//
	// `lvh - dvh` alone does not state that. The two units do not share an origin:
	// `100lvh` is the full screen box, top inset included, while `100dvh` begins below
	// the top inset. So their difference is `topInset + bottomChrome`, and on a device
	// with a notch it is non-zero with no toolbar present at all. Measured on an
	// iPhone 11 installed PWA: lvh 896, dvh 847.984, difference 48.016 against a 48px
	// top inset — a phantom "toolbar" the width of the notch. Subtracting the top inset
	// first leaves 0.016px, correctly reading as no chrome. The same subtraction leaves
	// iPhone 8 Plus Safari untouched (lvh 693.656, dvh 617, top inset 0 → 76.656px),
	// which is a real toolbar.
	//
	// `100svh` cannot substitute: measured `dvh - svh = 0` on both devices, in browser
	// mode with toolbars up and in standalone, so it carries no bottom-chrome signal
	// here at all.
	//
	// `standalone` is not a second opinion about the measurement — it is what keeps this
	// verdict consistent with the height the stylesheet has *already committed to*.
	// safe-area.css switches `html`'s basis to `100lvh` on `@media (display-mode:
	// standalone)` alone, unconditionally and with no measurement involved, so at rest an
	// installed PWA's shell always spans the full panel and therefore always reaches the
	// physical bottom. If this function derived a different answer there, the inset would
	// be dropped underneath a shell that does reach the indicator, putting content beneath
	// it. The measured numbers happen to agree (iPhone 11 PWA leaves 0.016px), so the term
	// is inert on every device sampled; it is load-bearing as the guarantee that JS cannot
	// disagree with the CSS branch, not as a guess about engine quirks.
	//
	// The keyboard case is folded in for the same reason it always was: the keyboard
	// covers the home indicator, so reserving space for it above the keyboard is wrong.
	const topInset = Math.max(0, measurement.topInset ?? 0);
	const bottomChromeHeight = largeHeight - dynamicHeight - topInset;
	const noChromeOccludingBottom =
		measurement.standalone || bottomChromeHeight <= VIEWPORT_CHROME_TOLERANCE_PX;
	const reachesPhysicalBottom = !keyboardVisible && noChromeOccludingBottom;

	return { viewportBottom, keyboardVisible, reachesPhysicalBottom };
}

function isEditableViewportTarget(element: Element | null): boolean {
	if (!element) return false;
	if ((element as HTMLElement).isContentEditable) return true;
	const tagName = element.tagName.toLowerCase();
	if (tagName === "textarea" || tagName === "select") return true;
	if (tagName !== "input") return false;
	const input = element as HTMLInputElement;
	if (input.disabled || input.readOnly) return false;
	return ![
		"button",
		"checkbox",
		"color",
		"file",
		"hidden",
		"image",
		"radio",
		"range",
		"reset",
		"submit",
	].includes(input.type);
}

function supportsVirtualKeyboard(targetWindow: Window): boolean {
	return (
		targetWindow.navigator.maxTouchPoints > 0 ||
		targetWindow.matchMedia?.("(pointer: coarse)").matches === true ||
		/iPad|iPhone|iPod|Android/i.test(targetWindow.navigator.userAgent)
	);
}

/** Installed PWA surfaces have no retractable browser chrome. */
function isStandaloneDisplay(targetWindow: Window): boolean {
	if (targetWindow.matchMedia?.("(display-mode: standalone)").matches === true) return true;
	if (targetWindow.matchMedia?.("(display-mode: fullscreen)").matches === true) return true;
	// iOS Safari's non-standard flag, still the only signal in older home-screen apps.
	return (targetWindow.navigator as { standalone?: boolean }).standalone === true;
}

const authenticatedAppShellMounts = new WeakMap<Document, number>();

/** Mark the authenticated AppShell lifetime without competing with overlay inline styles. */
export function installAuthenticatedAppShellRootLock(
	targetDocument: Document = document,
): () => void {
	const root = targetDocument.documentElement;
	const nextMounts = (authenticatedAppShellMounts.get(targetDocument) ?? 0) + 1;
	authenticatedAppShellMounts.set(targetDocument, nextMounts);
	root.setAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE, "true");

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const remainingMounts = Math.max(0, (authenticatedAppShellMounts.get(targetDocument) ?? 1) - 1);
		if (remainingMounts > 0) {
			authenticatedAppShellMounts.set(targetDocument, remainingMounts);
			return;
		}
		authenticatedAppShellMounts.delete(targetDocument);
		root.removeAttribute(AUTHENTICATED_APP_SHELL_ATTRIBUTE);
	};
}

/**
 * Own the two root-level mobile layout variables for the whole AppShell.
 * Consumers only read SAFE_AREA_INSET_BOTTOM / APP_VIEWPORT_BOTTOM; no child
 * panel should separately subtract keyboard height or add Home Indicator space.
 */
export function installAppViewportTracking(
	targetWindow: Window = window,
	targetDocument: Document = document,
	/**
	 * How a CSS viewport unit is resolved to pixels. Defaults to laying out a probe
	 * element, which needs a real layout engine; tests substitute the two heights
	 * directly so they can state the engine's answer instead of simulating it.
	 */
	measureViewportUnit: (unit: string) => number = (unit) =>
		measureCssViewportHeight(targetDocument, unit),
): () => void {
	const root = targetDocument.documentElement;
	const visualViewport = targetWindow.visualViewport;
	let state: AppViewportState | undefined;
	let animationFrame = 0;
	const settleTimers = new Set<number>();
	let disposed = false;

	const update = () => {
		animationFrame = 0;
		if (disposed) return;
		// The fixed probes declare dvh/lvh explicitly: they measure the viewport,
		// not html's overridden height. Keep the current shell height during these
		// synchronous layout reads. Removing it here temporarily expands the message
		// viewport and clamps scrollTop; restoring the same height afterward cannot
		// restore that position (and the scroll frame sees no height change).
		const dynamicViewportHeight = measureViewportUnit("100dvh");
		const largeViewportHeight = measureViewportUnit("100lvh");
		// Measured the same way as the two viewport units so all three land in one
		// coordinate system; `lvh - dvh` is only a chrome signal once this is removed.
		const topInset = measureViewportUnit("env(safe-area-inset-top, 0px)");

		state = resolveAppViewportState(
			{
				dynamicViewportHeight,
				largeViewportHeight,
				topInset,
				visualViewportHeight: visualViewport?.height,
				visualViewportOffsetTop: visualViewport?.offsetTop,
				editableFocused: isEditableViewportTarget(targetDocument.activeElement),
				virtualKeyboardCapable: supportsVirtualKeyboard(targetWindow),
				standalone: isStandaloneDisplay(targetWindow),
			},
			state,
		);

		// Only publish an override when it differs from the `100dvh` fallback the CSS
		// already uses; leaving the variable unset keeps the engine's own value, which
		// stays live across chrome transitions with no JS involved.
		if (state.keyboardVisible) {
			root.style.setProperty(
				"--app-viewport-bottom",
				`${snapViewportBottomForPaint(state.viewportBottom)}px`,
			);
		} else {
			root.style.removeProperty("--app-viewport-bottom");
		}
		// `env(safe-area-inset-bottom)` positions the home indicator against the
		// physical screen. Publish it only when the visible viewport actually reaches
		// that edge; behind a browser toolbar (or above the keyboard) the strip is not
		// in the visible viewport and reserving it removes space that does not exist.
		root.style.setProperty(
			"--app-safe-area-inset-bottom",
			state.reachesPhysicalBottom ? PHYSICAL_SAFE_AREA_INSET_BOTTOM : "0px",
		);
		root.toggleAttribute("data-virtual-keyboard-open", state.keyboardVisible);
	};

	const scheduleUpdate = () => {
		if (disposed || animationFrame !== 0) return;
		animationFrame = targetWindow.requestAnimationFrame(update);
	};
	const scheduleSettledUpdates = () => {
		scheduleUpdate();
		for (const timer of settleTimers) targetWindow.clearTimeout(timer);
		settleTimers.clear();
		for (const delay of [60, 250, 500]) {
			const timer = targetWindow.setTimeout(() => {
				settleTimers.delete(timer);
				scheduleUpdate();
			}, delay);
			settleTimers.add(timer);
		}
	};

	const onViewportChange = () => scheduleUpdate();
	const onWindowResize = () => scheduleSettledUpdates();
	const onFocusChange = () => scheduleSettledUpdates();
	const onPageShow = () => scheduleSettledUpdates();

	visualViewport?.addEventListener("resize", onViewportChange);
	visualViewport?.addEventListener("scroll", onViewportChange);
	targetWindow.addEventListener("resize", onWindowResize);
	targetWindow.addEventListener("orientationchange", onWindowResize);
	targetWindow.addEventListener("pageshow", onPageShow);
	targetDocument.addEventListener("focusin", onFocusChange);
	targetDocument.addEventListener("focusout", onFocusChange);
	targetDocument.addEventListener("visibilitychange", onPageShow);
	update();

	return () => {
		disposed = true;
		visualViewport?.removeEventListener("resize", onViewportChange);
		visualViewport?.removeEventListener("scroll", onViewportChange);
		targetWindow.removeEventListener("resize", onWindowResize);
		targetWindow.removeEventListener("orientationchange", onWindowResize);
		targetWindow.removeEventListener("pageshow", onPageShow);
		targetDocument.removeEventListener("focusin", onFocusChange);
		targetDocument.removeEventListener("focusout", onFocusChange);
		targetDocument.removeEventListener("visibilitychange", onPageShow);
		if (animationFrame !== 0) targetWindow.cancelAnimationFrame(animationFrame);
		for (const timer of settleTimers) targetWindow.clearTimeout(timer);
		settleTimers.clear();
		root.style.removeProperty("--app-viewport-bottom");
		root.style.removeProperty("--app-safe-area-inset-bottom");
		root.removeAttribute("data-virtual-keyboard-open");
	};
}

export function safeAreaDrawerHeaderHeight(baseHeightPx: number): string {
	return `calc(${baseHeightPx}px + ${SAFE_AREA_INSET_TOP})`;
}

export function safeAreaDrawerBodyHeight(headerHeightPx: number): string {
	return `calc(100% - ${headerHeightPx}px - ${SAFE_AREA_INSET_TOP})`;
}

export function safeAreaDrawerHeaderPaddingTop(basePaddingPx: number): string {
	return `calc(${basePaddingPx}px + ${SAFE_AREA_INSET_TOP})`;
}

export const SAFE_AREA_DEFAULT_DRAWER_HEADER_STYLE = {
	paddingTop: `calc(var(--mantine-spacing-md) + ${SAFE_AREA_INSET_TOP})`,
} satisfies CSSProperties;

export const SAFE_AREA_DRAWER_BODY_STYLE = {
	boxSizing: "border-box",
	paddingBottom: SAFE_AREA_INSET_BOTTOM,
} satisfies CSSProperties;

export const SAFE_AREA_PADDED_DRAWER_BODY_STYLE = {
	boxSizing: "border-box",
	paddingBottom: `calc(var(--mantine-spacing-md) + ${SAFE_AREA_INSET_BOTTOM})`,
} satisfies CSSProperties;

const MODAL_BASE_PADDING = "var(--mb-padding, var(--mantine-spacing-md))";

export const SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE = {
	boxSizing: "border-box",
	height: APP_VIEWPORT_BOTTOM,
	maxHeight: APP_VIEWPORT_BOTTOM,
	display: "flex",
	flexDirection: "column",
	overflow: "hidden",
	// Mantine portals the Modal outside AppShell, so the fullscreen surface is the sole horizontal
	// safe-area owner. Header/body/toolbars/code all inherit the reduced content box exactly once.
	paddingInlineStart: SAFE_AREA_INSET_LEFT,
	paddingInlineEnd: SAFE_AREA_INSET_RIGHT,
} satisfies CSSProperties;

export const SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE = {
	boxSizing: "border-box",
	minHeight: `calc(60px + ${SAFE_AREA_INSET_TOP})`,
	paddingTop: `calc(${MODAL_BASE_PADDING} + ${SAFE_AREA_INSET_TOP})`,
	flexShrink: 0,
} satisfies CSSProperties;

export function safeAreaFullscreenModalBodyStyle(basePaddingPx?: number): CSSProperties {
	const basePadding = basePaddingPx == null ? MODAL_BASE_PADDING : `${basePaddingPx}px`;
	return {
		boxSizing: "border-box",
		flex: 1,
		minHeight: 0,
		paddingBottom: `calc(${basePadding} + ${SAFE_AREA_INSET_BOTTOM})`,
	};
}
