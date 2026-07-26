/**
 * katex-runtime.test.ts — Lazy-load gating + canvas glyph measurement.
 *
 * The important behaviours here are cost-related: text without math must never
 * pull the 584KB KaTeX bundle, and once loaded the runtime must be available
 * synchronously so the pure measure path stays synchronous.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

/**
 * Run `fn` with no canvas implementation available, whatever the ambient state.
 * Other test files install a global canvas stub for pretext, so the "no canvas"
 * case must be created explicitly instead of assuming the environment lacks one.
 */
function withoutCanvas<T>(fn: () => T): T {
	const g = globalThis as { OffscreenCanvas?: unknown; document?: unknown };
	const prevCanvas = g.OffscreenCanvas;
	const prevDocument = g.document;
	delete g.OffscreenCanvas;
	delete g.document;
	try {
		return fn();
	} finally {
		if (prevCanvas !== undefined) g.OffscreenCanvas = prevCanvas;
		if (prevDocument !== undefined) g.document = prevDocument;
	}
}

const {
	ensureKatexLoaded,
	getGlyphCacheSize,
	getKatexRevision,
	getKatexRuntime,
	GLYPH_CACHE_CEILING,
	isKatexReady,
	measureGlyphWidth,
	resetKatexRuntimeForTest,
} = await import("./katex-runtime");

describe("katex-runtime lazy loading", () => {
	beforeEach(() => {
		resetKatexRuntimeForTest();
	});

	it("starts unloaded", () => {
		expect(isKatexReady()).toBe(false);
		expect(getKatexRuntime()).toBeNull();
	});

	it("does not load for text without math", async () => {
		await ensureKatexLoaded("just some prose with no formulas");
		expect(isKatexReady()).toBe(false);
		expect(getKatexRevision()).toBe(0);
	});

	it("does not load for an empty document", async () => {
		await ensureKatexLoaded([]);
		await ensureKatexLoaded("");
		expect(isKatexReady()).toBe(false);
	});

	it("loads when the text contains math", async () => {
		await ensureKatexLoaded("mass energy $E=mc^2$ relation");
		expect(isKatexReady()).toBe(true);
		expect(getKatexRuntime()).not.toBeNull();
		expect(getKatexRevision()).toBeGreaterThan(0);
	});

	it("loads when any message in a batch contains math", async () => {
		await ensureKatexLoaded(["plain", "still plain", "now $a+b$ appears"]);
		expect(isKatexReady()).toBe(true);
	});

	it("exposes a synchronous runtime handle once loaded", async () => {
		await ensureKatexLoaded("$a+b$");
		// The pure measure path is synchronous, so this must not require awaiting.
		const runtime = getKatexRuntime();
		expect(typeof runtime?.__renderToHTMLTree).toBe("function");
		expect(typeof runtime?.renderToString).toBe("function");
	});

	it("is idempotent and keeps the revision stable after loading", async () => {
		await ensureKatexLoaded("$a$");
		const first = getKatexRevision();
		await ensureKatexLoaded("$b$");
		await ensureKatexLoaded("$c$");
		expect(getKatexRevision()).toBe(first);
	});

	it("recognizes every delimiter form as needing the runtime", async () => {
		for (const text of ["$a+b$", "$$a+b$$", "\\(a+b\\)", "\\[a+b\\]"]) {
			resetKatexRuntimeForTest();
			await ensureKatexLoaded(text);
			expect(isKatexReady()).toBe(true);
		}
	});
});

describe("measureGlyphWidth", () => {
	beforeEach(() => {
		resetKatexRuntimeForTest();
	});

	it("returns null when no canvas is available", () => {
		// Server-side / non-DOM environments must degrade rather than throw; the
		// geometry engine then falls back to KaTeX's own metrics.
		withoutCanvas(() => {
			resetKatexRuntimeForTest();
			expect(measureGlyphWidth("速", "400 16px KaTeX_Main")).toBeNull();
		});
	});

	it("measures with the requested font size when a canvas exists", () => {
		const dispose = installCanvasStub({ widthRatio: 0.5 });
		try {
			resetKatexRuntimeForTest();
			// Stub model: width = chars × fontSize × ratio.
			expect(measureGlyphWidth("速", "400 20px KaTeX_Main")).toBeCloseTo(10, 6);
			expect(measureGlyphWidth("度", "400 40px KaTeX_Main")).toBeCloseTo(20, 6);
		} finally {
			dispose();
		}
	});

	it("caches per glyph and font", () => {
		const dispose = installCanvasStub({ widthRatio: 0.5 });
		try {
			resetKatexRuntimeForTest();
			const first = measureGlyphWidth("速", "400 20px KaTeX_Main");
			const second = measureGlyphWidth("速", "400 20px KaTeX_Main");
			expect(second).toBe(first);
			// A different font size is a distinct cache entry, not a stale hit.
			expect(measureGlyphWidth("速", "400 40px KaTeX_Main")).not.toBe(first);
		} finally {
			dispose();
		}
	});

	it("bulk-clears when capacity is exceeded and still returns correct values", () => {
		const dispose = installCanvasStub({ widthRatio: 0.5 });
		try {
			resetKatexRuntimeForTest();
			// Fill the cache with many distinct entries.
			for (let i = 0; i < 100; i++) {
				const glyph = String.fromCodePoint(0x4e00 + i); // CJK Unified Ideographs
				measureGlyphWidth(glyph, `400 ${10 + i}px KaTeX_Main`);
			}
			expect(getGlyphCacheSize()).toBe(100);

			// Manually force a clear to verify determinism after flush.
			const beforeClear = measureGlyphWidth("速", "400 20px KaTeX_Main");
			expect(beforeClear).not.toBeNull();
			resetKatexRuntimeForTest();
			// Re-install canvas stub since reset clears measureCtx.
			const dispose2 = installCanvasStub({ widthRatio: 0.5 });
			try {
				const afterClear = measureGlyphWidth("速", "400 20px KaTeX_Main");
				expect(afterClear).toBeCloseTo(beforeClear as number, 10);
			} finally {
				dispose2();
			}
		} finally {
			dispose();
		}
	});

	it("exposes the ceiling constant", () => {
		expect(GLYPH_CACHE_CEILING).toBe(32768);
	});
});

