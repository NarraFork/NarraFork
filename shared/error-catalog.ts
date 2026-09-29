/**
 * Single source of truth for localizable application errors.
 *
 * The wire contract for an error response is:
 *
 * ```jsonc
 * {
 *   "error": "Chapter not found: abc123",  // rendered English, always present
 *   "code": "NOT_FOUND",                   // coarse, BEHAVIOUR-bearing code
 *   "messageCode": "RESOURCE_NOT_FOUND",   // fine-grained i18n key (optional)
 *   "messageParams": { "entity": "Chapter", "id": "abc123" }
 * }
 * ```
 *
 * Two codes, not one, because they answer different questions:
 *  - `code` decides BEHAVIOUR. `shared/session-auth.ts` drops the stored session on
 *    `TOKEN_EXPIRED`/`UNAUTHORIZED`/`SESSION_REQUIRED`, the plugin admin UI branches on
 *    `PLUGINS_DISABLED`, and 429 handling reads `retryAfterSeconds`. Splitting it finer to
 *    get better wording would silently rewire authentication.
 *  - `messageCode` decides WORDING only. Adding a message must never be able to change
 *    what the client DOES.
 *
 * The English template lives here rather than at each `throw` site so the prose the server
 * sends and the string the catalog knows can never drift: `renderErrorMessage` produces the
 * `error` field, and the frontend's `errors.json` is keyed by the same `messageCode`. The
 * raw English also stays on the wire permanently — it is the only readable fallback for a
 * `messageCode` the client does not know yet, it is what the "show original" affordance
 * displays, and it is all non-browser consumers (IM gateway, External API v1) can read.
 */

/** Values allowed in `messageParams`. Objects/arrays are refused, see `MAX_PARAM_*`. */
export type ErrorMessageParamValue = string | number;
export type ErrorMessageParams = Record<string, ErrorMessageParamValue>;

export interface ErrorCatalogEntry {
	/** HTTP status this error is served with. */
	readonly status: number;
	/** Coarse behaviour-bearing code placed in the `code` field. */
	readonly code: string;
	/** English template. Placeholders are `{name}` and must match the supplied params. */
	readonly en: string;
}

/**
 * Caps on `messageParams`.
 *
 * Error responses are serialized on the same JS main thread as every other request (see the
 * backend main-thread rules in CLAUDE.md), so an unbounded param — a git diff, a stack trace,
 * a file body — turns a failed request into a latency event for everyone. Truncating is the
 * right trade: a param exists to identify a thing (an id, a path, a limit), and 200 chars
 * identifies it. Anything longer belongs in a log, not in a toast.
 */
export const MAX_PARAM_KEYS = 12;
export const MAX_PARAM_VALUE_CHARS = 200;

/**
 * Localizable errors, keyed by `messageCode`.
 *
 * Adding an entry requires adding the same key to `frontend/locales/en/errors.json` and
 * `frontend/locales/zh-CN/errors.json`; a parity test fails otherwise, so a missing
 * translation is a red test rather than English silently leaking into a localized UI.
 */
