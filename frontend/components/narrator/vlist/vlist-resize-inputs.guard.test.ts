/**
 * Full-build inputs stay committed/bucketed while the production controller previews
 * the bounded live window. Behaviour lives in vlist-live-resize.test.ts; these guards
 * assert the shell -> controller -> document ownership that pure tests cannot see.
 */
import { describe, expect, it } from "bun:test";
import { readVlistFile, shellModule, shellSource } from "./guard-source";
import { sliceBracketedRegion } from "./source-slice";

function region(source: string, anchor: string): string {
	const result = sliceBracketedRegion(source, anchor);
	if (result === null) throw new Error(`Production resize region not found: ${anchor}`);
	return result;
}

function documentHookOptions(): string {
	return region(shellModule("PretextExactMessageList.tsx"), "usePretextDocument(narratorId, {");
}

function resizeOptions(): string {
	return region(shellModule("PretextExactMessageList.tsx"), "createVListResizeController({");
}

function controller(): string {
	return readVlistFile("vlist-live-resize.ts");
}

// Negative assertions cover the shell's whole module set plus the document bridge.
// The self-check below verifies that both extracted resize paths remain in that set.
function resizeSources(): string {
	return [
		shellSource(),
		readVlistFile("usePretextDocument.ts"),
		readVlistFile("pretext-layout-coordinator.ts"),
	].join("\n");
}

