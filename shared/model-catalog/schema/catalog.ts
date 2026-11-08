/**
 * Model catalog contract. There is exactly one metadata representation: the open raw
 * map of source keys (LiteLLM style, e.g. `max_input_tokens`, `input_cost_per_token`).
 * It is what the public catalog publishes, what settings.json stores, what the runtime
 * keeps in memory and what every editor patches. Typed reads go through
 * `../profile`, which derives values and is never stored or converted back.
 */
export type JSONValue =
	| null
	| boolean
	| number
	| string
	| JSONValue[]
	| { [key: string]: JSONValue };
export type RawMetadata = { [key: string]: JSONValue };

export interface MetadataSource {
	label: string;
	url?: string;
	fields?: string[];
	verifiedAt?: string;
}
export interface MatchRules {
	ids?: string[];
	aliases?: string[];
	prefixes?: string[];
	volatileSuffixes?: boolean;
	/** Field groups a weak (prefix/suffix) match may borrow; see `MATCH_FIELD_GROUPS`. */
	fields?: string[];
}
export type EntryStatus = "verified" | "unverified" | "legacy-unverified" | "deprecated";
export interface RawModel {
	id: string;
	name?: string;
	vendor?: string;
	family?: string;
	notes?: string;
	matches?: MatchRules;
	metadata: RawMetadata;
	status?: EntryStatus;
	sources?: MetadataSource[];
}
export interface RawVariant extends RawModel {
	modelId: string;
	providerKey: string;
	upstreamModelIds: string[];
}
export interface RawCatalog {
	schemaVersion: 2;
	/** Format-qualified storage key; pinning uses sourceVersion, not this key. */
	catalogVersion: string;
	sourceVersion: string;
	publishedAt: string;
	models: RawModel[];
	variants: RawVariant[];
}
export type MetadataLayer =
	| "default"
	| "preset-model"
	| "preset-variant"
	| "discovered"
	/** The user's model-wide override. */
	| "local-model"
	/** The user's override for one provider entry. */
	| "local-connection";
export interface FieldSource {
	layer: MetadataLayer;
	id?: string;
	catalogVersion?: string;
	explicit?: boolean;
	/** From a catalog entry not yet verified against its vendor's documentation. */
	legacy?: boolean;
}
export type MatchedVia = "exact" | "alias" | "suffix" | "prefix" | "none";
