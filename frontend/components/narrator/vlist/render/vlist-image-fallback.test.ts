/**
 * vlist-image-fallback.test.ts — A screenshot's `previewUrl` is not durable.
 *
 * Browser / WebFetch screenshots are exposed through `/api/shares/<id>/preview`,
 * and shares live in an IN-MEMORY registry that `cleanupStaleShares()` wipes on
 * every server start (server/lib/shares.ts). So the `previewUrl` persisted with a
 * tool call from an earlier run resolves to 404 forever.
 *
 * Nothing in the vlist render path fetched that URL — it went straight to the
 * `<img>` — so a dead share produced a broken/blank image inside a reserved box,
 * which is what made screenshot rows read as tall empty placeholders. Two pieces
 * fix it, and this file locks both:
 *
 *   1. the classifier carries `savedFilePath` as a DURABLE fallback source, and
 *   2. the resolver retires a failed direct URL so that fallback is actually used,
 *      only reporting `error` when no durable source exists.
 *
 * Pure logic: the classifier is pure, and the resolver's decision table is
 * reproduced here rather than mounting React (the fetch needs a browser).
 */

import { describe, expect, it } from "bun:test";
import {
	classifyToolDetail,
	MEDIA_IMAGE_CONTENT_PX,
	type ToolCappedDetail,
	type ToolSectionsDetail,
} from "@shared/pretext-layout/tool-detail";
import { type ImageSourceState, resolveImageSource } from "./vlist-image";

/** Pull the media-capped section out of a classified detail. */
function mediaOf(detail: unknown): ToolCappedDetail {
	const sections = (detail as ToolSectionsDetail).sections;
	const found = sections.find((s) => s.body.kind === "capped" && s.body.cap === "media");
	expect(found).toBeDefined();
	return found?.body as ToolCappedDetail;
}

