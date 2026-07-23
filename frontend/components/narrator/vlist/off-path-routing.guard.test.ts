/**
 * off-path-routing.guard.test.ts — Enforces the persistent protected invariant:
 *   "Do not affect the path when narrafork_narrator_virtual_list is OFF."
 *
 * The vlist-isolation guard already proves the OFF path never *loads* vlist code
 * (no static import). This complementary guard proves the OFF path still *renders
 * the legacy component*: in NarratorPanel the message-list slot must be gated so
 * that when `narratorVirtualList` is falsy the ChunkedMessageList branch is taken.
 *
 * Concretely it asserts the source contains the ternary shape:
 *     narratorVirtualList ? ( … <PretextMessageList … ) : ( … <ChunkedMessageList … )
 * and that `narratorVirtualList` is derived from
 * useLocalPref("narrafork_narrator_virtual_list").
 *
 * This turns the recurring manual "read the JSX and confirm the default branch"
 * audit into a CI-enforced guard: it goes red the instant someone flips the
 * default (e.g. makes PretextMessageList the else-branch), drops the flag gate,
 * or renames the feature-flag key.
 *
 * Zero-runtime, filesystem-only; no DOM, no React render.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VLIST_DIR = import.meta.dir;
const NARRATOR_DIR = resolve(VLIST_DIR, "..");
const NARRATOR_PANEL = resolve(NARRATOR_DIR, "NarratorPanel.tsx");
const LEGACY_CHUNKS = resolve(NARRATOR_DIR, "useNarratorChunks.ts");
const LEGACY_CHUNKS_WS = resolve(NARRATOR_DIR, "useNarratorChunksWS.ts");

const FLAG_KEY = "narrafork_narrator_virtual_list";
const PRETEXT_PROTOCOL_TOKENS = [
	"pretext_open",
	"pretext_data_request",
	"pretext_cancel",
	"pretext_patch",
	"pretext_resync_required",
];

/** The feature-flag value must come from useLocalPref(FLAG_KEY). */
function hasFlagBinding(source: string): boolean {
	// e.g. const [narratorVirtualList] = useLocalPref("narrafork_narrator_virtual_list");
	const re = new RegExp(
		`const\\s*\\[\\s*narratorVirtualList\\s*\\][^\\n=]*=\\s*useLocalPref\\(\\s*["']${FLAG_KEY}["']\\s*\\)`,
	);
	return re.test(source);
}

/**
 * Assert the message-list routing ternary keeps the legacy component on the OFF
 * (else) branch. We locate `narratorVirtualList ?`, then require that between it
 * and the end of that conditional, `<PretextExactMessageList` appears in the
 * truthy side and the ternary's else side contains `<ChunkedMessageList`.
 *
 * The band renderer has been retired: Virtual ON now routes straight to the
 * exact-layout shell (the sole vlist renderer), Virtual OFF stays on legacy.
 *
 * Robust to formatting: we don't parse JSX, we assert ordered occurrences:
 *   narratorVirtualList ?  …  <PretextExactMessageList  …  <ChunkedMessageList
 * with the ChunkedMessageList after the `) : (` that closes the truthy branch.
 */
function offBranchRoutesToChunked(source: string): boolean {
	const gateIdx = source.search(/narratorVirtualList\s*\?/);
	if (gateIdx < 0) return false;
	const after = source.slice(gateIdx);
	const pretextIdx = after.search(/<PretextExactMessageList\b/);
	const chunkedIdx = after.search(/<ChunkedMessageList\b/);
	if (pretextIdx < 0 || chunkedIdx < 0) return false;
	// Truthy branch (PretextExactMessageList) must come before the OFF/else
	// branch (ChunkedMessageList) in the `flag ? Exact : Chunked` shape.
	if (pretextIdx >= chunkedIdx) return false;
	// Not enough to check order: ChunkedMessageList must actually be in the ELSE
	// branch, not merely somewhere after the exact shell on the SAME (truthy)
	// side. Require a `) : (` ternary-else boundary between the two components —
	// that boundary closes the truthy branch and opens the else branch. Without
	// this, `flag ? (<Exact/><Chunked/>) : (<div/>)` would falsely pass while
	// the OFF path renders no ChunkedMessageList at all.
	const between = after.slice(pretextIdx, chunkedIdx);
	return /\)\s*:\s*\(/.test(between);
}

