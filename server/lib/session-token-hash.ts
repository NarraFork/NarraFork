import { createHash, randomBytes } from "node:crypto";
import { SESSION_TOKEN_PREFIX } from "@shared/session-auth";

/**
 * Mint and hash opaque session tokens. Dependency-free so standalone scripts can create a
 * session row without loading settings or the database layer.
 */

/** A fresh session token: the prefix plus 256 random bits. */
export function generateSessionToken(): string {
	return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 of a bearer token. Tokens carry 256 random bits, so no salt or KDF is needed. */
export function hashSessionToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("base64url");
}
