/**
 * Compatibility boundary for the pretext layout pipeline.
 * Geometry/adaptation now lives in shared; this shell injects the frontend
 * measurement registry as the runtime provider.
 */

import type { VListLayoutResult } from "@shared/pretext-layout/layout-pipeline";
import {
	computePretextVListLayout,
	type MeasureElement,
	type ComputeLayoutOptions as SharedComputeLayoutOptions,
} from "@shared/pretext-layout/layout-pipeline";
import type { AdapterRenderUnit, AdapterSegment } from "@shared/pretext-layout/segment-adapter";
import { measureElementCached } from "./registry";

export * from "@shared/pretext-layout/layout-pipeline";

export interface ComputeLayoutOptions extends SharedComputeLayoutOptions {
	/** Document-owned measurement provider; never persisted in a document snapshot. */
	measure?: MeasureElement;
}

export function computeVListLayout(
	segmentsOrUnits: readonly AdapterSegment[] | readonly AdapterRenderUnit[],
	opts: ComputeLayoutOptions,
): VListLayoutResult {
	return computePretextVListLayout(segmentsOrUnits, opts, opts.measure ?? measureElementCached);
}
