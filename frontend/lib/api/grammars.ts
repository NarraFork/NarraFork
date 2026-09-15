import { request } from "./client";

/** Install state of one tree-sitter grammar. */
export interface GrammarStatus {
	id: string;
	label: string;
	extensions: string[];
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
