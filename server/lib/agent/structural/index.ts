/**
 * Structural kernel entry point.
 *
 * Registers the providers in priority order (accurate first, always-available last)
 * and re-exports the pieces the tools and routes consume. Import order matters:
 * `resolveProvider` walks the registry in registration order, so tree-sitter must
 * be registered before the heuristic fallback or accurate parsing would never be
 * reached.
 */
import { heuristicProvider } from "./heuristic-provider";
import { registerStructureProvider } from "./provider";
import { treeSitterProvider } from "./tree-sitter-provider";

let registered = false;

/** Register the built-in providers. Idempotent. */
export function registerStructureProviders(): void {
	if (registered) return;
	registered = true;
	registerStructureProvider(treeSitterProvider);
	registerStructureProvider(heuristicProvider);
}

registerStructureProviders();

export type { Address, AddressBlock } from "./address";
export { AddressError, parseAddress, resolveAddress } from "./address";
export type {
	CrossFileUsageResult,
	RawFileHit,
	UsageConfidence,
	UsageFile,
} from "./cross-file-usages";
export {
	assembleUsages,
	CROSS_FILE_PRECISION_NOTE,
	importMayReferTo,
} from "./cross-file-usages";
export type {
	ExtractionInterface,
	InterfaceSymbol,
} from "./extraction-interface";
export { analyzeExtraction, straddlingDeclarations } from "./extraction-interface";
export type { GrammarTier } from "./grammar-manifest";
export {
	EXCLUDED_GRAMMARS,
	GRAMMAR_MANIFEST,
	GRAMMAR_PACKAGE_VERSION,
	getGrammarEntry,
	isKnownGrammarLanguage,
	languageIdForExtension,
} from "./grammar-manifest";
export type { GrammarStatus } from "./grammar-store";
export {
	downloadGrammar,
	GRAMMAR_DIR,
	grammarCacheSize,
	isGrammarInstalled,
	listGrammarStatus,
	removeGrammar,
} from "./grammar-store";
export { heuristicProvider } from "./heuristic-provider";
export type { Landmark, LandmarkKind } from "./landmarks";
export { countByTag, scanLandmarks } from "./landmarks";
export { parsePosition, parseSymbolSelector } from "./locate";
export { invalidateParser } from "./parser-pool";
export type {
	ElementNode,
	FileStatistics,
	ImportExportInfo,
	ImportedName,
	LocatedNode,
	OutlineNode,
	ProviderSupport,
	ResolvedProvider,
	SearchHit,
	SearchPrecision,
	StructDocument,
	StructKind,
	StructPosition,
	StructSelector,
	StructureProvider,
} from "./provider";
export {
	listStructureProviders,
	registerStructureProvider,
	resolveProvider,
} from "./provider";
export type { RankedEntry } from "./references";
export { partitionByRange, rank, referenceCountFor, referenceLinesFor } from "./references";
export type { StashEntry, StashFailure } from "./stash";
export {
	dropStash,
	formatStashSize,
	listStashes,
	peekStash,
	putStash,
	StashNameError,
	StashTooLargeError,
	stashTtlRemainingMs,
	takeStash,
} from "./stash";
export {
	clearOutlineCache,
	referenceCounts,
	referenceLines,
	treeSitterProvider,
} from "./tree-sitter-provider";
