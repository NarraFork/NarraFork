import type { CSSProperties } from "react";

export const SAFE_AREA_INSET_TOP = "env(safe-area-inset-top, 0px)";
export const SAFE_AREA_INSET_LEFT = "env(safe-area-inset-left, 0px)";
export const SAFE_AREA_INSET_RIGHT = "env(safe-area-inset-right, 0px)";
export const PHYSICAL_SAFE_AREA_INSET_BOTTOM = "env(safe-area-inset-bottom, 0px)";
export const SAFE_AREA_INSET_BOTTOM = `var(--app-safe-area-inset-bottom, ${PHYSICAL_SAFE_AREA_INSET_BOTTOM})`;
export const APP_VIEWPORT_BOTTOM = "var(--app-viewport-bottom, 100dvh)";

export const AUTHENTICATED_APP_SHELL_ATTRIBUTE = "data-nf-authenticated-app-shell";
export const APP_SHELL_CLASSNAME = "nf-app-shell";
export const APP_SHELL_MAIN_CLASSNAME = "nf-app-shell-main";
export const APP_SHELL_MAIN_ID = "nf-app-main";

export const TOP_NOTIFICATION_SAFE_AREA_CLASSNAME = "nf-notifications-safe-area";

export const TOP_BANNER_SAFE_AREA_STYLE = {
	top: `calc(8px + ${SAFE_AREA_INSET_TOP})`,
} satisfies CSSProperties;

// Mantine layout="alt" forces Navbar to top: 0/height: 100dvh. On mobile the
// Header owns the top inset, so Navbar starts at Mantine's complete header
// offset. At the desktop breakpoint Navbar owns its separate full-height column
// and excludes only the physical top inset; env() is 0 on ordinary desktops.
export const APP_SHELL_HEADER_OFFSET = "var(--app-shell-header-offset, 60px)";
export const APP_SHELL_HEADER_HEIGHT = `calc(60px + ${SAFE_AREA_INSET_TOP})`;
export const APP_SHELL_MOBILE_NAVBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${APP_SHELL_HEADER_OFFSET})`;
export const APP_SHELL_DESKTOP_NAVBAR_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${SAFE_AREA_INSET_TOP})`;
export const APP_SHELL_MAIN_PADDING_BOTTOM = `calc(var(--mantine-spacing-md) + ${SAFE_AREA_INSET_BOTTOM})`;

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
 * Full-height edge-to-edge AppShell content that stops before the effective
 * bottom inset. The root viewport tracker changes that inset to zero while the
 * virtual keyboard occupies the bottom edge, so Home Indicator space is never
 * reserved a second time above the keyboard.
 *
 * APP_VIEWPORT_BOTTOM is the visual viewport's bottom edge in layout viewport
 * coordinates (`visualViewport.height + offsetTop`). This remains correct when
 * iOS pans the visual viewport to keep a focused input visible. `100dvh` is the
 * no-JS / desktop fallback.
 */
export const APP_SHELL_SAFE_VIEWPORT_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${APP_SHELL_HEADER_OFFSET} - ${SAFE_AREA_INSET_BOTTOM})`;
export const APP_SHELL_PADDED_SAFE_VIEWPORT_HEIGHT = `calc(${APP_VIEWPORT_BOTTOM} - ${APP_SHELL_HEADER_OFFSET} - var(--mantine-spacing-md) * 2 - ${SAFE_AREA_INSET_BOTTOM})`;

const KEYBOARD_MIN_OCCLUSION_PX = 120;
const KEYBOARD_MIN_OCCLUSION_RATIO = 0.18;
const VIEWPORT_WIDTH_RESET_MIN_PX = 48;
const VIEWPORT_WIDTH_RESET_RATIO = 0.2;

export interface AppViewportMeasurement {
	layoutWidth: number;
	layoutHeight: number;
	visualViewportHeight?: number;
	visualViewportOffsetTop?: number;
	editableFocused: boolean;
	virtualKeyboardCapable: boolean;
}

export interface AppViewportState {
	viewportBottom: number;
	stableViewportBottom: number;
	layoutWidth: number;
	keyboardVisible: boolean;
}

function positiveFinite(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve viewport geometry from absolute measurements, never accumulated
 * deltas. Keeping the last unobstructed bottom edge lets old Safari/PWA modes
 * that resize `innerHeight` (and browsers without VisualViewport) detect and
 * later restore from a keyboard transition.
 */
export function resolveAppViewportState(
	measurement: AppViewportMeasurement,
	previous?: AppViewportState,
): AppViewportState {
	const layoutWidth = positiveFinite(measurement.layoutWidth, previous?.layoutWidth ?? 1);
	const layoutHeight = positiveFinite(
		measurement.layoutHeight,
		previous?.stableViewportBottom ?? 1,
	);
	const visualHeight = positiveFinite(measurement.visualViewportHeight, layoutHeight);
	const visualOffsetTop = Math.max(0, measurement.visualViewportOffsetTop ?? 0);
	const measuredBottom = Math.max(1, Math.min(layoutHeight, visualHeight + visualOffsetTop));
	const widthResetThreshold = previous
		? Math.max(VIEWPORT_WIDTH_RESET_MIN_PX, previous.layoutWidth * VIEWPORT_WIDTH_RESET_RATIO)
		: 0;
	const widthChanged = previous
		? Math.abs(layoutWidth - previous.layoutWidth) > widthResetThreshold
		: false;

	let stableViewportBottom =
		previous && !widthChanged
			? Math.max(previous.stableViewportBottom, layoutHeight, measuredBottom)
			: Math.max(layoutHeight, previous?.layoutWidth ?? 0, measuredBottom);
	const occludedHeight = Math.max(0, stableViewportBottom - measuredBottom);
	const keyboardThreshold = Math.max(
		KEYBOARD_MIN_OCCLUSION_PX,
		stableViewportBottom * KEYBOARD_MIN_OCCLUSION_RATIO,
	);
	const keyboardVisible =
		measurement.virtualKeyboardCapable &&
		occludedHeight >= keyboardThreshold &&
		(measurement.editableFocused || (previous?.keyboardVisible === true && !widthChanged));

	// Browser chrome and ordinary window resizes become the new baseline whenever
	// no editable control/keyboard owns the viewport. This prevents stale maxima
	// from being subtracted repeatedly across navigation, rotation, or resize.
	if (!keyboardVisible && !measurement.editableFocused) {
		stableViewportBottom = Math.max(layoutHeight, measuredBottom);
	}

	return {
		viewportBottom: measuredBottom,
		stableViewportBottom,
		layoutWidth,
		keyboardVisible,
	};
}

export function isEditableViewportTarget(element: Element | null): boolean {
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
		state = resolveAppViewportState(
			{
				layoutWidth: targetWindow.innerWidth,
				layoutHeight: targetWindow.innerHeight,
				visualViewportHeight: visualViewport?.height,
				visualViewportOffsetTop: visualViewport?.offsetTop,
				editableFocused: isEditableViewportTarget(targetDocument.activeElement),
				virtualKeyboardCapable: supportsVirtualKeyboard(targetWindow),
			},
			state,
		);
		root.style.setProperty("--app-viewport-bottom", `${state.viewportBottom}px`);
		root.style.setProperty(
			"--app-safe-area-inset-bottom",
			state.keyboardVisible ? "0px" : PHYSICAL_SAFE_AREA_INSET_BOTTOM,
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
