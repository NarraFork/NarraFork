/**
 * Single source of truth for localizable application errors.
 *
 * The wire contract for an error response is:
 *
 * ```jsonc
 * {
 *   "error": "Project not found: abc123",  // rendered English, always present
 *   "code": "NOT_FOUND",                   // coarse, BEHAVIOUR-bearing code
 *   "messageCode": "RESOURCE_NOT_FOUND",   // fine-grained i18n key (optional)
 *   "messageParams": { "entity": "Project", "id": "abc123" }
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

	// --- outline tasks (outline P2: sessions whose tasks live in the outline) -----------
	/**
	 * A Dynamic Spec task or note (a write, a reset, a plugin's task read) for a session whose tasks
	 * live in the outline: neither the session nor its continuation look there any more.
	 */
	SPEC_IN_OUTLINE_SESSION: {
		status: 409,
		code: "SPEC_OUTLINE_SESSION",
		en: "This session keeps its tasks in the outline, so its Dynamic Spec tasks and notes are not used. Only the behavior fence still applies.",
	},
	/**
	 * A Dynamic Spec write while the session's tasks and notes are being imported into the outline
	 * (outline P2 PR 12b): the import takes a moment, after which the session is an outline session.
	 */
	SPEC_IMPORT_IN_PROGRESS: {
		status: 409,
		code: "SPEC_IMPORT_IN_PROGRESS",
		en: "This session's Dynamic Spec is being imported into the outline. Try again in a moment.",
	},
	/**
	 * A Dynamic Spec write for a session the import moved into the outline (outline P2 PR 12b2):
	 * the same behaviour as {@link SPEC_IN_OUTLINE_SESSION} (its code), worded for the old files.
	 */
	SPEC_MOVED_TO_OUTLINE: {
		status: 409,
		code: "SPEC_OUTLINE_SESSION",
		en: "This session's Dynamic Spec was moved into the outline, so its old files are read-only. Its tasks are on the session's task page in the outline, its notes on outline pages and its behavior boundary on the behavior page.",
	},
	/** An administrator's move back to Dynamic Spec for a session no import moved (12b2). */
	SPEC_IMPORT_NOT_REVERTIBLE: {
		status: 409,
		code: "SPEC_IMPORT_NOT_REVERTIBLE",
		en: "Only a session the import moved into the outline can be moved back to Dynamic Spec, and only once per move.",
	},
	/** The session (or one of its subagents) is running: the move back waits for it (12b2). */
	SPEC_IMPORT_SESSION_BUSY: {
		status: 409,
		code: "SPEC_IMPORT_SESSION_BUSY",
		en: "The session is running. Try again when it is idle.",
	},
	/** An administrator's re-import while imports are switched off (`outline.specImport`). */
	SPEC_IMPORT_OFF: {
		status: 409,
		code: "SPEC_IMPORT_OFF",
		en: "Imports from Dynamic Spec are switched off (outline.specImport is off, or the outline is off).",
	},
	/** A finding of the swallowed-content scan that someone decided already (12c). */
	SPEC_LOSS_DECIDED: {
		status: 409,
		code: "SPEC_LOSS_DECIDED",
		en: "Someone already decided about this possibly lost content. Reload the list.",
	},
	/** Attaching possibly lost content for a session whose tasks are still in Dynamic Spec (12c). */
	SPEC_LOSS_NOT_IMPORTED: {
		status: 409,
		code: "SPEC_LOSS_NOT_IMPORTED",
		en: "This session still keeps Dynamic Spec, so there is no imported page to attach the content to. Import the session first; the content can be read here meanwhile.",
	},
	/** Attaching possibly lost content when the file's imported page is not there (12c). */
	SPEC_LOSS_NO_PAGE: {
		status: 409,
		code: "SPEC_LOSS_NO_PAGE",
		en: "The page this file was imported to is not there (it was deleted, or the file was never imported), so the content cannot be attached. It can still be read and copied here.",
	},
	/** A re-import of a session the import does not move (an outline session, a subagent). */
	SPEC_IMPORT_NOT_IMPORTABLE: {
		status: 409,
		code: "SPEC_IMPORT_NOT_IMPORTABLE",
		en: "This session is not one the import moves: it is not a main session that still keeps its tasks in Dynamic Spec.",
	},
	/**
	 * `/goal` sent to a subagent of such a session: the goal is a task of the session, and an
	 * outline subagent has no tasks of its own (D27c).
	 */
	GOAL_IN_OUTLINE_SESSION: {
		status: 409,
		code: "SPEC_OUTLINE_SESSION",
		en: "/goal adds a task to the session itself. Send it in the main session, not to a subagent.",
	},

	// --- git -------------------------------------------------------------------
	GIT_AUTH_REQUIRED: {
		status: 401,
		code: "GIT_AUTH_REQUIRED",
		en: "Git authentication required",
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

	// --- storage data portability ----------------------------------------------
	EXPORT_PARAMS_INVALID: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The export request is invalid",
	},
	/** 401: the ticket is the credential, and this one can never succeed unchanged. */
	EXPORT_TICKET_INVALID: {
		status: 401,
		code: "EXPORT_TICKET_INVALID",
		en: "This download link has expired. Start the export again",
	},
	IMPORT_FILE_REQUIRED: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "Choose a .zip file exported from NarraFork",
	},
	IMPORT_FILE_TOO_LARGE: {
		status: 413,
		code: "IMPORT_FILE_TOO_LARGE",
		en: "The import file exceeds the {limit} limit",
	},
	IMPORT_ZIP_INVALID: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The uploaded file is not a valid ZIP archive",
	},
	IMPORT_ENTRY_MISSING: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The import archive is missing {name}; it may not be a NarraFork export",
	},
	IMPORT_TABLE_MISSING: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The import archive is missing core table {table}; it may not be a complete NarraFork export",
	},
	IMPORT_VERSION_TOO_NEW: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "Import version {version} is newer than the supported version {supported}",
	},
	IMPORT_PARAMS_INVALID: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The import request is invalid",
	},
	/** 410: the preview snapshot is gone, so the request can never succeed unchanged. */
	IMPORT_PREVIEW_EXPIRED: {
		status: 410,
		code: "IMPORT_PREVIEW_EXPIRED",
		en: "The import preview expired. Choose the file again",
	},
	IMPORT_SNAPSHOT_EXPIRED: {
		status: 410,
		code: "IMPORT_SNAPSHOT_EXPIRED",
		en: "The import snapshot is no longer available. Choose the file again",
	},
	/** The archive carries sealed provider keys and providers were selected. */
	IMPORT_PASSPHRASE_REQUIRED: {
		status: 400,
		code: "IMPORT_PASSPHRASE_REQUIRED",
		en: "Enter the passphrase the provider keys were exported with",
	},
	CLEAR_PARAMS_INVALID: {
		status: 400,
		code: "VALIDATION_ERROR",
		en: "The clear request is invalid",
	},
	CLEAR_USER_UNKNOWN: {
		status: 401,
		code: "UNAUTHORIZED",
		en: "Cannot identify the current user",
	},
	CLEAR_PASSWORD_NOT_SET: {
		status: 400,
		code: "CLEAR_PASSWORD_NOT_SET",
		en: "This account has no password, so data cannot be cleared",
	},
	/** 403 rather than 400: the request is well-formed, the caller is not authorized for it. */
	CLEAR_PASSWORD_INVALID: {
		status: 403,
		code: "CLEAR_PASSWORD_INVALID",
		en: "The password is incorrect. No data was cleared",
	},

	// --- step-up verification (credential export) -------------------------------
	STEP_UP_MFA_REQUIRED: {
		status: 403,
		code: "STEP_UP_MFA_REQUIRED",
		en: "Set up two-factor authentication first",
	},
	STEP_UP_METHOD_UNAVAILABLE: {
		status: 400,
		code: "STEP_UP_METHOD_UNAVAILABLE",
		en: "This verification method is not set up",
	},
	STEP_UP_FAILED: {
		status: 401,
		code: "STEP_UP_FAILED",
		en: "Password or verification code is incorrect",
	},
	STEP_UP_REQUIRED: {
		status: 401,
		code: "STEP_UP_REQUIRED",
		en: "Verify your identity again to continue",
	},

	// --- credential transfer bundles -------------------------------------------
	BUNDLE_INVALID: {
		status: 400,
		code: "BUNDLE_INVALID",
		en: "Not a NarraFork credential bundle",
	},
	BUNDLE_PASSPHRASE: {
		status: 400,
		code: "BUNDLE_PASSPHRASE",
		en: "Wrong passphrase, or the file was altered",
	},
	BUNDLE_TOO_LARGE: {
		status: 400,
		code: "BUNDLE_TOO_LARGE",
		en: "The file is too large to be a credential bundle",
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
 * would produce a confident but incomplete sentence ("Project not found: "), whereas a visible
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
	/**
	 * Machine-readable extras for errors the client must act on, not merely display.
	 * Opaque on the wire: each error documents its own shape and the client narrows it.
	 */
	details?: unknown;
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
