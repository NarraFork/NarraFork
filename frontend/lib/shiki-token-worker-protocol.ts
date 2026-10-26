/**
 * shiki-token-worker-protocol.ts — Wire format between the token cache and its Worker.
 *
 * Kept dependency-free (type imports only) so the Worker graph never pulls in the
 * main-thread cache, its React bindings or the Worker client that spawns it.
 */

import type { ThemedToken } from "shiki";

/** One Shiki token in DOM form: text plus an optional CSS colour. */
export interface ShikiToken {
	content: string;
	color?: string;
}

export type ShikiTokenWorkerRequest =
	| { type: "boot"; assetBase: string }
	| { type: "tokens"; id: number; code: string; lang: string; theme: string };

export type ShikiTokenWorkerResponse =
	| { type: "tokens"; id: number; tokens: ShikiToken[][] | null }
	| { type: "error"; id: number; error: string };

/** Normalize a Shiki theme colour to a CSS string, dropping anything unusable. */
function normalizeColor(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const trimmed = color.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeThemedTokens(lines: ThemedToken[][]): ShikiToken[][] {
	return lines.map((line) =>
		line.map((token) => {
			const color = normalizeColor(token.color);
			return color === undefined ? { content: token.content } : { content: token.content, color };
		}),
	);
}
