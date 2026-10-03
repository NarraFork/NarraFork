/**
 * Production resize wiring: preview may publish exact viewport geometry, but only
 * initial/commit and non-pending height observations feed the full layout. Scheduler
 * behaviour is tested against createVListResizeController in vlist-live-resize.test.ts,
 * not a reproduction of the shell handler.
 */
import { describe, expect, it } from "bun:test";
import { readVlistFile, shellModule, shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

function shell(): string {
	return shellModule("PretextExactMessageList.tsx");
}

/** The memo comparator belongs to the row's own module, never a concatenated slice. */
function row(): string {
	return shellModule("ExactRow.tsx");
}

function region(source: string, anchor: string): string {
	const result = sliceBracketedRegion(source, anchor);
	if (result === null) throw new Error(`Production resize region not found: ${anchor}`);
	return result;
}

/** Match the actual layout effect, including synchronous setup and cleanup. */
function resizeEffect(source: string): string {
	const start = source.lastIndexOf(
		"useLayoutEffect(() => {",
		source.indexOf("const node = viewportNode;"),
	);
	expect(start).toBeGreaterThan(-1);
	const effect = region(source.slice(start), "useLayoutEffect(");
	expect(effect).toContain("const node = viewportNode;");
	return effect;
}

function resizeOptions(): string {
	return region(resizeEffect(shell()), "createVListResizeController({");
}

describe("production resize handler wiring", () => {
	it("publishes full-build height on initial/commit, never from a live preview", () => {
		const options = resizeOptions();
		for (const name of ["onInitial", "onCommit"]) {
			const callback = region(options, `${name}: ({ width, height }) => {`);
			expect(callback.match(/setLayoutHeight\s*\(/g)).toHaveLength(1);
			expect(callback).toMatch(/setLayoutHeight\(height\)/);
			expect(callback).toMatch(/setViewportHeight\(height\)/);
			expect(callback).toMatch(/setContentWidth\(width\)/);
		}
		const preview = region(options, "onPreview: ({ width, height }) => {");
		expect(preview).not.toMatch(/setLayoutHeight|setContentWidth/);
		expect(preview).toMatch(/setViewportHeight\(height\)/);
		expect(preview).toContain(
			"pretextDocumentRef.current.previewWidth(width, mobileViewportRef.current)",
		);
	});

	it("lets observer height reach the build only after controller.observe says not pending", () => {
		const measure = region(resizeEffect(shell()), "const measure = () => {");
		const idle = region(measure, "if (!controller.isPending()) {");
		expect(idle).toMatch(/setViewportHeight\(node\.clientHeight\)/);
		expect(idle).toMatch(/setLayoutHeight\(node\.clientHeight\)/);
		expect(measure.indexOf("controller.observe();")).toBeGreaterThan(-1);
		expect(measure.indexOf("controller.observe();")).toBeLessThan(measure.indexOf(idle));
		// No second, ungated observer write hiding outside the positively owned branch.
		expect(measure.replace(idle, "")).not.toMatch(
			/setLayoutHeight|setViewportHeight|setContentWidth/,
		);
	});

	it("accounts for every exact-height and layout-height write across the production shell", () => {
		const source = shellSource();
		// initial + commit + preview + idle observer; only preview excludes layoutHeight.
		expect(source.match(/setViewportHeight\s*\(/g)).toHaveLength(4);
		expect(source.match(/setLayoutHeight\s*\(/g)).toHaveLength(3);
	});

	it("wires observer, synchronous initial measurement, release and disposal to the controller", () => {
		const effect = resizeEffect(shell());
		expect(shell()).toMatch(
			/import\s*\{[^}]*createVListResizeController[^}]*\}\s*from\s*"\.\/vlist-live-resize"/,
		);
		expect(effect).toMatch(/createPointerDragTracker\(\(\)\s*=>\s*controller\.release\(\)\)/);
		expect(effect).toContain("new ResizeObserver(measure)");
		expect(effect).toContain("observer?.observe(node)");
		const initialMeasure = effect.match(/^\s*measure\(\);\s*$/m);
		expect(initialMeasure).not.toBeNull();
		const initialMeasureIndex = initialMeasure?.index ?? -1;
		expect(initialMeasureIndex).toBeGreaterThan(-1);
		expect(initialMeasureIndex).toBeLessThan(effect.indexOf("new ResizeObserver(measure)"));
		// The synchronous layout-effect path, not an rAF or 140ms timer, owns first paint.
		const setup = effect.slice(0, initialMeasureIndex);
		expect(setup).not.toMatch(/requestAnimationFrame|setTimeout/);
		for (const cleanup of [
			"observer?.disconnect()",
			"pointerTracker.dispose()",
			"controller.dispose()",
		]) {
			expect(effect).toContain(cleanup);
		}
		expect(effect).toMatch(
			/if\s*\(resizeControllerRef\.current\s*===\s*controller\)\s*resizeControllerRef\.current\s*=\s*null/,
		);
	});

	it("reads current committed width, live document and live pointer rather than captured state", () => {
		const source = shell();
		const options = resizeOptions();
		expect(options).toMatch(/getCommittedWidth:\s*\(\)\s*=>\s*committedContentWidthRef\.current/);
		expect(options).toMatch(/pointerDown:\s*\(\)\s*=>\s*pointerTracker\.isDown\(\)/);
		expect(source).toMatch(/pretextDocumentRef\.current\s*=\s*pretextDocument\s*;/);
		const preview = region(options, "onPreview: ({ width, height }) => {");
		expect(preview).toContain(
			"pretextDocumentRef.current.previewWidth(width, mobileViewportRef.current)",
		);
		expect(preview).not.toMatch(/\bpretextDocument\.previewWidth/);
	});

	it("uses an explicit commit epoch to finish a pending preview even at the starting width", () => {
		const source = shell();
		const commit = region(resizeOptions(), "onCommit: ({ width, height }) => {");
		expect(source).toMatch(/\[widthCommitEpoch,\s*setWidthCommitEpoch\]\s*=\s*useState\(0\)/);
		expect(commit).toMatch(/setWidthCommitEpoch\(\(epoch\)\s*=>\s*epoch\s*\+\s*1\)/);
		expect(commit).not.toMatch(/\bif\s*\(/);
		expect(region(source, "usePretextDocument(narratorId, {")).toContain("widthCommitEpoch,");
		const hook = readVlistFile("usePretextDocument.ts");
		expect(hook).toContain("const lastWidthCommitEpochRef = useRef(options.widthCommitEpoch)");
		const finish = region(
			hook,
			"if (lastWidthCommitEpochRef.current !== options.widthCommitEpoch) {",
		);
		expect(finish).toContain("coordinator.finishResize(");
		expect(finish).not.toMatch(/contentWidth\s*[!=]==?/);
		const rebuildEffect = region(hook, "useEffect(");
		expect(rebuildEffect).toContain(finish);
		expect(rebuildEffect).toMatch(/^\s*options\.widthCommitEpoch,\s*$/m);
		expect(rebuildEffect).toContain("lastWidthCommitEpochRef.current = options.widthCommitEpoch");
	});

	it("refreshes a semantic snapshot or scrolled window through the active controller", () => {
		const source = shell();
		expect(resizeEffect(source)).toContain("resizeControllerRef.current = controller");
		const start = source.lastIndexOf(
			"useLayoutEffect(() => {",
			source.indexOf("void pretextDocument.resizeRevision;"),
		);
		expect(start).toBeGreaterThan(-1);
		const refresh = region(source.slice(start), "useLayoutEffect(");
		expect(refresh).toContain("resizeControllerRef.current?.refresh()");
		expect(refresh).toMatch(/\[pretextDocument\.resizeRevision,\s*scrollTop\]/);
		const scroll = region(source, "const processScrollFrame = useCallback(() => {");
		expect(scroll).toContain("resizeControllerRef.current?.refresh()");
		// Refresh reuses rAF preview, not observer evaluation that could rearm settling.
		expect(readVlistFile("vlist-live-resize.ts")).toMatch(/refresh:\s*preview\b/);
	});

	it("uses each item's actual outer width for rows instead of the shared live preview width", () => {
		const props = region(shell(), "const rowProps: ExactRowProps = {");
		expect(props).toMatch(/contentWidth:\s*item\.contentWidth\s*\?\?\s*contentWidth\b/);
		expect(props).not.toMatch(
			/contentWidth:\s*(?:displayContentWidth|pretextDocument\.resizeWidth)/,
		);
		const preview = readVlistFile("vlist-resize-preview.ts");
		expect(preview).toMatch(
			/nextItems\[itemIndex\]\s*=\s*\{\s*spec,\s*measured,\s*contentWidth:\s*width\s*\}/,
		);
		expect(preview).toMatch(/item\.contentWidth\s*\?\?\s*input\.committedWidth/);
	});

	it("observes the viewport node as a dependency, not a mount-time ref read", () => {
		const effect = resizeEffect(shell());
		expect(effect).toMatch(/const\s+node\s*=\s*viewportNode\s*;/);
		expect(effect).not.toMatch(/const\s+node\s*=\s*viewportRef\.current\s*;/);
		expect(effect).toMatch(
			/\[viewportNode,\s*centeredColumn,\s*readViewportView,\s*writeScrollTop\]/,
		);
	});

	it("mirrors the viewport node into state from the ref callback", () => {
		const assign = region(shell(), "const assignViewport = useCallback(");
		expect(assign.length).toBeGreaterThan(100);
		expect(assign).toContain("viewportRef.current = node;");
		expect(assign).toContain("setViewportNode(node);");
	});

	it("guard self-check: the actual resize layout effect includes options and observer", () => {
		const effect = resizeEffect(shell());
		expect(effect.length).toBeGreaterThan(500);
		expect(effect).toContain("createVListResizeController({");
		expect(effect).toContain("ResizeObserver");
		expect(effect).toContain("onCommit:");
	});
});

/**
 * The row memo must compare RENDER identity, not the disposable wrapper.
 *
 * `items[i] = { spec, measured }` is freshly allocated by every layout build, so
 * comparing `prev.item === next.item` made the memo miss on every rebuild even when
 * the row's content was byte-identical (measured: on a height-only rebuild 300/300
 * `measured` objects are the same object, yet all 1601 spans of a 20-row window were
 * rebuilt — 40 wasted row renders across two rebuilds, versus 0 with the relaxed
 * comparator).
 */
describe("ExactRow memo identity", () => {
	/**
	 * The comparator's CODE, with comments stripped.
	 *
	 * Stripping matters: the comment explaining why `prev.item === next.item` was
	 * removed contains that very expression, so a naive scan finds it and the
	 * "wrapper comparison is gone" assertion fails on its own documentation.
	 */
	function comparator(source: string): string {
		const start = source.indexOf("\t(prev, next) =>");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n);", start);
		expect(end).toBeGreaterThan(start);
		return source
			.slice(start, end)
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/\/\/[^\n]*/g, " ");
	}

	it("compares measured + spec identity rather than the item wrapper", () => {
		const cmp = comparator(row());
		expect(cmp).toContain("prev.item.measured === next.item.measured");
		expect(cmp).toContain("prev.item.spec.key === next.item.spec.key");
		expect(cmp).toContain("prev.item.spec.kind === next.item.spec.kind");
		// The wrapper comparison must be gone: it can never be true after a rebuild.
		expect(cmp).not.toMatch(/prev\.item\s*===\s*next\.item/);
	});

	// Everything the row paints from `spec` must be compared, or a change would not
	// reach the DOM. Today that is `key` and `unitId` (`data-nf-unit`).
	//
	// `data` is exempt: it is measured INTO `measured` (the comparator's first
	// clause), so a different `data` already yields a different `measured` object
	// and never needs its own comparison — see ExactRow's comparator comment and
	// measure-cache.extractDataRevision. Reads of `spec.data.*` in the row body are
	// for interaction callbacks (e.g. the reply-quote jump target), not paint.
	it("compares every spec field the row renders", () => {
		const source = row();
		const rowBody = source.slice(
			source.indexOf("const ExactRow = memo("),
			source.indexOf("\t(prev, next) =>"),
		);
		const readFields = new Set(
			[...rowBody.matchAll(/item\.spec\.([a-zA-Z]+)/g)].map((match) => match[1]),
		);
		readFields.delete("data");
		expect(readFields.size).toBeGreaterThan(0);
		const cmp = comparator(source);
		for (const field of readFields) {
			expect(cmp).toContain(`prev.item.spec.${field} === next.item.spec.${field}`);
		}
	});
});
