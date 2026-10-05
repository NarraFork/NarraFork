import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { settings } from "@server/lib/settings";
import type { LegacyDirectoryBlacklistEntry } from "./execution-policy/types";

/** Reserved namespace, NOT evidence that an imported/user-authored row is trusted. */
export const REVIEW_BOUNDARY_RULE_PREFIX = "review-boundary:";
const trustedReviewBoundary = Symbol("server-owned-review-boundary");

export function isReviewBoundaryRuleId(id: string | undefined): boolean {
	return typeof id === "string" && id.startsWith(REVIEW_BOUNDARY_RULE_PREFIX);
}

/** Enumerable symbol survives in-process rule copies, but cannot arrive through JSON. */
export function markTrustedReviewBoundary<T extends object>(rule: T): T {
	return Object.assign(rule, { [trustedReviewBoundary]: true });
}

export function isTrustedReviewBoundary(rule: object): boolean {
	return (rule as { [trustedReviewBoundary]?: boolean })[trustedReviewBoundary] === true;
}

function boundaryDigest(narratorId: string, path: string, nonce: string): string {
	// Reuse the existing instance secret with domain separation; no new global token/table.
	return createHmac("sha256", settings.auth.jwtSecret)
		.update(JSON.stringify(["narrafork-review-boundary-v1", narratorId, resolve(path), nonce]))
		.digest("hex");
}

/** Signed persisted identity binds the row to its owner and host path, including across restart. */
export function signReviewBoundaryRuleId(narratorId: string, path: string): string {
	const nonce = randomBytes(12).toString("hex");
	return `${REVIEW_BOUNDARY_RULE_PREFIX}v1:${nonce}:${boundaryDigest(narratorId, path, nonce)}`;
}

export function isSignedReviewBoundaryRow(
	row: LegacyDirectoryBlacklistEntry & { narratorId?: string },
): boolean {
	if (!row.narratorId || row.targetKind !== "host" || row.deviceScope !== "local") return false;
	const match = row.id?.match(/^review-boundary:v1:([a-f0-9]{24}):([a-f0-9]{64})$/);
	if (!match) return false;
	const expected = boundaryDigest(row.narratorId, row.path, match[1]);
	return timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(expected, "hex"));
}

/** External input never gets proof by retaining a namespace, nor loses ordinary deny levels. */
export function sanitizeUntrustedReviewBoundaryIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeUntrustedReviewBoundaryIds);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) =>
			key === "id" && typeof item === "string" && isReviewBoundaryRuleId(item)
				? []
				: [[key, sanitizeUntrustedReviewBoundaryIds(item)]],
		),
	);
}

/** A chapter review protects its host worktree, not every directory or another device's same path. */
export function reviewBoundaryRule(id: string, path: string): LegacyDirectoryBlacklistEntry {
	return {
		id: `${REVIEW_BOUNDARY_RULE_PREFIX}${id}`,
		path,
		denyLevel: "denyWrite",
		enabled: true,
		targetKind: "host",
		targetValue: null,
		deviceScope: "local",
	};
}
