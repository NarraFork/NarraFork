import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { installWcoTracking, readWcoControlsSide, WCO_ATTRIBUTE } from "./wco";

/**
 * A window stand-in carrying only what wco.ts touches: a `navigator` with a
 * configurable `windowControlsOverlay` and a `matchMedia` stub whose "change"
 * listeners can be fired by hand. linkedom supplies the document side.
 */
function wcoRealm({ visible = true, rectX = 0 }: { visible?: boolean; rectX?: number } = {}) {
	const { window: _domWindow, document: domDocument } = parseHTML(
		"<!doctype html><html><body></body></html>",
	);

	const overlayListeners = new Map<string, Set<() => void>>();
	const overlay = {
		visible,
		getTitlebarAreaRect: () => ({ x: rectX }),
		addEventListener(type: string, listener: () => void) {
			const forType = overlayListeners.get(type) ?? new Set<() => void>();
			forType.add(listener);
			overlayListeners.set(type, forType);
		},
		removeEventListener(type: string, listener: () => void) {
			overlayListeners.get(type)?.delete(listener);
		},
	};

	const mediaListeners = new Map<string, Set<() => void>>();
	const fakeWindow = {
		navigator: { windowControlsOverlay: overlay },
		matchMedia: (_query: string) => ({
			matches: false,
			addEventListener(type: string, listener: () => void) {
				const forType = mediaListeners.get(type) ?? new Set<() => void>();
				forType.add(listener);
				mediaListeners.set(type, forType);
			},
			removeEventListener(type: string, listener: () => void) {
				mediaListeners.get(type)?.delete(listener);
			},
		}),
	} as unknown as Window;

	const emit = (listeners: Map<string, Set<() => void>>, type: string) => {
		for (const listener of [...(listeners.get(type) ?? [])]) listener();
	};

	return {
		document: domDocument as unknown as Document,
		root: domDocument.documentElement,
		window: fakeWindow,
		overlay: {
			get visible() {
				return overlay.visible;
			},
			set visible(next: boolean) {
				overlay.visible = next;
			},
			get rectX() {
				return rectX;
			},
			set rectX(next: number) {
				overlay.getTitlebarAreaRect = () => ({ x: next });
			},
			emitGeometryChange: () => emit(overlayListeners, "geometrychange"),
			geometryListenerCount: () => overlayListeners.get("geometrychange")?.size ?? 0,
		},
		media: {
			emitChange: () => emit(mediaListeners, "change"),
			changeListenerCount: () => mediaListeners.get("change")?.size ?? 0,
		},
	};
}

describe("readWcoControlsSide", () => {
	test("returns null when the API is absent (non-Chromium, plain tab)", () => {
		const win = { navigator: {} } as unknown as Window;
		expect(readWcoControlsSide(win)).toBe(null);
	});

	test("returns null while the overlay is not visible", () => {
		const realm = wcoRealm({ visible: false, rectX: 78 });
		expect(readWcoControlsSide(realm.window)).toBe(null);
	});

	test("rect at x=0 means the buttons sit on the right (Windows/Linux)", () => {
		const realm = wcoRealm({ visible: true, rectX: 0 });
		expect(readWcoControlsSide(realm.window)).toBe("right");
	});

	test("rect x>0 means the buttons sit on the left (macOS, RTL)", () => {
		const realm = wcoRealm({ visible: true, rectX: 78 });
		expect(readWcoControlsSide(realm.window)).toBe("left");
	});

	test("a throwing getTitlebarAreaRect degrades to the zero-inset default", () => {
		const win = {
			navigator: {
				windowControlsOverlay: {
					visible: true,
					getTitlebarAreaRect: () => {
						throw new Error("not implemented");
					},
				},
			},
		} as unknown as Window;
		expect(readWcoControlsSide(win)).toBe("right");
	});
});

