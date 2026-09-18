/**
 * VListContentViewModal.test.ts — the fullscreen viewer must not disturb the
 * list's measurement inputs.
 *
 * THE BUG THIS PINS
 *
 * The modal suppresses the list behind it. The first implementation copied
 * ContentViewer's `content-visibility: hidden`, which makes the browser skip
 * LAYOUT for the whole subtree — so the viewport's `clientHeight` / `clientWidth`
 * collapse to 0. The exact shell observes precisely those two values with a
 * ResizeObserver and feeds them into the document build options
 * (`viewportHeight` / `contentWidth`), which are memo dependencies of
 * `usePretextDocument`'s buildOptions. Opening the modal therefore rebuilt the
 * whole document at width ~0 and closing it rebuilt again at the restored width:
 * the list visibly reloaded on close.
 *
 * `visibility: hidden` skips PAINT while keeping the box model intact, so no
 * observer fires and no rebuild happens.
 *
 * Source-level assertions on purpose: the regression is a one-property change with
 * no visible API surface, and a jsdom/linkedom render cannot reproduce a real
 * layout skip — nothing in a behavioural test would notice it coming back.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sliceBracketedRegion } from "./source-slice";

const VLIST_DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(VLIST_DIR, relativePath), "utf8");
}

describe("the fullscreen viewer leaves the list's measured geometry alone", () => {
	it("never applies content-visibility to the list viewport", () => {
		const src = read("VListContentViewModal.tsx");
		// Mentioning it in the explanatory comment is fine; assigning it is not.
		expect(src).not.toMatch(/style\.contentVisibility\s*=/);
	});

	it("suppresses the list with visibility (paint-only) instead", () => {
		const src = read("VListContentViewModal.tsx");
		expect(src).toContain('viewport.style.visibility = "hidden"');
		// And restores whatever was there before, rather than hard-coding "visible".
		expect(src).toContain("viewport.style.visibility = prev");
	});

	it("targets the exact list's own viewport", () => {
		const src = read("VListContentViewModal.tsx");
		expect(src).toContain("data-pretext-exact-message-list");
	});
});

/**
 * The other half of the contract: the two values a suppression must not disturb
 * really are document-build inputs. If either stopped feeding the layout, the
 * guard above would be protecting nothing.
 */
describe("viewportHeight / contentWidth are document-build inputs", () => {
	// Anchored on the effect's real boundaries. An earlier version opened the slice at
	// `const node = viewportRef.current;` and closed it at `}, [centeredColumn]);` —
	// neither of which is the resize effect any more (the node comes from state, and
	// the dependency list is `[viewportNode, centeredColumn]`), so `indexOf` returned
	// -1, `slice(0, -1)` kept almost the whole file, and every assertion below passed
	// on unrelated code.
	it("the shell measures both from the viewport through a ResizeObserver", () => {
		const src = read("PretextExactMessageList.tsx");
		const start = src.indexOf("const node = viewportNode;");
		expect(start).toBeGreaterThan(-1);
		const end = src.indexOf("}, [viewportNode, centeredColumn]);", start);
		expect(end).toBeGreaterThan(start);
		const measure = src.slice(start, end);
		expect(measure).toContain("setViewportHeight(node.clientHeight)");
		expect(measure).toContain("node.clientWidth");
		expect(measure).toContain("new ResizeObserver(measure)");
	});

	it("both reach usePretextDocument's build options", () => {
		const src = read("PretextExactMessageList.tsx");
		// Brace-matched rather than cut at a literal `"\n\t});"`. That sentinel assumed
		// the call sits at one tab of indentation; it does not (the component is nested
		// inside `forwardRef`), so `indexOf` returned -1, `slice(start, -1)` kept almost
		// the whole file, and both assertions below passed on unrelated code — a guard
		// that certified a wiring rule it had stopped reading. See source-slice.ts.
		const call = sliceBracketedRegion(src, "usePretextDocument(narratorId, {");
		if (call === null) throw new Error("usePretextDocument(narratorId, { … }) call not found");
		expect(call).toContain("contentWidth");
		expect(call).toContain("viewportHeight");
	});

	it("and are memo dependencies, so a collapse rebuilds the document", () => {
		const src = read("usePretextDocument.ts");
		const memo = src.slice(
			src.indexOf("const buildOptions = useMemo<PretextLayoutBuildOptions>("),
			src.indexOf("const snapshot = useSyncExternalStore("),
		);
		expect(memo).toContain("options.contentWidth");
		expect(memo).toContain("options.viewportHeight");
	});
});
