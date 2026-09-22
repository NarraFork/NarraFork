import type { CatalogDocument, LocalCatalogState, MetadataPatch, ModelBinding, ModelDefinition, ModelQuery, ModelVariant, ResolvedModelMetadata } from "./catalog";

/** Common wire shapes. API roots differ between the two applications. */
export interface CatalogUpdateStatus {
  activeVersion: string;
  bundledVersion: string;
  lastCheckedAt?: string;
  pendingVersion?: string;
  lastError?: string;
  autoApply: boolean;
  pinnedVersion: string | null;
  history: Array<{ catalogVersion: string; publishedAt: string }>;
  protectedFieldCount?: number;
  pendingDiff?: {
    added: string[];
    changed: string[];
    removed: string[];
    /** Metadata leaf differences; absence of before/after means inheritance. */
    fields?: Array<{ target: "model" | "variant"; id: string; path: string; before?: unknown; after?: unknown }>;
  };
}
export interface ModelCatalogSnapshot {
  catalog: CatalogDocument;
  local: LocalCatalogState;
  update: CatalogUpdateStatus;
}
export type ModelCatalogMutation =
  | { baseRevision: number; action: "upsert-model"; model: ModelDefinition }
  | { baseRevision: number; action: "upsert-variant"; variant: ModelVariant }
  | { baseRevision: number; action: "upsert-binding"; binding: ModelBinding }
  | { baseRevision: number; action: "patch"; target: "model" | "variant" | "binding"; targetId: string; patch: MetadataPatch }
  | { baseRevision: number; action: "hide" | "restore" | "delete"; target: "model" | "variant" | "binding"; targetId: string };
/** GET root -> snapshot; POST root/mutate -> mutation -> snapshot.
 * POST root/resolve -> {query} -> resolved (includes actual discovery/defaults).
 * POST root/updates/check -> snapshot.
 * POST root/updates/apply -> {version?: string} -> snapshot (staged checked version only).
 * POST root/updates/rollback -> {version: string} -> snapshot (retained version only).
 * PATCH root/updates/settings -> {autoApply?: boolean,pinnedVersion?: string|null} -> snapshot.
 * Stale baseRevision -> HTTP 409. Failed validation -> HTTP 400. Admin writes only.
 */
export interface ModelCatalogResolveRequest { query: ModelQuery }
export type ModelCatalogResolveResponse = ResolvedModelMetadata;
