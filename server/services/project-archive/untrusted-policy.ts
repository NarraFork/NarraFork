import { sanitizeUntrustedReviewBoundaryIds } from "../narrator-review-boundary";
import type { ArchiveValue } from "./main-store";

/** Keep every policy/deny level; external IDs must not carry server boundary provenance. */
export function sanitizeLegacyPolicyRow(row: Record<string, ArchiveValue>): void {
	for (const field of ["chapter_settings", "oauth_policy_snapshot_json"]) {
		const raw = row[field];
		if (raw == null) continue;
		if (typeof raw !== "string") throw new Error("Invalid legacy policy JSON");
		row[field] = JSON.stringify(sanitizeUntrustedReviewBoundaryIds(JSON.parse(raw)));
	}
}