describe("installWcoTracking", () => {
	test("applies the side synchronously, before any event", () => {
		const realm = wcoRealm({ visible: true, rectX: 78 });
		const dispose = installWcoTracking(realm.window, realm.document);
		expect(realm.root.getAttribute(WCO_ATTRIBUTE)).toBe("left");
		dispose();
	});

	test("sets no attribute when the overlay is hidden or absent", () => {
		const realm = wcoRealm({ visible: false });
		const dispose = installWcoTracking(realm.window, realm.document);
		expect(realm.root.hasAttribute(WCO_ATTRIBUTE)).toBe(false);
		dispose();
	});

	test("geometrychange re-evaluates visibility and side", () => {
		const realm = wcoRealm({ visible: true, rectX: 0 });
		const dispose = installWcoTracking(realm.window, realm.document);
		expect(realm.root.getAttribute(WCO_ATTRIBUTE)).toBe("right");

		// e.g. window moved to a screen/locale with left-side controls
		realm.overlay.rectX = 78;
		realm.overlay.emitGeometryChange();
		expect(realm.root.getAttribute(WCO_ATTRIBUTE)).toBe("left");

		// e.g. fullscreen hides the overlay entirely
		realm.overlay.visible = false;
		realm.overlay.emitGeometryChange();
		expect(realm.root.hasAttribute(WCO_ATTRIBUTE)).toBe(false);
		dispose();
	});

	test("display-mode change re-evaluates as well", () => {
		const realm = wcoRealm({ visible: false });
		const dispose = installWcoTracking(realm.window, realm.document);
		expect(realm.root.hasAttribute(WCO_ATTRIBUTE)).toBe(false);

		realm.overlay.visible = true;
		realm.media.emitChange();
		expect(realm.root.getAttribute(WCO_ATTRIBUTE)).toBe("right");
		dispose();
	});

	test("dispose removes the attribute and every listener", () => {
		const realm = wcoRealm({ visible: true, rectX: 0 });
		const dispose = installWcoTracking(realm.window, realm.document);
		expect(realm.overlay.geometryListenerCount()).toBe(1);
		expect(realm.media.changeListenerCount()).toBe(1);

		dispose();
		expect(realm.root.hasAttribute(WCO_ATTRIBUTE)).toBe(false);
		expect(realm.overlay.geometryListenerCount()).toBe(0);
		expect(realm.media.changeListenerCount()).toBe(0);

		// Late events must not resurrect the attribute.
		realm.overlay.emitGeometryChange();
		realm.media.emitChange();
		expect(realm.root.hasAttribute(WCO_ATTRIBUTE)).toBe(false);
	});
});

/*
 * app-region hit-testing is geometric, not z-ordered: a floating element painted
 * over the header's drag rect loses its clicks to window dragging unless its own
 * rect is subtracted with `no-drag`. This guards the pairing between the three
 * places that must agree — the CSS rule, the theme that stamps `nf-overlay-layer`
 * onto Mantine floating parts (v9 has no stable component classes), and the two
 * hand-rolled banners that carry `nf-top-banner`.
 */
