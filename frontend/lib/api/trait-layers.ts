import { request } from "./client";

/** The two layers above a narrator. */
export type TraitLayer = "project" | "user";

export interface LayerEnforcedFlags {
	disabledTools: boolean;
	blockedSkills: boolean;
	subagentModels: boolean;
}

export interface LayerDeviceInjection {
	version: 1;
	/** "global" (the default) injects only admin-registered global devices. */
	defaultMode: "none" | "private" | "global" | "all";
	/** Per-device tri-state overrides, keyed by device id. */
	devices: Record<string, "on" | "off">;
}

/**
 * Response shape shared by every trait-layer endpoint. `customTraits` is
 * deliberately identical to the narrator-level response so one editor component
 * can drive all three layers.
 */
export interface LayerTraitsResponse {
	ok: boolean;
	layer: TraitLayer;
	enforced: LayerEnforcedFlags;
	customTraits: {
		subagentModelRestriction: {
			version: 1;
			pools: Record<string, { model: string; purpose?: string }[]>;
		} | null;
		disabledTools: { version: 1; tools: string[] } | null;
		blockedSkills: { version: 1; all: boolean; names: string[] } | null;
		availableModels: { model: string; purpose?: string }[];
		availableTools: { name: string; description: string; category: string }[];
	};
	deviceInjection: LayerDeviceInjection | null;
}

function base(layer: TraitLayer, ownerId: string): string {
	return `/trait-layers/${layer}/${encodeURIComponent(ownerId)}`;
}

/**
 * Method names are prefixed with `Layer` because this object is spread into the
 * shared `api` barrel alongside the narrator-level trait methods, which take a
 * narrator id rather than a (layer, ownerId) pair. Sharing a name there would
 * silently shadow one of them.
 */
export const traitLayersApi = {
	getLayerTraits: (layer: TraitLayer, ownerId: string) =>
		request<LayerTraitsResponse>(base(layer, ownerId)),

	updateLayerDisabledTools: (
		layer: TraitLayer,
		ownerId: string,
		payload: { tools: string[]; enforced: boolean },
	) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/disabled-tools`, {
			method: "PUT",
			body: JSON.stringify(payload),
		}),
	clearLayerDisabledTools: (layer: TraitLayer, ownerId: string) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/disabled-tools`, { method: "DELETE" }),

	updateLayerBlockedSkills: (
		layer: TraitLayer,
		ownerId: string,
		payload: { all: boolean; names: string[]; enforced: boolean },
	) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/blocked-skills`, {
			method: "PUT",
			body: JSON.stringify(payload),
		}),
	clearLayerBlockedSkills: (layer: TraitLayer, ownerId: string) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/blocked-skills`, { method: "DELETE" }),

	updateLayerSubagentModelRestriction: (
		layer: TraitLayer,
		ownerId: string,
		payload: {
			pools: Record<string, { model: string; purpose?: string }[]>;
			enforced: boolean;
		},
	) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/subagent-model-restriction`, {
			method: "PUT",
			body: JSON.stringify(payload),
		}),
	clearLayerSubagentModelRestriction: (layer: TraitLayer, ownerId: string) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/subagent-model-restriction`, {
			method: "DELETE",
		}),

	updateLayerDeviceInjection: (
		layer: TraitLayer,
		ownerId: string,
		payload: Omit<LayerDeviceInjection, "version">,
	) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/device-injection`, {
			method: "PUT",
			body: JSON.stringify({ version: 1, ...payload }),
		}),
	clearLayerDeviceInjection: (layer: TraitLayer, ownerId: string) =>
		request<LayerTraitsResponse>(`${base(layer, ownerId)}/device-injection`, { method: "DELETE" }),
};
