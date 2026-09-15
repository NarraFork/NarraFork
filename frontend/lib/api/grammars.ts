import { request } from "./client";

/**
 * Structural fidelity a grammar can deliver.
 *
 * `verified` has a hand-written declaration table; `generic` falls back to
 * cross-language node-type rules, which find real declarations but miss some forms.
 */
export type GrammarTier = "verified" | "generic";

/** Install state of one tree-sitter grammar. */
export interface GrammarStatus {
	id: string;
	label: string;
	extensions: string[];
	tier: GrammarTier;
	/** Known limitation for this language. */
	note?: string;
	/** Language ABI observed when the grammar was verified. */
	abi: number;
	installed: boolean;
	sizeBytes?: number;
	expectedBytes: number;
	version: string;
	/** Cached file no longer matches the pinned digest — re-download to fix. */
	digestMismatch?: boolean;
}

export interface GrammarListResponse {
	grammars: GrammarStatus[];
	cacheBytes: number;
	/** Languages present upstream but deliberately not offered, with reasons. */
	excluded: Array<{ id: string; reason: string }>;
}

export const grammarsApi = {
	listGrammars: () => request<GrammarListResponse>("/grammars"),
	downloadGrammar: (lang: string) =>
		request<{ ok: boolean; languageId: string; sizeBytes?: number }>(
			`/grammars/${encodeURIComponent(lang)}/download`,
			{ method: "POST" },
		),
	removeGrammar: (lang: string) =>
		request<{ ok: boolean; removed: boolean }>(`/grammars/${encodeURIComponent(lang)}`, {
			method: "DELETE",
		}),
};
