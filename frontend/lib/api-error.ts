/**
 * Turn any thrown value into something the UI can show in the user's language.
 *
 * The server sends a fine-grained `messageCode` plus interpolation params, and the frontend
 * owns the wording (see `shared/error-catalog.ts` for the two-code contract). Translations are
 * NOT on the server: keeping them in each locale's `errors.json` means adding a language is a
 * frontend-only change and the server never has to know who is asking.
 *
 * The raw English is always preserved separately — never merged into the localized sentence —
 * because it is what a user copies into a bug report and what an operator greps for in logs.
 * `ErrorDetail` exposes it behind a disclosure so it is available without being in the way.
 */

import { readErrorPayload } from "@shared/error-catalog";
import { ApiError } from "./api";

export interface DescribedApiError {
	/** Localized, user-facing sentence. Never empty. */
	message: string;
	/** Server-provided English prose, or null when the failure never reached the server. */
	raw: string | null;
	/** Coarse behaviour code, when the response carried one. */
	code: string | null;
	/** Fine-grained wording key, when the response carried a known one. */
	messageCode: string | null;
	/** HTTP status, or null for transport-level failures. */
	status: number | null;
	/** Whether `message` is a real translation rather than the raw fallback. */
	localized: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Sentinel for i18next lookups.
 *
 * `t(key)` returns the key itself when a translation is missing, so a bare call cannot tell
 * "translated" from "absent" — and silently rendering `RESOURCE_NOT_FOUND` in the UI is worse
 * than showing the server's English. An explicit `defaultValue` makes the miss detectable.
 */
const MISSING = "\u0000missing";

function translateOrNull(
	t: Translate,
	key: string,
	params?: Record<string, unknown>,
): string | null {
	// Params go through `replace` rather than being spread into the options object. Spread,
	// they share a namespace with i18next's own options, so a server-side placeholder named
	// `ns`, `lng`, `defaultValue` or `replace` would be consumed as configuration instead of
	// substituted — and the visible result is a missing value or a lookup in the wrong
	// namespace, neither of which points at the cause. `replace` is the explicit
	// interpolation channel and has no reserved names.
	const value = t(key, { replace: params, defaultValue: MISSING, ns: "errors" });
	return value === MISSING ? null : value;
}

/**
 * Localize `NotFoundError`'s entity label.
 *
 * The server sends a plain English noun (`Chapter`, `Knowledge entry`) rather than an enum,
 * because that is what ~319 existing call sites already pass and rewriting them all was not
 * worth the risk. An unlisted noun falls through verbatim, so a new entity reads slightly
 * awkwardly in Chinese instead of producing a broken sentence.
 */
function localizeParams(
	t: Translate,
	params: Record<string, string | number>,
): Record<string, string | number> {
	const entity = params.entity;
	if (typeof entity !== "string") return params;
	const translated = translateOrNull(t, `entity.${entity}`);
	return translated ? { ...params, entity: translated } : params;
}

function rawMessageOf(error: unknown): string | null {
	if (error instanceof ApiError) {
		const fromBody = error.data?.error;
		if (typeof fromBody === "string" && fromBody.trim()) return fromBody;
		return error.message.trim() || null;
	}
	if (error instanceof Error) return error.message.trim() || null;
	if (typeof error === "string" && error.trim()) return error;
	return null;
}

/**
 * Resolve an error to display text.
 *
 * Lookup order — most specific wording first, then the most truthful text available:
 *  1. `errors:<messageCode>` with interpolated params;
 *  2. `errors:<code>` — lets a whole behaviour class (`GIT_NOT_INSTALLED`, `PLUGINS_DISABLED`)
 *     be covered before its individual messages are migrated;
 *  3. the server's English prose — today's behaviour, so an un-migrated error is unchanged;
 *  4. `common:unexpectedError`, for a transport failure with no body at all.
 */
export function describeApiError(
	error: unknown,
	t: Translate,
	fallback?: string,
): DescribedApiError {
	const apiError = error instanceof ApiError ? error : null;
	const data = apiError?.data ?? null;
	const { messageCode, messageParams } = readErrorPayload(data);
	const rawCode = data?.code;
	const code = typeof rawCode === "string" && rawCode.trim() ? rawCode : null;
	const raw = rawMessageOf(error);

	const localized =
		(messageCode ? translateOrNull(t, messageCode, localizeParams(t, messageParams)) : null) ??
		(code ? translateOrNull(t, code) : null);

	return {
		message: localized ?? raw ?? fallback ?? t("unexpectedError", { ns: "common" }),
		raw,
		code,
		messageCode: messageCode ?? null,
		status: apiError?.status ?? null,
		localized: localized !== null,
	};
}

/**
 * Whether the raw message adds anything beyond what is already displayed.
 *
 * Suppresses the "show original" affordance when the localized text IS the raw text (an
 * un-migrated error), where the disclosure would just repeat the sentence.
 */
export function hasDistinctRawMessage(described: DescribedApiError): boolean {
	return described.raw !== null && described.raw !== described.message;
}
