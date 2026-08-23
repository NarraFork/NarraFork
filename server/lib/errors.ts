import {
	ERROR_CATALOG,
	type ErrorMessageCode,
	type ErrorMessageParams,
	renderErrorMessage,
	sanitizeErrorParams,
} from "@shared/error-catalog";

/**
 * Optional localization metadata carried alongside an error.
 *
 * `messageCode` selects the wording; `code` (on `AppError`) still selects behaviour. See
 * `shared/error-catalog.ts` for why those are deliberately two separate axes.
 */
export interface AppErrorLocalization {
	messageCode?: ErrorMessageCode;
	messageParams?: ErrorMessageParams;
}

/**
 * Default throttle prose. Must stay byte-identical to the catalog's `LOGIN_THROTTLED`
 * template — `RateLimitError` compares against it to decide whether the catalog wording
 * applies, and a silent divergence would just stop localizing throttle responses.
 */
const DEFAULT_RATE_LIMIT_MESSAGE = ERROR_CATALOG.LOGIN_THROTTLED.en;

/**
 * Defaults for the two errors whose callers often supply their own, more specific prose.
 *
 * Sourced from the catalog for the same reason as above: these strings are compared
 * against the caller's message to decide whether the catalog's generic wording applies,
 * so a second copy that drifts would silently stop localizing the default case.
 */
const DEFAULT_FORBIDDEN_MESSAGE = ERROR_CATALOG.FORBIDDEN_ACTION.en;
const DEFAULT_GIT_AUTH_MESSAGE = ERROR_CATALOG.GIT_AUTH_REQUIRED.en;

export class AppError extends Error {
	/** Fine-grained i18n key. Absent for errors not yet migrated to the catalog. */
	public readonly messageCode?: ErrorMessageCode;
	/** Interpolation values for `messageCode`, already clamped to the catalog's limits. */
	public readonly messageParams?: ErrorMessageParams;

	constructor(
		message: string,
		public statusCode: number = 500,
		public code: string = "INTERNAL_ERROR",
		localization?: AppErrorLocalization,
	) {
		super(message);
		this.messageCode = localization?.messageCode;
		this.messageParams = localization?.messageCode
			? sanitizeErrorParams(localization.messageParams)
			: undefined;
	}
}

/**
 * Build an `AppError` entirely from the catalog: status, behaviour code and English prose all
 * come from one entry, so the sentence the server sends and the key the frontend translates
 * cannot disagree.
 */
export function catalogError(messageCode: ErrorMessageCode, params?: ErrorMessageParams): AppError {
	const entry = ERROR_CATALOG[messageCode];
	return new AppError(renderErrorMessage(messageCode, params), entry.status, entry.code, {
		messageCode,
		messageParams: params,
	});
}

export class RateLimitError extends AppError {
	public readonly retryAfterSeconds: number;

	/**
	 * `localization` defaults to `LOGIN_THROTTLED` whenever the DEFAULT message is used.
	 *
	 * The catalog's `LOGIN_THROTTLED` template is that sentence verbatim, so attaching it
	 * here localizes every throttle response — login, MFA, SSO, the generic busy path —
	 * without touching their call sites, and the English on the wire is unchanged. A
	 * caller that passes its own prose gets no messageCode, because the catalog has no
	 * wording for a sentence it has never seen.
	 *
	 * `code` deliberately stays whatever the caller chose (`LOGIN_THROTTLED`,
	 * `MFA_THROTTLED`, `AUTH_BUSY`, …). Behaviour and wording are separate axes: the login
	 * form branches on the code to decide which field to lock, and collapsing them would
	 * rewire that.
	 */
	constructor(
		code: string,
		retryAfterMs: number,
		message: string = DEFAULT_RATE_LIMIT_MESSAGE,
		localization?: AppErrorLocalization,
	) {
		super(
			message,
			429,
			code,
			localization ??
				(message === DEFAULT_RATE_LIMIT_MESSAGE ? { messageCode: "LOGIN_THROTTLED" } : undefined),
		);
		this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
	}
}

/**
 * The signature is unchanged on purpose: attaching the catalog entry here localizes all ~319
 * call sites at once, without editing any of them. `entity` stays a plain English label
 * (`Chapter`, `Narrator`, `Knowledge entry`) — the frontend looks it up under
 * `errors:entity.<Entity>` and falls back to showing it verbatim, so an unlisted entity
 * degrades to today's wording instead of breaking the sentence.
 */
