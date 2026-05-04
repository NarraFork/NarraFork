import { type CanvasAndContext, CanvasPool } from "pixi.js";

type CanvasPoolWithInternals = {
	_canvasPool?: Record<string | number, CanvasAndContext[]> | null;
	__narraforkReturnGuardInstalled?: boolean;
	returnCanvasAndContext(canvasAndContext: CanvasAndContext): void;
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