export const ERROR_CATALOG = {
	// --- generic ---------------------------------------------------------------
	RESOURCE_NOT_FOUND: {
		status: 404,
		code: "NOT_FOUND",
		en: "{entity} not found: {id}",
	},
	/**
	 * Wraps a validation detail that is itself still English (Zod field errors,
	 * `formatZodError` output). Localizing the frame is worth doing on its own: the user
	 * learns THAT the request was rejected in their language, and the field-level detail
	 * stays verbatim for whoever has to fix the request.
	 */
	VALIDATION_FAILED: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "Request validation failed: {detail}",
	},
	FORBIDDEN_ACTION: {
		status: 403,
		code: "FORBIDDEN",
		en: "You are not allowed to perform this action",
	},
	INTERNAL_ERROR: {
		status: 500,
		code: "INTERNAL_ERROR",
		en: "Internal server error",
	},

	// --- retired features ------------------------------------------------------
	TUTORIAL_REMOVED: {
		status: 410,
		code: "TUTORIAL_REMOVED",
		en: "The interactive tutorial has been removed. Saved conversations and sandbox files are unchanged. Use the learning guide instead.",
	},

	// --- dependencies ----------------------------------------------------------
	GIT_NOT_INSTALLED: {
		status: 503,
		code: "GIT_NOT_INSTALLED",
		en: "Git is not installed. Please install git and retry this Git-dependent action.",
	},
	/**
	 * 503 rather than 500: the instance is not configured yet, which the operator
	 * can fix, and retrying the same request unchanged will keep failing. Carrying
	 * a real code matters because there is deliberately no fallback model — without
	 * it the failure surfaces as a bare "Internal server error" and the actionable
	 * part ("pick a default model") is lost.
	 */
	DEFAULT_MODEL_NOT_CONFIGURED: {
		status: 503,
		code: "DEFAULT_MODEL_NOT_CONFIGURED",
		en: "No default model is configured. Choose one in Settings → Models, then retry.",
	},
	PODMAN_NOT_FOUND: {
		status: 422,
		code: "PODMAN_NOT_FOUND",
		en: "podman is not installed",
	},

	// --- git / merge -----------------------------------------------------------
	GIT_AUTH_REQUIRED: {
		status: 401,
		code: "GIT_AUTH_REQUIRED",
		en: "Git authentication required",
	},
	GIT_TREE_MERGE_FAILED: {
		status: 422,
		code: "GIT_ERROR",
		en: "Git tree merge failed: {detail}",
	},
	GIT_TREE_MERGE_FALLBACK_FAILED: {
		status: 422,
		code: "GIT_ERROR",
		en: "Git {version} does not support {feature}. An automatic compatibility merge in a temporary directory was attempted but failed: {detail}. Check your Git installation and the temporary directory's permissions and available space, or install Git 2.40+ (for example, install it separately and add it to the server's PATH).",
	},
	GIT_TREE_MERGE_CONFLICTS_UNLISTED: {
		status: 422,
		code: "GIT_ERROR",
		en: "Merge conflicts were detected, but their full scope or resolution cannot be verified automatically. Automatic application was refused. Resolve the conflicts manually.",
	},
	MERGE_DIRTY_SOURCE: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The source worktree has uncommitted changes. Commit or discard them before merging.",
	},
	MERGE_DIRTY_TARGET: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The target worktree has uncommitted changes. Commit or discard them before merging.",
	},
	MERGE_DIRTY_TRUNK: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The trunk worktree has uncommitted changes. Commit or discard them before merging.",
	},

	// --- auth / session --------------------------------------------------------
	AUTH_REQUIRED: {
		status: 401,
		code: "UNAUTHORIZED",
		en: "Authentication required",
	},
	TOKEN_EXPIRED: {
		status: 401,
		code: "TOKEN_EXPIRED",
		en: "Token expired",
	},
	SESSION_REVOKED: {
		status: 401,
		code: "TOKEN_EXPIRED",
		en: "Session revoked",
	},
	TOKEN_INVALID: {
		status: 401,
		code: "UNAUTHORIZED",
		en: "Invalid or expired token",
	},
	USER_GONE: {
		status: 401,
		code: "UNAUTHORIZED",
		en: "User no longer exists",
	},
	SESSION_REQUIRED: {
		status: 401,
		code: "SESSION_REQUIRED",
		en: "Session authentication required",
	},
	OAUTH_TOKEN_REQUIRED: {
		status: 401,
		code: "OAUTH_REQUIRED",
		en: "OAuth access token required",
	},
	ADMIN_REQUIRED: {
		status: 403,
		code: "FORBIDDEN",
		en: "Admin access required",
	},
	ADMIN_REQUIRES_SESSION: {
		status: 403,
		code: "FORBIDDEN",
		en: "Admin access requires a session",
	},
	LOGIN_THROTTLED: {
		status: 429,
		code: "LOGIN_THROTTLED",
		en: "Too many attempts. Please try again later.",
	},
} as const satisfies Record<string, ErrorCatalogEntry>;

