/** Public model metadata contract. No instance credentials or billing policy. */
export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export type Modality = "text" | "image" | "audio" | "video";
export interface ReferencePrices {
  input?: string | null;
  output?: string | null;
  cacheRead?: string | null;
  cacheWrite?: string | null;
}
export interface ModelMetadata {
  limits?: { contextWindow?: number | null; maxOutputTokens?: number | null };
  modalities?: { input?: Modality[] | null; output?: Modality[] | null };
  nativeSearch?: { supported?: boolean | null };
  reasoning?: {
    supported?: boolean | null;
    mode?: "levels" | "fixed" | "budget" | "unknown" | null;
    levels?: string[] | null;
    canDisable?: boolean | null;
    defaultLevel?: string | null;
  };
  referencePricing?: ReferencePrices & {
    currency?: "USD";
    unit?: "perMillionTokens";
    longContext?: ReferencePrices & {
      thresholdTokens?: number | null;
      basis?: "promptTokens";
      mode?: "full" | "marginal" | null;
    };
  };
}
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
  /** Narrow compatibility rules must not silently lend prices to other models. */
  fields?: string[];
}
export interface ModelDefinition {
  id: string;
  name?: string;
  vendor?: string;
  family?: string;
  notes?: string;
  matches?: MatchRules;
  metadata: ModelMetadata;
  status?: "verified" | "legacy-unverified" | "deprecated";
  sources?: MetadataSource[];
}
export interface ModelVariant {
  id: string;
  modelId: string;
  providerKey: string;
  upstreamModelIds: string[];
  name?: string;
  matches?: MatchRules;
  metadata: ModelMetadata;
  status?: "verified" | "legacy-unverified" | "deprecated";
  sources?: MetadataSource[];
}
export interface CatalogDocument {
  schemaVersion: 1;
  catalogVersion: string;
  publishedAt: string;
  models: ModelDefinition[];
  variants: ModelVariant[];
}
export interface ModelBinding {
  id: string;
  providerId?: string;
  channelId?: string;
  upstreamModelId: string;
  modelId?: string;
  variantId?: string;
  overrides?: ModelMetadata;
}
export interface ModelOverride {
  target: "model" | "variant" | "binding";
  targetId: string;
  metadata: ModelMetadata;
  source?: "user" | "legacy-local";
}
export interface LocalCatalogState {
  revision: number;
  models?: ModelDefinition[];
  variants?: ModelVariant[];
  bindings?: ModelBinding[];
  overrides?: ModelOverride[];
  hiddenModelIds?: string[];
  hiddenVariantIds?: string[];
}
export interface ModelQuery {
  upstreamModelId: string;
  providerKey?: string;
  providerId?: string;
  channelId?: string;
  modelId?: string;
  variantId?: string;
}
export interface FieldSource {
  layer: "default" | "preset-model" | "preset-variant" | "discovered" | "local-model" | "local-variant" | "local-binding";
  id?: string;
  catalogVersion?: string;
  explicit?: boolean;
  legacy?: boolean;
}
export interface ResolvedModelMetadata {
  schemaVersion: 1;
  catalogVersion: string;
  localRevision: number;
  modelId?: string;
  variantId?: string;
  bindingId?: string;
  matchedVia: "binding" | "exact" | "alias" | "suffix" | "prefix" | "none";
  metadata: ModelMetadata;
  provenance: Record<string, FieldSource>;
}
export interface ResolveModelMetadataInput {
  catalog: CatalogDocument;
  query: ModelQuery;
  local?: LocalCatalogState;
  discovered?: ModelMetadata;
  defaults?: ModelMetadata;
}
export interface MetadataPatch {
  /** Dot-path leaf values; keys are validated against the metadata contract. */
  set?: Record<string, unknown>;
  reset?: string[];
}
