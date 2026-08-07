/**
 * The two pool guards exist for the same PixiJS v8 flaw, seen from opposite ends:
 * a pool's return path assumes a bucket that a global `clear()` may already have
 * removed. `GlobalResourceRegistry.release()` — which any
 * `renderer.destroy(true)` in the process fires — is what removes it, and the
 * key→bucket map that drives the return path is NOT cleared alongside it.
 *
 * These tests drive the real Pixi singletons through that exact sequence
 * (check out → global clear → return) rather than mocking the pools, because the
 * bug is specifically about Pixi's internal bookkeeping surviving a clear.
 */
import { describe, expect, test } from "bun:test";
import { CanvasPool, GlobalResourceRegistry, TexturePool } from "pixi.js";
import { installPixiCanvasPoolHmrGuard } from "./pixi-hmr";

installPixiCanvasPoolHmrGuard();

describe("TexturePool return guard", () => {
	test("returning a texture after a global pool release does not throw", () => {
		const texture = TexturePool.getOptimalTexture(64, 32, 1, false);

		// What `renderer.destroy(true)` does process-wide. It empties
		// `_texturePool` but leaves `_poolKeyHash` pointing at the now-missing
		// bucket, which is the whole bug.
		GlobalResourceRegistry.release();

		// Pixi's unguarded path throws "Cannot read properties of undefined
		// (reading 'push')" here — from inside a text unload, mid-`app.destroy()`.
		expect(() => TexturePool.returnTexture(texture, true)).not.toThrow();
	});

	test("the returned texture is reusable, not dropped on the floor", () => {
		const texture = TexturePool.getOptimalTexture(64, 32, 1, false);
		GlobalResourceRegistry.release();
		TexturePool.returnTexture(texture, true);

		// Recreating the bucket only matters if the texture actually lands in it:
		// a guard that swallowed the return would leak a texture per unload.
		expect(TexturePool.getOptimalTexture(64, 32, 1, false)).toBe(texture);
	});

	test("a texture that never came from the pool is left to Pixi's own path", () => {
		// No `_poolKeyHash` entry → the guard must not invent a bucket keyed by
		// `undefined`, which would quietly collect foreign textures.
		const foreign = { uid: -1, source: {} } as never;
		const before = TexturePool.getOptimalTexture(16, 16, 1, false);
		TexturePool.returnTexture(before);

		expect(() => TexturePool.returnTexture(foreign)).toThrow();
	});
});

describe("CanvasPool return guard", () => {
	test("returning a canvas after a global pool release does not throw", () => {
		// Hand-built rather than checked out via `getOptimalCanvasAndContext`: that
		// path calls `document.createElement`, and this suite runs without a DOM.
		// The guard only reads `canvas.width/height`, and Pixi's original path only
		// calls `context.clearRect`, so a stand-in exercises the same bookkeeping.
		const cleared: number[][] = [];
		const canvasAndContext = {
			canvas: { width: 64, height: 32 },
			context: {
				resetTransform: () => {},
				clearRect: (x: number, y: number, w: number, h: number) => cleared.push([x, y, w, h]),
			},
		} as never;

		GlobalResourceRegistry.release();

		expect(() => CanvasPool.returnCanvasAndContext(canvasAndContext)).not.toThrow();
		// Reached Pixi's real return logic rather than being short-circuited.
		expect(cleared).toEqual([[0, 0, 64, 32]]);
	});
});

describe("guard installation", () => {
	test("is idempotent, so repeated module evaluation cannot stack wrappers", () => {
		const texturePatched = TexturePool.returnTexture;
		const canvasPatched = CanvasPool.returnCanvasAndContext;

		installPixiCanvasPoolHmrGuard();
		installPixiCanvasPoolHmrGuard();

		// Re-wrapping would nest the original call one level deeper each time an
		// HMR update re-evaluated the module.
		expect(TexturePool.returnTexture).toBe(texturePatched);
		expect(CanvasPool.returnCanvasAndContext).toBe(canvasPatched);
	});
});
