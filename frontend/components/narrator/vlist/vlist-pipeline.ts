/**
 * Compatibility boundary for the pretext layout pipeline.
 * Geometry/adaptation now lives in shared; this shell injects the frontend
 * measurement registry as the runtime provider.
 */

import type { VListLayoutResult } from "@shared/pretext-layout/layout-pipeline";
import {
	type ComputeLayoutOptions,
	computePretextVListLayout,
} from "@shared/pretext-layout/layout-pipeline";
import type { AdapterRenderUnit, AdapterSegment } from "@shared/pretext-layout/segment-adapter";
import { measureElement } from "./registry";

export * from "@shared/pretext-layout/layout-pipeline";

export function computeVListLayout(
	segmentsOrUnits: readonly AdapterSegment[] | readonly AdapterRenderUnit[],
	opts: ComputeLayoutOptions,
): VListLayoutResult {
	return computePretextVListLayout(segmentsOrUnits, opts, measureElement);
}
