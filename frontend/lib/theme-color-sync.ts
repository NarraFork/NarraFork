/**
 * Keep `<meta name="theme-color">` equal to the app shell's actual background.
 *
 * Chrome paints the WCO window buttons (min/max/close) with the document's
 * theme-color as their background — it is NOT transparent (chromium issue
 * 40870020). The boot script in index.html sets the meta once from the stored
 * scheme/OLED preference, but the real background also moves at runtime: plugin
 * themes rewrite `--mantine-color-body`, OLED toggles, the color scheme flips.
 * Any of those leaves the button strip painting a colour the app no longer has.
 *
 * The colour is read from the *header's* computed background, because the header
 * is the surface the buttons overlay. Everything that can change it is an
 * attribute on `<html>` (`data-mantine-color-scheme` / `data-oled` /
 * `data-plugin-theme`) or a rewrite of the injected plugin `<style>` in `<head>`,
 * so two small MutationObservers cover all producers without following React
 * state — the same reasoning as components/plugins/host-presentation.ts, which
 * this module deliberately does not import (lib must not depend on components).
 *
 * The meta also drives the mobile-PWA status bar, so syncing unconditionally
 * (not only under WCO) is correct there too.
 */

const WATCHED_ATTRIBUTES = ["data-mantine-color-scheme", "data-oled", "data-plugin-theme"];

/** Transparent backgrounds carry no usable colour; walk past them. */
function isUsableColor(color: string | undefined): color is string {
	if (!color) return false;
	const rgba = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(color);
	return rgba === null || Number(rgba[1]) > 0;
}

/**
 * The header is the surface the buttons overlay in the main shell, so its
 * background wins; in standalone windows the WCO strip plays that role. Body and
 * <html> are the fallbacks for surfaces with neither (the brief window before
 * the shell mounts, public pages).
 */
export function resolveThemeColor(targetWindow: Window, targetDocument: Document): string | null {
	const candidates = [
		targetDocument.querySelector(".nf-app-shell .mantine-AppShell-header"),
		targetDocument.querySelector(".nf-wco-window-strip"),
		targetDocument.body,
		targetDocument.documentElement,
	];
	for (const element of candidates) {
		if (!element) continue;
		const color = targetWindow.getComputedStyle(element).backgroundColor;
		if (isUsableColor(color)) return color;
	}
	return null;
}

/**
 * Write both media-scoped metas to the CURRENT colour — whichever one the
 * browser's own prefers-color-scheme picks then matches the app, which may not
 * agree with the OS scheme. Same policy as the boot script in index.html.
 */
export function applyThemeColor(targetDocument: Document, color: string): void {
	for (const meta of targetDocument.querySelectorAll('meta[name="theme-color"]')) {
		if (meta.getAttribute("content") !== color) meta.setAttribute("content", color);
	}
}

export function installThemeColorSync(
	targetWindow: Window = window,
	targetDocument: Document = document,
): () => void {
	// Window's declared type omits MutationObserver in this project's lib set, but
	// every real window (and the linkedom test realm) carries it.
	const Observer = (targetWindow as unknown as { MutationObserver: typeof MutationObserver })
		.MutationObserver;
	let disposed = false;
	let pendingFrame: number | undefined;
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;

	const sync = () => {
		if (disposed) return;
		const color = resolveThemeColor(targetWindow, targetDocument);
		if (color) applyThemeColor(targetDocument, color);
	};

	// MutationObserver callbacks run before style recalculation, so reading
	// computed styles there returns the OLD colour — defer to the next frame,
	// which also coalesces bursts (scheme + plugin-theme attributes move together).
	const schedule = () => {
		if (disposed || pendingFrame !== undefined || pendingTimer !== undefined) return;
		if (typeof targetWindow.requestAnimationFrame === "function") {
			pendingFrame = targetWindow.requestAnimationFrame(() => {
				pendingFrame = undefined;
				sync();
			});
		} else {
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				sync();
			}, 0);
		}
	};

	const attributeObserver = new Observer(schedule);
	attributeObserver.observe(targetDocument.documentElement, {
		attributes: true,
		attributeFilter: WATCHED_ATTRIBUTES,
	});
	// PluginThemeInjector rewrites its <style> text without moving any attribute.
	const styleObserver = new Observer(schedule);
	styleObserver.observe(targetDocument.head, {
		childList: true,
		characterData: true,
		subtree: true,
	});
	schedule();

	return () => {
		disposed = true;
		attributeObserver.disconnect();
		styleObserver.disconnect();
		if (pendingFrame !== undefined) targetWindow.cancelAnimationFrame?.(pendingFrame);
		if (pendingTimer !== undefined) clearTimeout(pendingTimer);
	};
}
