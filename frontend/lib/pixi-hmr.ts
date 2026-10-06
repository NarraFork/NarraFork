import { type CanvasAndContext, CanvasPool, type Texture, TexturePool } from "pixi.js";

type CanvasPoolWithInternals = {
	_canvasPool?: Record<string | number, CanvasAndContext[]> | null;
	__narraforkReturnGuardInstalled?: boolean;
	returnCanvasAndContext(canvasAndContext: CanvasAndContext): void;
};

type TexturePoolWithInternals = {
	_texturePool?: Record<string | number, Texture[]> | null;
	_poolKeyHash?: Record<number, string | number> | null;
	__narraforkReturnGuardInstalled?: boolean;
	returnTexture(renderTexture: Texture, resetStyle?: boolean): void;
};

/**
 * PixiJS v8's CanvasPool assumes every returned canvas still has a bucket in
 * _canvasPool. During Vite HMR, Pixi's global resource cleanup can clear the
 * pool before old Text instances are unloaded, so CanvasRendererTextSystem may
 * return a previously checked-out canvas after its bucket has disappeared.
 *
 * Recreate the missing bucket before delegating to Pixi's original return logic.
 */
export function installPixiCanvasPoolHmrGuard(): void {
	installCanvasPoolGuard();
	installTexturePoolGuard();
}

function installCanvasPoolGuard(): void {
	const pool = CanvasPool as unknown as CanvasPoolWithInternals;
	if (pool.__narraforkReturnGuardInstalled) return;

	const originalReturnCanvasAndContext = pool.returnCanvasAndContext.bind(CanvasPool);

	pool.returnCanvasAndContext = (canvasAndContext: CanvasAndContext) => {
		const { width, height } = canvasAndContext.canvas;
		const key = (width << 17) + (height << 1);

		pool._canvasPool ??= Object.create(null) as Record<string | number, CanvasAndContext[]>;
		pool._canvasPool[key] ??= [];

		originalReturnCanvasAndContext(canvasAndContext);
	};

	pool.__narraforkReturnGuardInstalled = true;
}

/**
 * Same failure shape as the CanvasPool guard, one layer down.
 *
 * `TexturePool.returnTexture` does `this._texturePool[key].push(texture)` with no
 * check, where `key` comes from `_poolKeyHash[texture.uid]` — recorded when the
 * texture was checked out. `TexturePool.clear()` (reached via
 * `GlobalResourceRegistry.release()`, which any `renderer.destroy(true)`
 * anywhere in the process fires) resets `_texturePool` to `{}` WITHOUT clearing
 * `_poolKeyHash`, so every texture still checked out by a live `Text` now maps to
 * a bucket that no longer exists. The next text unload — a Pixi-internal
 * destroy/render step, not something we call — throws
 * "Cannot read properties of undefined (reading 'push')".
 *
 * That throw is unusually damaging because of WHERE it lands: it escapes from
 * `Application.destroy` between `stage.destroy()` and `renderer.destroy()`,
 * leaving a live renderer attached to a half-destroyed stage. Every later
 * `render()` then throws on a null render pipe, which reads like the renderer
 * itself broke.
 *
 * Recreating the bucket is exactly what Pixi's own checkout path does
 * (`getOptimalTexture` lazily creates `_texturePool[key]`), so the returned
 * texture lands in a valid pool rather than being dropped.
 */
function installTexturePoolGuard(): void {
	const pool = TexturePool as unknown as TexturePoolWithInternals;
	if (pool.__narraforkReturnGuardInstalled) return;

	const originalReturnTexture = pool.returnTexture.bind(TexturePool);

	pool.returnTexture = (renderTexture: Texture, resetStyle?: boolean) => {
		const key = pool._poolKeyHash?.[renderTexture.uid];
		// No recorded key means this texture never came from the pool; let Pixi's
		// original path decide what that means rather than inventing a bucket.
		if (key !== undefined) {
			pool._texturePool ??= Object.create(null) as Record<string | number, Texture[]>;
			pool._texturePool[key] ??= [];
		}

		originalReturnTexture(renderTexture, resetStyle);
	};

	pool.__narraforkReturnGuardInstalled = true;
}