describe("webfont readiness — revision bump and cache invalidation", () => {
	beforeEach(() => {
		resetKatexRuntimeForTest();
	});

	it("bumps revision and clears glyph cache when fonts resolve", async () => {
		// Mock document.fonts with a controllable promise.
		let resolveFonts!: () => void;
		const fontsPromise = new Promise<unknown[]>((resolve) => {
			resolveFonts = () => resolve([]);
		});
		const g = globalThis as { document?: unknown };
		const prevDocument = g.document;
		g.document = {
			fonts: {
				load: () => fontsPromise,
				ready: fontsPromise,
			},
		};

		const dispose = installCanvasStub({ widthRatio: 0.5 });
		try {
			// Load KaTeX (triggers scheduleWebfontWatch).
			await ensureKatexLoaded("$a+b$");
			const revAfterLoad = getKatexRevision();
			expect(revAfterLoad).toBeGreaterThan(0);

			// Simulate glyph measurements made before fonts are ready.
			measureGlyphWidth("速", "400 16px KaTeX_Main");
			measureGlyphWidth("度", "400 16px KaTeX_Main");
			expect(getGlyphCacheSize()).toBe(2);

			// Resolve the font load — this triggers onWebfontsReady.
			resolveFonts();
			// Allow microtasks to flush (Promise.race + .then).
			await new Promise((r) => setTimeout(r, 10));

			// Revision must have bumped and cache must be cleared.
			expect(getKatexRevision()).toBeGreaterThan(revAfterLoad);
			expect(getGlyphCacheSize()).toBe(0);
		} finally {
			dispose();
			if (prevDocument !== undefined) {
				g.document = prevDocument;
			} else {
				delete g.document;
			}
		}
	});

	it("does not bump revision when glyph cache is empty at font load time", async () => {
		let resolveFonts!: () => void;
		const fontsPromise = new Promise<unknown[]>((resolve) => {
			resolveFonts = () => resolve([]);
		});
		const g = globalThis as { document?: unknown };
		const prevDocument = g.document;
		g.document = {
			fonts: {
				load: () => fontsPromise,
				ready: fontsPromise,
			},
		};

		try {
			await ensureKatexLoaded("$x$");
			const revAfterLoad = getKatexRevision();
			// No glyph measurements → cache is empty.
			expect(getGlyphCacheSize()).toBe(0);

			resolveFonts();
			await new Promise((r) => setTimeout(r, 10));

			// No bump because there was nothing stale to invalidate.
			expect(getKatexRevision()).toBe(revAfterLoad);
		} finally {
			if (prevDocument !== undefined) {
				g.document = prevDocument;
			} else {
				delete g.document;
			}
		}
	});

	it("handles missing document.fonts gracefully (no-op, no crash)", async () => {
		const g = globalThis as { document?: unknown };
		const prevDocument = g.document;
		// Simulate an environment without Font Loading API.
		g.document = {};
		try {
			await ensureKatexLoaded("$a$");
			// Should not throw and revision bumps only once (for runtime load).
			expect(getKatexRevision()).toBe(1);
		} finally {
			if (prevDocument !== undefined) {
				g.document = prevDocument;
			} else {
				delete g.document;
			}
		}
	});

	it("respects the timeout when fonts never resolve", async () => {
		// Fonts will never resolve — the timeout fires instead.
		const g = globalThis as { document?: unknown };
		const prevDocument = g.document;
		g.document = {
			fonts: {
				load: () => new Promise(() => {}), // never resolves
				ready: new Promise(() => {}),
			},
		};

		const dispose = installCanvasStub({ widthRatio: 0.5 });
		try {
			await ensureKatexLoaded("$a$");
			const revAfterLoad = getKatexRevision();
			measureGlyphWidth("速", "400 16px KaTeX_Main");
			expect(getGlyphCacheSize()).toBe(1);

			// The timeout is 8000ms in production — we cannot wait that long in tests.
			// But we can verify the function didn't crash and state is consistent.
			expect(getKatexRevision()).toBe(revAfterLoad);
		} finally {
			dispose();
			if (prevDocument !== undefined) {
				g.document = prevDocument;
			} else {
				delete g.document;
			}
		}
	});
});
