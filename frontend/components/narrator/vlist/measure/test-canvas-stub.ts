/**
 * test-canvas-stub.ts — Deterministic OffscreenCanvas stub for measure tests.
 *
 * pretext measures text via OffscreenCanvas/DOM canvas `measureText`, which does
 * not exist in the bun test runtime. This stub provides a DETERMINISTIC width
 * model (each char = widthRatio × fontSize px), letting measure functions run
 * pretext's real line-breaking arithmetic under test without a browser.
 *
 * Real-font accuracy is validated separately by VListHarness in the browser
 * (the DOM-vs-predicted diff harness). Unit tests only assert the height MODEL
 * (chrome + line-count × line-height), not pixel-perfect font metrics.
 *
 * Usage (in a *.test.ts, before importing pretext-backed code):
 *   import { installCanvasStub } from "./test-canvas-stub";
 *   beforeAll(() => installCanvasStub());
 */

const FONT_SIZE_RE = /(\d+(?:\.\d+)?)px/;

export interface CanvasStubOptions {
	/** Average glyph advance as a fraction of font size (default 0.6). */
	widthRatio?: number;
}

/**
 * Install a deterministic global OffscreenCanvas stub. Idempotent-safe: it
 * overwrites any previous stub. Returns a disposer that removes it.
 */
export function installCanvasStub(opts: CanvasStubOptions = {}): () => void {
	const widthRatio = opts.widthRatio ?? 0.6;

	class StubTextMetrics {
		constructor(public width: number) {}
	}

	class StubCtx {
		font = "10px sans-serif";
		measureText(text: string): { width: number } {
			const m = FONT_SIZE_RE.exec(this.font);
			const size = m ? Number.parseFloat(m[1]!) : 10;
			return new StubTextMetrics(text.length * size * widthRatio);
		}
	}

	class StubOffscreenCanvas {
		width: number;
		height: number;
		constructor(width: number, height: number) {
			this.width = width;
			this.height = height;
		}
		getContext(): StubCtx {
			return new StubCtx();
		}
	}

	const g = globalThis as unknown as { OffscreenCanvas?: unknown };
	const prev = g.OffscreenCanvas;
	g.OffscreenCanvas = StubOffscreenCanvas as unknown;

	return () => {
		g.OffscreenCanvas = prev;
	};
}