describe("floating overlays above the WCO drag surface", () => {
	test("wco.css subtracts every overlay hook from the drag region", async () => {
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		expect(css).toMatch(/html\[data-nf-wco\][^{]*\.nf-top-banner[^{]*\{/);
		expect(css).toMatch(/html\[data-nf-wco\][^{]*\.nf-notifications-safe-area[^{]*\{/);
		expect(css).toMatch(/html\[data-nf-wco\][^{]*\.nf-overlay-layer[^{]*\{/);
		expect(css.match(/html\[data-nf-wco\][^{]*\.nf-overlay-layer[^{]*\{[^}]*\}/)?.[0]).toContain(
			"-webkit-app-region: no-drag",
		);
	});

	test("desktop has a drag surface without a header row", async () => {
		// The desktop header row is gone; the sidebar brand row and a strip above the page
		// are the drag surfaces, and their controls opt out.
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		expect(css).toMatch(/html\[data-nf-wco\] \.nf-nav-brand-row \{[^}]*-webkit-app-region: drag/);
		expect(css).toMatch(
			/html\[data-nf-wco\] \.nf-nav-brand-row :is\([^)]*button[^)]*\) \{[^}]*-webkit-app-region: no-drag/,
		);
		expect(css).toMatch(/html\[data-nf-wco\] \.nf-wco-main-strip \{[^}]*-webkit-app-region: drag/);
		const layout = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		expect(layout).toContain('className="nf-wco-main-strip"');
		const top = await Bun.file(
			new URL("../components/nav/NavTopSection.tsx", import.meta.url),
		).text();
		expect(top).toContain('className="nf-nav-brand-row"');
	});

	test("nothing dead sits at the top edge or the sidebar's sides", async () => {
		// The shell's 16px top padding sits above both drag surfaces and is where a reader
		// grabs first. It gets a surface of its own rather than being removed: zeroing the
		// padding moved the whole sidebar and page up, which broke the layout.
		const css = await Bun.file(new URL("../styles/wco.css", import.meta.url)).text();
		const desktop = css.slice(css.indexOf("@media (min-width: 48em)"));
		expect(desktop).toMatch(
			/html\[data-nf-wco\] \.nf-wco-top-gap \{[^}]*height: var\(--mantine-spacing-md\)[^}]*-webkit-app-region: drag/,
		);
		expect(desktop).toMatch(
			/html\[data-nf-wco\] \.nf-app-shell:has\(\[data-nf-wco-titlebar\]\) \.nf-wco-top-gap \{\s*display: none/,
		);
		expect(css).not.toMatch(/mantine-AppShell-navbar[^{]*\{[^}]*padding-top: 0/);
		// The navbar's inline padding leaves a dead column down the window's left edge.
		// The brand row bleeds over it, keeping its content in place.
		expect(desktop).toMatch(
			/\.nf-nav-brand-row \{\s*\/\*[^*]*\*\/\s*margin-inline: calc\(var\(--mantine-spacing-md\) \* -1\) !important/,
		);
		const layout = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		expect(layout).toContain('className="nf-wco-top-gap"');
	});

	test("the theme stamps nf-overlay-layer on every Mantine floating part", async () => {
		const theme = await Bun.file(new URL("./mantine-theme.ts", import.meta.url)).text();
		for (const component of ["Modal", "Drawer", "Menu", "Popover", "HoverCard", "Combobox"]) {
			expect(theme).toMatch(new RegExp(`${component}:\\s*\\{[^}]*nf-overlay-layer`));
		}
	});

	test("the fixed top banners carry nf-top-banner", async () => {
		const [versionBanner, connectionAlert] = await Promise.all([
			Bun.file(new URL("../components/VersionUpdateBanner.tsx", import.meta.url)).text(),
			Bun.file(new URL("../components/WSConnectionAlert.tsx", import.meta.url)).text(),
		]);
		expect(versionBanner).toContain("nf-top-banner");
		expect(connectionAlert).toContain("nf-top-banner");
	});

	/*
	 * The browser folds the reported rects into the hit-test region in list order,
	 * later rects winning where they overlap (gfx::DraggableRegionsToSkRegion), and
	 * that list is the layout-tree order. A banner emitted while the header row
	 * still lies ahead of it in the tree is therefore cancelled by nothing: the
	 * row's `drag` rect comes later and reclaims the strip. Both banners must
	 * therefore be emitted after every drag surface — the header row (and the
	 * navbar's WCO spacer, which lives in the navbar and so comes after the
	 * header). Nesting them inside the row would only survive the row itself.
	 */
	test("the fixed top banners are emitted after every drag surface", async () => {
		const layout = await Bun.file(
			new URL("../components/AuthenticatedAppLayout.tsx", import.meta.url),
		).text();
		const after = (marker: string) => layout.lastIndexOf(marker);
		const headerEnd = layout.indexOf("</AppShell.Header>");
		const navbarEnd = after("</AppShell.Navbar>");
		const mainStrip = layout.indexOf('className="nf-wco-main-strip"');
		expect(headerEnd).toBeGreaterThan(0);
		expect(navbarEnd).toBeGreaterThan(0);
		expect(mainStrip).toBeGreaterThan(0);

		for (const banner of ["<WSConnectionAlert />", "<VersionUpdateBanner />"]) {
			const at = after(banner);
			expect(at).toBeGreaterThan(headerEnd);
			expect(at).toBeGreaterThan(navbarEnd);
			expect(at).toBeGreaterThan(mainStrip);
		}
	});
});
