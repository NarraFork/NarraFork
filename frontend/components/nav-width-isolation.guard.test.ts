/**
 * nav-width-isolation.guard.test.ts — the sidebar width must stay out of the layout.
 *
 * `useNavWidth()` re-renders its caller on every frame of a resize drag. The whole
 * point of `AppShellWithNavWidth` is that the caller is a near-empty wrapper whose
 * `children` arrive as an already-created element, so React reuses the navbar subtree
 * by reference. Move the call up into `AuthenticatedLayout` — 1000+ lines, ~86 hooks,
 * containing both `RecentTabList`s and every `NavLink`/`Tooltip` — and each drag frame
 * re-renders all of it again. The same file records what that costs: a per-second tick
 * of exactly that shape measured ~140ms of main-thread work per second.
 *
 * The regression is invisible to the behavioural tests (the width still updates and
 * everything still works, just slowly), so it is asserted structurally.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LAYOUT = join(import.meta.dir, "AppRootLayout.tsx");

/**
 * The layout's CODE, with comments stripped.
 *
 * Stripping matters: the comment warning "do not read `useNavWidth()` outside this
 * component" contains the very call it forbids, so a raw scan counts it as a second
 * call site and the guard fails on its own documentation.
 */
function layoutSource(): string {
	return readFileSync(LAYOUT, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ");
}

/** Body of a top-level `function <name>(` declaration, up to the next one. */
function functionBody(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	expect(start).toBeGreaterThan(-1);
	const rest = source.slice(start + 1);
	const nextIndex = rest.search(/\nfunction [A-Za-z]/);
	return nextIndex === -1 ? rest : rest.slice(0, nextIndex);
}

describe("nav width render isolation", () => {
	it("reads useNavWidth in exactly one place", () => {
		const matches = layoutSource().match(/useNavWidth\(\)/g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("reads it inside the thin AppShell wrapper, not the layout", () => {
		const source = layoutSource();
		expect(functionBody(source, "AppShellWithNavWidth")).toContain("useNavWidth()");
		expect(functionBody(source, "AuthenticatedLayout")).not.toContain("useNavWidth()");
	});

	// The wrapper must stay thin. If navbar content moves into it, the isolation is
	// gone even though the `useNavWidth()` call site looks unchanged.
	it("keeps the wrapper free of navbar content and extra subscriptions", () => {
		const body = functionBody(layoutSource(), "AppShellWithNavWidth");
		for (const forbidden of ["RecentTabList", "NavLink", "Tooltip", "useRecentTabs", "useQuery"]) {
			expect(body).not.toContain(forbidden);
		}
		// It must pass children straight through, so the subtree is reused by reference.
		expect(body).toContain("{children}");
	});

	// The layout still needs the collapsed boolean; that is fine (it flips at most once
	// per drag). What it must not do is derive collapsed FROM a width subscription.
	it("uses the collapsed selector in the layout", () => {
		const body = functionBody(layoutSource(), "AuthenticatedLayout");
		expect(body).toContain("useNavCollapsed()");
	});

	// The old hook returned an object holding width + collapsed + callbacks together,
	// which is what forced one subscription for both rates.
	it("no longer imports the removed combined hook", () => {
		expect(layoutSource()).not.toContain("useResizableNav()");
	});

	it("keeps the mobile navbar breakpoint subscription out of AuthenticatedLayout", () => {
		const source = layoutSource();
		const layout = functionBody(source, "AuthenticatedLayout");
		expect(layout).not.toContain("useMobileViewport()");
		expect(functionBody(source, "MobileNavbarEffects")).toContain("useMobileViewport()");
		expect(layout).not.toContain("const isMobile");
	});

	it("keeps the mobile effects subscriber free of navbar content", () => {
		const body = functionBody(layoutSource(), "MobileNavbarEffects");
		for (const forbidden of ["RecentTabList", "NavLink", "Tooltip", "useRecentTabs", "useQuery"]) {
			expect(body).not.toContain(forbidden);
		}
	});

	it("guard self-check: both function bodies are located and non-trivial", () => {
		const source = layoutSource();
		expect(functionBody(source, "AppShellWithNavWidth").length).toBeGreaterThan(100);
		expect(functionBody(source, "AuthenticatedLayout").length).toBeGreaterThan(1000);
	});
});