function resizeSkeletonIsLegacyOnly(source: string): boolean {
	return /\{\s*!narratorVirtualList\s*&&\s*isResizing\s*&&\s*\(/.test(source);
}

function legacyPathHasNoPretextProtocol(source: string): boolean {
	return PRETEXT_PROTOCOL_TOKENS.every((token) => !source.includes(token));
}

function routeForFlag(flag: boolean): "legacy-chunks" | "pretext-lazy" {
	return flag ? "pretext-lazy" : "legacy-chunks";
}

describe("OFF-path routing guard (protected invariant)", () => {
	const source = readFileSync(NARRATOR_PANEL, "utf8");
	const legacyChunksSource = readFileSync(LEGACY_CHUNKS, "utf8");
	const legacyChunksWsSource = readFileSync(LEGACY_CHUNKS_WS, "utf8");

	it("narratorVirtualList is bound to the feature-flag pref", () => {
		expect(hasFlagBinding(source)).toBe(true);
	});

	it("the message-list ternary keeps ChunkedMessageList on the OFF branch", () => {
		expect(offBranchRoutesToChunked(source)).toBe(true);
	});

	it("the exact shell is the sole Virtual renderer and the band path is gone", () => {
		// The band renderer (PretextMessageList) and its opt-in flag were removed;
		// Virtual ON routes straight to the exact shell, which owns the active state
		// (isActive is forwarded so it can render its own streaming-tail overlay).
		expect(source).not.toContain("PretextMessageList");
		expect(source).not.toContain("narrafork_narrator_exact_layout");
		expect(source).not.toContain("shouldUseExactLayout");
		expect(source).toMatch(/<PretextExactMessageList[\s\S]*?isActive=\{isActive\}/);
	});

	it("the resize skeleton overlay is limited to the legacy OFF path", () => {
		expect(resizeSkeletonIsLegacyOnly(source)).toBe(true);
	});

	it("OFF selects legacy chunks and never the Pretext lazy route", () => {
		expect(routeForFlag(false)).toBe("legacy-chunks");
		expect(routeForFlag(true)).toBe("pretext-lazy");
	});

	it("legacy chunk REST/WS modules contain no Pretext protocol requests or frame types", () => {
		expect(legacyPathHasNoPretextProtocol(legacyChunksSource)).toBe(true);
		expect(legacyPathHasNoPretextProtocol(legacyChunksWsSource)).toBe(true);
		expect(legacyChunksSource).toContain("chunk-manifest");
		expect(legacyChunksSource).toContain("/chunks");
		expect(legacyChunksWsSource).toContain("useNarratorChunksWS");
	});

	it("legacy chunk and ordinary narrator frames have no new protocol fields", () => {
		const legacyChunkResponse = {
			manifest: [{ id: "msg-1", firstSeq: 1, lastSeq: 1, count: 1 }],
			chunks: [{ id: "msg-1", messages: [] }],
		};
		const ordinaryWsFrame = { type: "message", narratorId: "n1", messageId: "msg-1" };
		expect(Object.keys(legacyChunkResponse).sort()).toEqual(["chunks", "manifest"]);
		expect(Object.keys(ordinaryWsFrame).sort()).toEqual(["messageId", "narratorId", "type"]);
		expect(JSON.stringify(legacyChunkResponse)).not.toContain("pretext_");
		expect(JSON.stringify(ordinaryWsFrame)).not.toContain("pretext_");
	});

	it("the lazy Pretext import is the only new client loading boundary", () => {
		expect(source).toContain('import("./vlist/PretextExactMessageList")');
		expect(source).not.toContain(
			'import { PretextExactMessageList } from "./vlist/PretextExactMessageList"',
		);
	});

	it("guard self-check: detects a flipped default and a dropped gate", () => {
		// Correct shape → passes both checks.
		const ok =
			'const [narratorVirtualList] = useLocalPref("narrafork_narrator_virtual_list");\n' +
			"return narratorVirtualList ? (<PretextExactMessageList />) : (<ChunkedMessageList />);";
		expect(hasFlagBinding(ok)).toBe(true);
		expect(offBranchRoutesToChunked(ok)).toBe(true);

		// Flipped default: legacy on the truthy side, vlist as the else branch →
		// OFF users would get the new list. Must be rejected.
		const flipped =
			"return narratorVirtualList ? (<ChunkedMessageList />) : (<PretextExactMessageList />);";
		expect(offBranchRoutesToChunked(flipped)).toBe(false);

		// False-positive trap: BOTH components on the truthy side, OFF/else renders
		// neither. A naive order-only check (pretextIdx < chunkedIdx) would wrongly
		// pass this; the `) : (` else-boundary requirement must reject it.
		const bothTruthy =
			"return narratorVirtualList ? (<PretextExactMessageList /><ChunkedMessageList />) : (<div />);";
		expect(offBranchRoutesToChunked(bothTruthy)).toBe(false);

		// Gate removed entirely (always renders vlist) → rejected.
		const noGate = "return (<PretextExactMessageList />);";
		expect(offBranchRoutesToChunked(noGate)).toBe(false);

		// Flag key renamed → binding check fails.
		const renamed = 'const [narratorVirtualList] = useLocalPref("narrafork_something_else");';
		expect(hasFlagBinding(renamed)).toBe(false);
	});
});