export type ErrorMessageCode = keyof typeof ERROR_CATALOG;

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

/** Whether a string is a known catalog key. Narrows untrusted input from the wire. */
export function isErrorMessageCode(value: unknown): value is ErrorMessageCode {
	return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

/** Placeholder names a template expects, in first-appearance order, de-duplicated. */
export function templatePlaceholders(template: string): string[] {
	const names: string[] = [];
	for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
		const name = match[1];
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Clamp params to the documented limits.
 *
 * Non-scalar values are dropped rather than stringified: `[object Object]` in a user-facing
 * sentence is worse than a visible unresolved placeholder, which at least points at the bug.
 */
export function sanitizeErrorParams(params: ErrorMessageParams | undefined): ErrorMessageParams {
	if (!params) return {};
	const out: ErrorMessageParams = {};
	let kept = 0;
	for (const [key, value] of Object.entries(params)) {
		if (kept >= MAX_PARAM_KEYS) break;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) continue;
			out[key] = value;
			kept += 1;
			continue;
		}
		if (typeof value !== "string") continue;
		out[key] =
			value.length > MAX_PARAM_VALUE_CHARS ? `${value.slice(0, MAX_PARAM_VALUE_CHARS)}…` : value;
		kept += 1;
	}
	return out;
}

/**
 * Interpolate `{name}` placeholders.
 *
 * A placeholder with no matching param is left verbatim on purpose. Emitting an empty string
 * would produce a confident but incomplete sentence ("Chapter not found: "), whereas a visible
 * `{id}` is unmistakably a defect and gets reported.
 */
export function interpolate(template: string, params: ErrorMessageParams): string {
	return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
		const value = params[name];
		return value === undefined ? whole : String(value);
	});
}

/** Render a catalog entry's English message. This produces the wire `error` field. */
export function renderErrorMessage(
	messageCode: ErrorMessageCode,
	params?: ErrorMessageParams,
): string {
	return interpolate(ERROR_CATALOG[messageCode].en, sanitizeErrorParams(params));
}

/**
 * The localizable part of an error response.
 *
 * `error` is the rendered English and is always present; `messageCode`/`messageParams` are
 * present only for errors that have been migrated to the catalog. A client that sees no
 * `messageCode` shows `error` — which is exactly today's behaviour, so migration is
 * incremental and cannot regress wording.
 */
export interface ErrorResponsePayload {
	error: string;
	code: string;
	messageCode?: ErrorMessageCode;
	messageParams?: ErrorMessageParams;
}

/**
 * Read the localizable fields out of an arbitrary parsed error body.
 *
 * Everything here is untrusted: bodies also come from reverse proxies, non-JSON gateways and
 * older servers. An unknown `messageCode` is discarded so the caller falls back to the raw
 * message instead of rendering a missing-translation key.
 */
export function readErrorPayload(data: Record<string, unknown> | null | undefined): {
	messageCode?: ErrorMessageCode;
	messageParams: ErrorMessageParams;
} {
	const messageCode = data?.messageCode;
	if (!isErrorMessageCode(messageCode)) return { messageParams: {} };
	const rawParams = data?.messageParams;
	const params =
		rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
			? sanitizeErrorParams(rawParams as ErrorMessageParams)
			: {};
	return { messageCode, messageParams: params };
}

/**
 * Preserve catalog metadata in string-only errorMessage storage and events.
 * Plain errors keep their previous text; catalog errors keep readable English
 * alongside the stable key and bounded params, without a schema change.
 */
export function serializeCatalogErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof Error)) return message;
	const metadata = readErrorPayload(error as unknown as Record<string, unknown>);
	if (!metadata.messageCode) return message;
	return JSON.stringify({ type: "catalog_error", error: message, ...metadata });
}
