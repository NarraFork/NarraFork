import type { ModelOverride, OverrideField } from "../override";
import type { MatchedVia } from "./catalog";

/** GET /api/model-catalog/status (and every update action's response). */
export interface CatalogStatus {
	/** Short catalog version (commit or bundle hash prefix). */
	version: string;
	publishedAt: string;
	source: "builtin" | "downloaded";
	models: number;
	autoUpdate: boolean;
	lastCheckedAt?: string;
	lastError?: string;
	/** A downloaded catalog waiting to be applied (only when auto update is off). */
	pending?: { version: string; publishedAt: string; added: number; changed: number };
}

/** Where an effective value comes from, in the words the editor shows. */
export type FieldOrigin =
	/** The public model catalog. */
	| "catalog"
	/** Reported by the gateway or the provider's model listing. */
	| "upstream"
	/** The provider's configured default context window. */
	| "provider"
	/** The user's model-wide override. */
	| "model"
	/** The user's override for this provider entry. */
	| "connection"
	/** Nothing declared; the runtime default applies. */
	| "default";

export type EffectiveFields = {
	[K in OverrideField]?: { value: NonNullable<ModelOverride[K]>; origin: FieldOrigin };
};

/** One provider entry (`provider:model`) as the models page and provider page show it. */
export interface ModelDescription {
	model: string;
	/** Catalog model this entry matched, if any. */
	catalogModelId?: string;
	catalogName?: string;
	matchedVia: MatchedVia;
	/**
	 * A model-wide override reaches this entry only on an exact or alias match; a
	 * prefix/suffix match is a look-alike and is edited per entry.
	 */
	modelWideEditable: boolean;
	effective: EffectiveFields;
	modelOverride?: ModelOverride;
	connectionOverride?: ModelOverride;
}

/** POST /api/model-catalog/models {models: string[]} */
export interface ModelDescriptionsResponse {
	revision: number;
	models: ModelDescription[];
}

/** PUT /api/model-catalog/overrides; `fields: null` clears the override. */
export interface ModelOverrideRequest {
	scope: "model" | "connection";
	/** Catalog model id for `model`, the full `provider:model` value for `connection`. */
	key: string;
	fields: ModelOverride | null;
}

/** Field-level rejection body (HTTP 400). */
export interface ModelOverrideError {
	error: string;
	code: "INVALID_OVERRIDE";
	field: string;
}