describe("browser screenshot media ref", () => {
	it("carries savedFilePath as a durable fallback beside the ephemeral previewUrl", () => {
		const detail = classifyToolDetail({
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot", url: "https://x.dev" },
			metadata: {
				previewUrl: "/api/shares/abc123/preview",
				savedFilePath: "/home/u/shot.png",
				sessionId: "s-1",
			},
		});
		const media = mediaOf(detail);
		expect(media.media?.previewUrl).toBe("/api/shares/abc123/preview");
		// Survives a server restart; the share behind previewUrl does not.
		expect(media.media?.filePath).toBe("/home/u/shot.png");
	});

	it("omits filePath when the screenshot was never written to disk", () => {
		const detail = classifyToolDetail({
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot", url: "https://x.dev" },
			metadata: { previewUrl: "/api/shares/abc123/preview" },
		});
		const media = mediaOf(detail);
		expect(media.media?.previewUrl).toBe("/api/shares/abc123/preview");
		expect(media.media?.filePath).toBeUndefined();
	});

	it("reserves the same height as a chat image block, not a taller estimate", () => {
		const detail = classifyToolDetail({
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot", url: "https://x.dev" },
			metadata: { previewUrl: "/p/x" },
		});
		expect(mediaOf(detail).contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The resolver's decision table — the REAL `resolveImageSource`, not a copy, so
// a change to the retirement rules cannot pass here while breaking the hook.
// ─────────────────────────────────────────────────────────────────────────────

interface ResolveState {
	previewUrl?: string;
	filePath?: string;
	imageId?: string;
	uploadNarratorId?: string;
	/** Srcs whose <img> load failed. */
	failed?: string[];
	/** A blob URL the fetch path produced, if any. */
	blobUrl?: string;
	/** Whether the fetch itself failed. */
	fetchError?: boolean;
}

function toState(s: ResolveState): ImageSourceState {
	return {
		rawDirect: s.previewUrl ?? null,
		filePath: s.filePath,
		imageId: s.imageId,
		uploadNarratorId: s.uploadNarratorId,
		blobUrl: s.blobUrl ?? null,
		fetchError: !!s.fetchError,
		failedSrcs: new Set(s.failed ?? []),
	};
}

const resolve = (s: ResolveState) => resolveImageSource(toState(s));

describe("useResolvedImageSrc failure handling", () => {
	it("uses a direct previewUrl untouched while it still works", () => {
		const r = resolve({ previewUrl: "/p/x", filePath: "/tmp/a.png" });
		expect(r.direct).toBe("/p/x");
		expect(r.error).toBe(false);
	});

	it("retires a dead previewUrl so the durable filePath fetch can run", () => {
		const r = resolve({ previewUrl: "/p/x", filePath: "/tmp/a.png", failed: ["/p/x"] });
		// Dropping `direct` is what lets the effect fall through to /api/fs/preview.
		expect(r.direct).toBeNull();
		// Not an error yet: the fallback has not been tried.
		expect(r.error).toBe(false);
	});

	it("reports an error for a dead previewUrl with no durable fallback", () => {
		const r = resolve({ previewUrl: "/p/x", failed: ["/p/x"] });
		expect(r.direct).toBeNull();
		expect(r.error).toBe(true);
	});

	it("treats an upload id + narrator id as a durable fallback too", () => {
		const r = resolve({
			previewUrl: "/p/x",
			imageId: "img1",
			uploadNarratorId: "n1",
			failed: ["/p/x"],
		});
		expect(r.error).toBe(false);
	});

	it("an imageId with no narrator id is NOT a usable fallback", () => {
		const r = resolve({ previewUrl: "/p/x", imageId: "img1", failed: ["/p/x"] });
		expect(r.error).toBe(true);
	});

	it("reports an error when the fallback blob itself fails to render", () => {
		const r = resolve({ filePath: "/tmp/a.png", blobUrl: "blob:1", failed: ["blob:1"] });
		expect(r.error).toBe(true);
	});

	it("propagates a fetch failure", () => {
		expect(resolve({ filePath: "/tmp/a.png", fetchError: true }).error).toBe(true);
	});

	it("a failure recorded for a DIFFERENT src does not poison the current one", () => {
		const r = resolve({ previewUrl: "/p/new", failed: ["/p/old"] });
		expect(r.direct).toBe("/p/new");
		expect(r.error).toBe(false);
	});

	it("does NOT revive a retired previewUrl once the blob lane is spent too", () => {
		// Both lanes retired: offering `/p/x` again is exactly the flip-flop below.
		const r = resolve({
			previewUrl: "/p/x",
			filePath: "/tmp/a.png",
			blobUrl: "blob:1",
			failed: ["/p/x", "blob:1"],
		});
		expect(r.direct).toBeNull();
		expect(r.error).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Convergence: the retirement rules driven across MULTIPLE frames.
//
// A single-frame assertion cannot catch two lanes taking turns, which is how the
// first version of this fix looped: it recorded only the LATEST failed src, so
// retiring the blob un-retired the direct URL (and vice versa) — a permanent
// cycle that re-fetched /api/fs/preview and allocated an object URL every pass.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the resolver as the hook does — feeding each frame's result back in —
 * against a world where every source loads but no `<img>` can render it.
 *
 * Models the effect's own behaviour: a live `direct` clears the blob, and an
 * absent one triggers a (successful) fetch producing a FRESH object URL, which is
 * what made the original loop unbounded rather than merely repetitive.
 */
function runFrames(
	ref: { previewUrl?: string; filePath?: string },
	maxFrames = 20,
): { frames: number; fetches: number; imgAttempts: number; settled: boolean } {
	const failed = new Set<string>();
	let blobUrl: string | null = null;
	let blobSeq = 0;
	let fetches = 0;
	let imgAttempts = 0;

	for (let frame = 1; frame <= maxFrames; frame++) {
		const { direct, error } = resolveImageSource({
			rawDirect: ref.previewUrl ?? null,
			filePath: ref.filePath,
			blobUrl,
			fetchError: false,
			failedSrcs: failed,
		});
		// The effect: a usable direct URL needs no fetch; otherwise fetch a blob.
		if (direct) blobUrl = null;
		else if (ref.filePath && blobUrl === null) {
			fetches++;
			blobUrl = `blob:${++blobSeq}`;
		}
		const src = direct ?? blobUrl;
		if (src == null || error) return { frames: frame, fetches, imgAttempts, settled: true };
		// The <img> tries this src and fails.
		imgAttempts++;
		failed.add(src);
	}
	return { frames: maxFrames, fetches, imgAttempts, settled: false };
}

describe("source retirement converges", () => {
	it("settles after trying each lane exactly once when both are dead", () => {
		const run = runFrames({ previewUrl: "/p/x", filePath: "/tmp/a.png" });
		expect(run.settled).toBe(true);
		// previewUrl, then the blob — and no third attempt.
		expect(run.imgAttempts).toBe(2);
		// Crucially only ONE /api/fs/preview request: the loop re-fetched every cycle.
		expect(run.fetches).toBe(1);
	});

	it("settles immediately when a dead previewUrl has no fallback", () => {
		const run = runFrames({ previewUrl: "/p/x" });
		expect(run.settled).toBe(true);
		expect(run.imgAttempts).toBe(1);
		expect(run.fetches).toBe(0);
	});

	it("settles when only the fetch lane exists and its blob cannot render", () => {
		const run = runFrames({ filePath: "/tmp/a.png" });
		expect(run.settled).toBe(true);
		expect(run.imgAttempts).toBe(1);
		expect(run.fetches).toBe(1);
	});
});