export class NotFoundError extends AppError {
	constructor(entity: string, id: string) {
		super(`${entity} not found: ${id}`, 404, "NOT_FOUND", {
			messageCode: "RESOURCE_NOT_FOUND",
			messageParams: { entity, id },
		});
	}
}

export class ValidationError extends AppError {
	/**
	 * `code` may be narrowed past the generic `VALIDATION_ERROR` when a client has
	 * to REACT differently to one rejection than to the rest. Without a distinct
	 * code the only discriminator is the prose message, which is neither stable
	 * nor localizable.
	 *
	 * `localization` is optional so the ~1000 existing call sites keep compiling and can be
	 * migrated in batches: an un-migrated one behaves exactly as before (English prose, no
	 * `messageCode`), which is why this rollout cannot regress any existing wording.
	 */
	constructor(
		message: string,
		code: string = "VALIDATION_ERROR",
		localization?: AppErrorLocalization,
	) {
		super(message, 400, code, localization);
	}
}

/**
 * The caller is authenticated and the target exists, but this action is not
 * theirs to take. Distinct from `ValidationError` (400, "your input is wrong")
 * and `NotFoundError` (404, "pretend it isn't there"): a client can only offer
 * a sensible retry — or hide the affordance — if it can tell the three apart.
 */
export class ForbiddenError extends AppError {
	/**
	 * The catalog entry is attached ONLY for the default message, the same rule
	 * {@link RateLimitError} follows.
	 *
	 * `FORBIDDEN_ACTION`'s wording is the generic "you are not allowed to do this", and the
	 * client prefers `messageCode` over the prose on the wire. Attaching it unconditionally
	 * therefore replaced every specific reason with the generic one — "You can only delete
	 * your own messages" became "You are not allowed to perform this action", which is the
	 * one sentence in that pair that tells the user nothing. Callers that pass their own
	 * prose keep it, un-localized, exactly as before this catalog existed.
	 */
	constructor(message: string = DEFAULT_FORBIDDEN_MESSAGE) {
		super(
			message,
			403,
			"FORBIDDEN",
			message === DEFAULT_FORBIDDEN_MESSAGE ? { messageCode: "FORBIDDEN_ACTION" } : undefined,
		);
	}
}

export class PodmanNotFoundError extends AppError {
	constructor() {
		super("podman is not installed", 422, "PODMAN_NOT_FOUND", {
			messageCode: "PODMAN_NOT_FOUND",
		});
	}
}

export class ContainerError extends AppError {
	constructor(message: string) {
		super(message, 502, "CONTAINER_ERROR");
	}
}

export class GitError extends AppError {
	constructor(message: string) {
		super(message, 422, "GIT_ERROR");
	}
}

export class GitAuthError extends AppError {
	/**
	 * Same rule as {@link ForbiddenError}: the catalog entry is attached only for the
	 * default message.
	 *
	 * Here the specific prose is git's own `fatal:` line, which names the remote and the
	 * reason it refused. Localizing the frame at the cost of that line is a bad trade — the
	 * generic sentence tells a user their push failed, the git line tells them why.
	 */
	constructor(message: string = DEFAULT_GIT_AUTH_MESSAGE) {
		super(
			message,
			401,
			"GIT_AUTH_REQUIRED",
			message === DEFAULT_GIT_AUTH_MESSAGE ? { messageCode: "GIT_AUTH_REQUIRED" } : undefined,
		);
	}
}

/** Convert a Zod error into a human-readable single-line message. */
export function formatZodError(error: {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
	return error.issues
		.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
		.join("; ");
}

/**
 * Reject a request that failed schema validation, with a localizable frame.
 *
 * The FRAME is localized ("Request validation failed: …"); the detail stays as Zod
 * wrote it. That split is the whole point of `VALIDATION_FAILED`: a user learns in
 * their own language that the request was rejected, while the field-level detail
 * remains verbatim for whoever has to fix the caller. Translating field errors would
 * mean translating Zod, and would strip the field paths a developer needs.
 *
 * Preferred over `new ValidationError(formatZodError(...))`, which produces the same
 * sentence but carries no `messageCode`, so the frontend can only show the English.
 */
export function zodValidationError(error: {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}): ValidationError {
	const detail = formatZodError(error);
	return new ValidationError(
		renderErrorMessage("VALIDATION_FAILED", { detail }),
		"VALIDATION_ERROR",
		{
			messageCode: "VALIDATION_FAILED",
			messageParams: { detail },
		},
	);
}