describe("resize inputs cannot reach the full layout at pixel resolution", () => {
	it("passes a BUCKETED committed height to the document hook, never the raw state", () => {
		const options = documentHookOptions();
		expect(options).toMatch(/viewportHeight:\s*layoutViewportHeight/);
		expect(options).not.toMatch(/viewportHeight:\s*(?:viewportHeight|layoutHeight)\b/);
		expect(options).not.toMatch(/^\s*viewportHeight,\s*$/m);
	});

	it("buckets layoutHeight, not the exact live viewportHeight", () => {
		const source = shellModule("PretextExactMessageList.tsx");
		expect(source).toMatch(
			/const\s+layoutViewportHeight\s*=\s*bucketViewportHeight\(\s*layoutHeight\s*\)/,
		);
		expect(source).not.toMatch(/bucketViewportHeight\(\s*viewportHeight\s*\)/);
	});

	it("keeps using the EXACT height for the mounted window", () => {
		expect(shellModule("PretextExactMessageList.tsx")).toMatch(
			/resolveVisibleWindow\(\s*exactLayout,\s*scrollTop,\s*viewportHeight/,
		);
	});

	it("keeps using the EXACT height for scroll anchoring", () => {
		expect(shellModule("PretextExactMessageList.tsx")).toMatch(
			/viewportHeight:\s*node\?\.clientHeight\s*\?\?\s*viewportHeightRef/,
		);
	});

	it("publishes global contentWidth only from onInitial and onCommit", () => {
		const options = resizeOptions();
		const callbacks = ["onInitial", "onCommit"].map((name) =>
			region(options, `${name}: ({ width, height }) => {`),
		);
		for (const callback of callbacks) {
			expect(callback.match(/setContentWidth\s*\(/g)).toHaveLength(1);
			expect(callback).toMatch(/committedContentWidthRef\.current\s*=\s*width\s*;/);
			expect(callback).toMatch(/setContentWidth\(width\)/);
		}
		// Each of the two writes is positively owned above, and there are no others
		// in any shell sibling or extracted production resize module.
		expect(resizeSources().match(/setContentWidth\s*\(/g)).toHaveLength(2);
		expect(resizeSources().match(/committedContentWidthRef\.current\s*=/g)).toHaveLength(2);
	});

	it("keeps preview out of global width and full-build height state", () => {
		const preview = region(resizeOptions(), "onPreview: ({ width, height }) => {");
		expect(preview.match(/setViewportHeight\s*\(/g)).toHaveLength(1);
		expect(preview).toMatch(/setViewportHeight\(height\)/);
		expect(preview).toMatch(/return\s+pretextDocumentRef\.current\.previewWidth\(width\)/);
		expect(preview).not.toMatch(/setContentWidth|setLayoutHeight|setWidthCommitEpoch/);
		expect(preview).not.toMatch(/committedContentWidthRef\.current\s*=/);
	});

	it("starts from an unmeasured sentinel, not a plausible width", () => {
		const source = shellModule("PretextExactMessageList.tsx");
		expect(source).toMatch(/const\s*\[contentWidth,\s*setContentWidth\]\s*=\s*useState\(0\)/);
		expect(source).toMatch(/const\s+committedContentWidthRef\s*=\s*useRef\(0\)/);
	});

	it("initializes synchronously on the controller observer path before settle or preview", () => {
		const source = controller();
		const evaluate = region(source, "function evaluate(trigger: WidthSettleTrigger): void {");
		const initial = region(evaluate, 'if (trigger === "observer" && committedWidth === 0) {');
		expect(evaluate).toMatch(/const\s+committedWidth\s*=\s*options\.getCommittedWidth\(\)/);
		expect(initial).toMatch(/options\.onInitial\(size\);\s*return;/);
		expect(initial).not.toMatch(/setTimer|requestFrame|resolveWidthSettle|onPreview|preview\(/);
		expect(evaluate.indexOf(initial)).toBeLessThan(evaluate.indexOf("resolveWidthSettle({"));
		expect(source).toMatch(/observe:\s*\(\)\s*=>\s*evaluate\("observer"\)/);
	});

	it("reads the LIVE pointer in the shell and controller settle path", () => {
		expect(resizeOptions()).toMatch(/pointerDown:\s*\(\)\s*=>\s*pointerTracker\.isDown\(\)/);
		const call = region(controller(), "resolveWidthSettle({");
		// Capture-phase release is explicitly final even before the tracker clears.
		expect(call).toMatch(
			/pointerDown:\s*trigger\s*===\s*"gesture-end"\s*\?\s*false\s*:\s*options\.pointerDown\(\)/,
		);
		expect(call).toMatch(/hasPendingPreview:\s*pending\b/);
	});

	it("threads node.offsetWidth through readSize into the controller settle decision", () => {
		const readSize = region(resizeOptions(), "readSize: () => ({");
		expect(readSize).toMatch(/width:\s*resolveNarratorColumnWidth\(node\.clientWidth,/);
		expect(readSize).toMatch(/boxWidth:\s*node\.offsetWidth\b/);
		expect(readSize).not.toMatch(/boxWidth:\s*node\.clientWidth\b/);
		const evaluate = region(controller(), "function evaluate(trigger: WidthSettleTrigger): void {");
		expect(evaluate).toMatch(/const\s+size\s*=\s*options\.readSize\(\)/);
		const call = region(evaluate, "resolveWidthSettle({");
		expect(call).toMatch(/boxWidth:\s*size\.boxWidth/);
		expect(call).toMatch(/committedBoxWidth[,:]/);
	});

	it("clears controller feedback history on host commits and gesture release", () => {
		const source = controller();
		const commit = region(source, "if (decision.commit) {");
		const reset = region(
			commit,
			'if (trigger === "gesture-end" || isExternalGeometryChange(size.boxWidth, committedBoxWidth)) {',
		);
		expect(reset).toMatch(/recentCommittedWidths\s*=\s*\[\]\s*;/);
		expect(commit).toMatch(/committedBoxWidth\s*=\s*size\.boxWidth\s*;/);
		expect(commit).toMatch(/pushCommittedWidth\(recentCommittedWidths,\s*size\.width\)/);
		expect(commit).toContain("options.onCommit(size)");
		const release = region(source, "release: () => {");
		expect(release).toMatch(/evaluate\("gesture-end"\)/);
		expect(release).toMatch(/if\s*\(!disposed\)\s*recentCommittedWidths\s*=\s*\[\]/);
	});

	it("passes NO cost estimate to the production settle decision", () => {
		const call = region(controller(), "resolveWidthSettle({");
		expect(call.length).toBeGreaterThan(40);
		expect(call).not.toMatch(/lastBuildMs|mountedRowCount|Budget|budget|cost|Cost/);
		for (const field of ["nextWidth", "committedWidth", "trigger", "pointerDown"]) {
			expect(call).toMatch(new RegExp(`${field}[,:]`));
		}
	});

	it("keeps no cost-tracking refs anywhere in the shell or new resize modules", () => {
		const source = resizeSources();
		expect(source).not.toContain("lastBuildMsRef");
		expect(source).not.toContain("mountedRowCountRef");
	});

	it("full-build width and dependencies consume committed state, never preview width", () => {
		const options = documentHookOptions();
		expect(options).toMatch(/widthBucket:\s*String\(Math\.round\(contentWidth\)\)/);
		expect(options).toMatch(/^\s*contentWidth,\s*$/m);
		expect(options).not.toMatch(/resizeWidth|displayContentWidth|previewWidth/);
		const build = region(
			readVlistFile("usePretextDocument.ts"),
			"const buildOptions = useMemo<PretextLayoutBuildOptions>(",
		);
		expect(build).toMatch(/contentWidth:\s*options\.contentWidth/);
		expect(build).toMatch(/^\s*options\.contentWidth,\s*$/m);
		expect(build).not.toMatch(/resizeWidth|resizeRevision|resizePreview|previewWidth|scrollTop/);
	});

	it("preview reflows existing specs without full adaptation or a full layout build", () => {
		const source = readVlistFile("pretext-layout-coordinator.ts");
		const start = source.indexOf("\tpreviewWidth(");
		expect(start).toBeGreaterThan(-1);
		const preview = region(source.slice(start), "): boolean {");
		expect(preview).toContain("previewResize({");
		expect(preview).toMatch(/items:\s*current\.items/);
		expect(preview).toMatch(/measure:\s*measureElementCached/);
		const paths = [preview, readVlistFile("vlist-resize-preview.ts")].join("\n");
		expect(paths).not.toMatch(
			/\b(?:buildPretext(?:DocumentLayout|LayoutManifest|EngineLayout)|compute(?:Pretext)?VListLayout|buildLayout|rebuild|adaptSegments|segmentMessages|groupRenderUnits)\s*\(/,
		);
		expect(paths).not.toMatch(
			/from\s*["'][^"']*(?:segment-adapter|message-segments|pretext-document-layout|pretext-layout-manifest)["']/,
		);
		expect(paths).not.toMatch(/lastBuildOptions\s*=|lastBuildOptions\.contentWidth\s*=/);
	});

	it("guard self-check: shell and extracted production option blocks are non-trivial", () => {
		expect(documentHookOptions().length).toBeGreaterThan(200);
		expect(documentHookOptions()).toContain("contentWidth");
		expect(resizeOptions()).toContain("onPreview:");
		expect(controller()).toContain("export function createVListResizeController(");
		for (const path of ["vlist-live-resize.ts", "vlist-resize-preview.ts"]) {
			expect(shellSource()).toContain(`/* ==== guard-source: ${path} ==== */`);
			expect(shellSource()).toContain(readVlistFile(path));
		}
	});
});
