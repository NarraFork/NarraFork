/**
 * The API errors of comparing and restoring subtrees (pageless outline, H3), and the sealing of
 * the cursors and tokens those calls hand out.
 *
 * A read of history the space cannot answer keeps H2's errors (`subtree-errors.ts`: 409
 * `OUTLINE_HISTORY_NOT_READY` / `OUTLINE_HISTORY_BEFORE_FLOOR`). The ones here are a restore's
 * own: the subtree changed after its preview, its root is not there, a move-back has nowhere to
 * go, a cursor or token is not one this server made.
 *
 * SEALED CURSORS. A cursor of a comparison is the walk's stack, and a restore acts on what its
 * walk finds (a frame that says "this block was added" ends in that block being deleted). So a
 * cursor or token is never taken on trust: each carries an HMAC under the server's secret
 * (`auth.jwtSecret`, with a context of its own) and is refused unless it verifies.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { settings } from "@server/lib/settings";
import {
	OUTLINE_DIFF_LIMITS,
	OUTLINE_RESTORE_ERROR_CODES,
	type OutlineRestoreConflictDetails,
	type OutlineRestoreRootDetails,
} from "@shared/outline-restore-api";

/** Something under the subtree changed after the preview: nothing more is written. */
export class OutlineRestoreConflictError extends AppError {
	declare readonly details: OutlineRestoreConflictDetails;

	constructor(details: OutlineRestoreConflictDetails) {
		super(
			`The subtree changed after this restore was previewed (commit ${details.conflictSeq}); preview it again`,
			409,
			OUTLINE_RESTORE_ERROR_CODES.conflict,
			undefined,
			details,
		);
		this.name = "OutlineRestoreConflictError";
	}
}

/** The root of a comparison or a restore was not in the tree at one of its two seqs. */
export class OutlineRestoreRootError extends AppError {
	declare readonly details: OutlineRestoreRootDetails;

	constructor(details: OutlineRestoreRootDetails) {
		super(
			`The block was not in the outline at commit ${details.seq}`,
			409,
			OUTLINE_RESTORE_ERROR_CODES.root,
			undefined,
			details,
		);
		this.name = "OutlineRestoreRootError";
	}
}

/** A move-back has nowhere to go: the block it was under is deleted. */
export class OutlineRestoreParentGoneError extends AppError {
	constructor(blockId: string, parentId: string) {
		super(
			"The block it was under is deleted now; restore that one first",
			409,
			OUTLINE_RESTORE_ERROR_CODES.parentGone,
			undefined,
			{ blockId, parentId },
		);
		this.name = "OutlineRestoreParentGoneError";
	}
}

/**
 * A cursor or token is malformed, was not made by this server, or belongs to another call; or a
 * token was handed to another person (`reason: "person"`) or has run out (`reason: "expired"`):
 * preview again.
 */
export class OutlineRestoreTokenError extends AppError {
	constructor(what: "cursor" | "token", reason?: "person" | "expired") {
		super(
			reason === "expired"
				? "This restore's preview has expired; preview it again"
				: reason === "person"
					? "This restore was previewed by someone else; preview it yourself"
					: `Invalid ${what}`,
			400,
			OUTLINE_RESTORE_ERROR_CODES.token,
			undefined,
			reason ? { reason } : undefined,
		);
		this.name = "OutlineRestoreTokenError";
	}
}

const SEAL_CONTEXT = "outline-restore:v1";

function mac(kind: string, payload: string): string {
	return createHmac("sha256", settings.auth.jwtSecret)
		.update(`${SEAL_CONTEXT}|${kind}|${payload}`, "utf8")
		.digest("base64url");
}

/** `value` as an opaque string only this server can have made; `kind` separates their uses. */
export function sealOutlineValue(kind: string, value: unknown): string {
	const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${payload}.${mac(kind, payload)}`;
}

/** The value a sealed string holds; throws {@link OutlineRestoreTokenError} unless it verifies. */
export function openOutlineValue(kind: string, sealed: string, what: "cursor" | "token"): unknown {
	const at = sealed.lastIndexOf(".");
	if (at <= 0 || sealed.length > OUTLINE_DIFF_LIMITS.maxCursorChars)
		throw new OutlineRestoreTokenError(what);
	const payload = sealed.slice(0, at);
	const given = Buffer.from(sealed.slice(at + 1), "utf8");
	const expected = Buffer.from(mac(kind, payload), "utf8");
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		throw new OutlineRestoreTokenError(what);
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
	} catch {
		throw new OutlineRestoreTokenError(what);
	}
}
