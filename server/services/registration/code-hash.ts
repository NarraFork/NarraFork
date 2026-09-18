/**
 * Hash an invitation code for storage/lookup — as a pure function over plain data.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * The same algorithm already exists as `hashRegistrationCode` in
 * `server/services/registration-code-service.ts`, but that module imports the SQLite
 * handle (`@server/db`) at its top level, so the PostgreSQL account store cannot import
 * from it without inheriting the very dependency it exists to avoid. The hashing rule,
 * however, is not SQLite's: a deployment that migrates invitation rows between backends
 * must find the same hash for the same code on both sides, which makes the algorithm
 * part of the feature's contract rather than of either store.
 *
 * A plain SHA-256 (no salt, no KDF) is deliberate: the code is a 143-bit random value,
 * not a human-chosen password, so there is nothing to brute-force and the hash must stay
 * deterministic to serve as a unique index for lookup.
 *
 * The equivalence with the SQLite-side copy is pinned by a test in
 * `__tests__/account-store-contract.test.ts`; the two MUST NOT drift. (The cleanup that
 * makes the SQLite service re-export from here is deliberately not part of this change,
 * which keeps the existing registration write path untouched.)
 *
 * This module must stay free of any storage import — it takes a string and returns one.
 */
import { createHash } from "node:crypto";

/** Hash a code for storage/lookup. Input is trimmed first, matching the SQLite side. */
export function hashInvitationCode(code: string): string {
	return createHash("sha256").update(code.trim()).digest("hex");
}
