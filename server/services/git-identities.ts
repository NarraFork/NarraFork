/**
 * User-managed git commit identities, plus the per-(user × narrator) pick.
 *
 * This is the WRITE path: validation, the "exactly one default" invariant and
 * cache eviction. Reading (resolving which identity a commit should use) lives in
 * `lib/git-identity.ts`, which owns the cache this module invalidates.
 *
 * Why two tables rather than columns on `users`/`narrators`:
 *   - a user keeps several identities and can edit or drop them independently,
 *     which a single `git_username`/`git_email` pair cannot express;
 *   - the choice of which identity applies is PERSONAL and PER NARRATOR. Storing
 *     it on the narrator would let two people driving the same session overwrite
 *     each other's pick, and would make one user's choice visible to the other.
 */

import { db } from "@server/db";
import { narratorGitIdentityBindings, userGitIdentities, users } from "@server/db/schema";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import {
	invalidateGitIdentityCache,
	invalidateNarratorGitIdentityPickCache,
	normalizeGitIdentPart,
} from "@server/lib/git-identity";
import { generateId } from "@server/lib/id";
import { and, asc, desc, eq } from "drizzle-orm";

/** Mirrors the Zod limits in `lib/validators/auth.ts` — this module is the last gate before git. */
const MAX_NAME_CHARS = 100;
const MAX_EMAIL_CHARS = 254;

export interface GitIdentityInput {
	name: string;
	email: string;
}

export interface GitIdentityRecord {
	id: string;
	name: string;
	email: string;
	isDefault: boolean;
	createdAt: string;
}

const nowIso = () => new Date().toISOString();

/**
 * Reject an unusable half before it is stored.
 *
 * `normalizeGitIdentPart` is the same rule the read path applies, so an identity
 * that survives here cannot later be dropped by it (which would look like
 * "configuration did nothing").
 */
function validatePart(value: string, label: string, maxChars: number): string {
	const normalized = normalizeGitIdentPart(value);
	if (!normalized) {
		throw new ValidationError(`Git ${label} is empty or contains an unusable character`);
	}
	if (normalized.length > maxChars) {
		throw new ValidationError(`Git ${label} must be at most ${maxChars} characters`);
	}
	return normalized;
}

const validateName = (value: string) => validatePart(value, "username", MAX_NAME_CHARS);
const validateEmail = (value: string) => validatePart(value, "email", MAX_EMAIL_CHARS);

/**
 * Compatibility for PATCH /auth/me's original single-identity fields.
 * Keep the old columns and the effective default in one synchronous transaction.
 * An omitted half comes from the current default, not a stale legacy column.
 * Clearing with multiple identities is ambiguous: deleting/promoting would silently
 * select a different author, so require the explicit identity API in that case.
 */
export async function updateLegacyGitIdentityProfile(
	userId: string,
	input: { gitUsername?: string | null; gitEmail?: string | null },
): Promise<void> {
	if (input.gitUsername === undefined && input.gitEmail === undefined) return;
	const normalize = (value: string | null, validate: (part: string) => string) =>
		value === null || !value.trim() ? null : validate(value);
	const suppliedName =
		input.gitUsername === undefined ? undefined : normalize(input.gitUsername, validateName);
	const suppliedEmail =
		input.gitEmail === undefined ? undefined : normalize(input.gitEmail, validateEmail);
	db.transaction((tx) => {
		const profile = tx
			.select({ name: users.gitUsername, email: users.gitEmail })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		if (!profile) throw new NotFoundError("User", userId);
		// Two rows suffice to detect ambiguous clears; never load an unbounded list.
		const identities = tx
			.select()
			.from(userGitIdentities)
			.where(eq(userGitIdentities.userId, userId))
			.orderBy(
				desc(userGitIdentities.isDefault),
				asc(userGitIdentities.createdAt),
				asc(userGitIdentities.id),
			)
			.limit(2)
			.all();
		const current = identities[0];
		const name = suppliedName === undefined ? (current?.name ?? profile.name) : suppliedName;
		const email = suppliedEmail === undefined ? (current?.email ?? profile.email) : suppliedEmail;
		if (!name || !email) {
			if (identities.length > 1) {
				throw new ValidationError(
					"Cannot clear the legacy Git profile with multiple identities; manage /auth/git-identities explicitly",
				);
			}
			if (current) {
				tx.delete(userGitIdentities)
					.where(and(eq(userGitIdentities.id, current.id), eq(userGitIdentities.userId, userId)))
					.run();
			}
		} else {
			const identity = { name: validateName(name), email: validateEmail(email) };
			if (current) {
				tx.update(userGitIdentities)
					.set(identity)
					.where(and(eq(userGitIdentities.id, current.id), eq(userGitIdentities.userId, userId)))
					.run();
			} else {
				tx.insert(userGitIdentities)
					.values({ id: generateId(), userId, ...identity, isDefault: true, createdAt: nowIso() })
					.run();
			}
		}
		tx.update(users).set({ gitUsername: name, gitEmail: email }).where(eq(users.id, userId)).run();
	});
	invalidateGitIdentityCache(userId);
}

/** A user's identities, default first and then oldest first. */
export async function listUserGitIdentities(userId: string): Promise<GitIdentityRecord[]> {
	const rows = await db
		.select({
			id: userGitIdentities.id,
			name: userGitIdentities.name,
			email: userGitIdentities.email,
			isDefault: userGitIdentities.isDefault,
			createdAt: userGitIdentities.createdAt,
		})
		.from(userGitIdentities)
		.where(eq(userGitIdentities.userId, userId))
		.orderBy(
			desc(userGitIdentities.isDefault),
			asc(userGitIdentities.createdAt),
			asc(userGitIdentities.id),
		);
	return rows;
}

/** Create one identity. The user's first identity is their default. */
export async function createUserGitIdentity(
	userId: string,
	input: GitIdentityInput,
): Promise<GitIdentityRecord> {
	const name = validateName(input.name);
	const email = validateEmail(input.email);
	const record = db.transaction((tx) => {
		const existing = tx
			.select({ id: userGitIdentities.id })
			.from(userGitIdentities)
			.where(eq(userGitIdentities.userId, userId))
			.limit(1)
			.get();
		const created: GitIdentityRecord = {
			id: generateId(),
			name,
			email,
			isDefault: !existing,
			createdAt: nowIso(),
		};
		tx.insert(userGitIdentities)
			.values({
				id: created.id,
				userId,
				name: created.name,
				email: created.email,
				isDefault: created.isDefault,
				createdAt: created.createdAt,
			})
			.run();
		return created;
	});
	invalidateGitIdentityCache(userId);
	return record;
}

/**
 * Edit one identity, or promote it to default.
 *
 * Demotion is deliberately not offered: a user always has a default while they
 * have any identity ("only one identity" therefore implies "it is the default"),
 * and "no default" would silently mean "inherit the host identity" — a state the
 * user never asked for and cannot see.
 */
export async function updateUserGitIdentity(
	userId: string,
	id: string,
	input: Partial<GitIdentityInput> & { isDefault?: boolean },
): Promise<GitIdentityRecord> {
	const patch: Partial<GitIdentityInput> = {};
	if (input.name !== undefined) patch.name = validateName(input.name);
	if (input.email !== undefined) patch.email = validateEmail(input.email);
	const record = db.transaction((tx) => {
		const before = tx
			.select()
			.from(userGitIdentities)
			.where(and(eq(userGitIdentities.id, id), eq(userGitIdentities.userId, userId)))
			.get();
		if (!before) throw new NotFoundError("Git identity", id);
		if (input.isDefault === false) {
			throw new ValidationError(
				"A default identity is required; promote another identity instead of clearing this one",
			);
		}
		if (input.isDefault === true) {
			tx.update(userGitIdentities)
				.set({ isDefault: false })
				.where(eq(userGitIdentities.userId, userId))
				.run();
		}
		const after = {
			id: before.id,
			name: patch.name ?? before.name,
			email: patch.email ?? before.email,
			isDefault: input.isDefault === true ? true : before.isDefault,
			createdAt: before.createdAt,
		};
		tx.update(userGitIdentities)
			.set({ name: after.name, email: after.email, isDefault: after.isDefault })
			.where(eq(userGitIdentities.id, id))
			.run();
		return after;
	});
	invalidateGitIdentityCache(userId);
	return record;
}

/**
 * Delete one identity.
 *
 * When the default is deleted the oldest remaining identity inherits the flag, so
 * the user is never left without one while they still have identities. Deleting
 * the last identity is allowed: it is exactly the "no identity configured" state
 * that falls back to the host git config.
 */
export async function deleteUserGitIdentity(userId: string, id: string): Promise<void> {
	db.transaction((tx) => {
		const before = tx
			.select()
			.from(userGitIdentities)
			.where(and(eq(userGitIdentities.id, id), eq(userGitIdentities.userId, userId)))
			.get();
		if (!before) throw new NotFoundError("Git identity", id);
		tx.delete(userGitIdentities).where(eq(userGitIdentities.id, id)).run();
		if (!before.isDefault) return;
		const successor = tx
			.select({ id: userGitIdentities.id })
			.from(userGitIdentities)
			.where(eq(userGitIdentities.userId, userId))
			.orderBy(asc(userGitIdentities.createdAt), asc(userGitIdentities.id))
			.limit(1)
			.get();
		if (!successor) return;
		tx.update(userGitIdentities)
			.set({ isDefault: true })
			.where(eq(userGitIdentities.id, successor.id))
			.run();
	});
	invalidateGitIdentityCache(userId);
}

/** The identity this user picked for this narrator, or null when they made no pick. */
export async function getNarratorGitIdentityPick(
	userId: string,
	narratorId: string,
): Promise<string | null> {
	const row = await db
		.select({ identityId: narratorGitIdentityBindings.identityId })
		.from(narratorGitIdentityBindings)
		.where(
			and(
				eq(narratorGitIdentityBindings.narratorId, narratorId),
				eq(narratorGitIdentityBindings.userId, userId),
			),
		)
		.limit(1);
	return row[0]?.identityId ?? null;
}

/**
 * Set (or clear, with null) this user's pick for this narrator.
 *
 * Only the caller's own identities are ever visible or selectable here, which is
 * what keeps two people's picks independent.
 */
export async function setNarratorGitIdentityPick(
	userId: string,
	narratorId: string,
	identityId: string | null,
): Promise<void> {
	if (identityId === null) {
		await db
			.delete(narratorGitIdentityBindings)
			.where(
				and(
					eq(narratorGitIdentityBindings.narratorId, narratorId),
					eq(narratorGitIdentityBindings.userId, userId),
				),
			);
		invalidateNarratorGitIdentityPickCache(narratorId, userId);
		return;
	}
	const owned = await db
		.select({ id: userGitIdentities.id })
		.from(userGitIdentities)
		.where(and(eq(userGitIdentities.id, identityId), eq(userGitIdentities.userId, userId)))
		.limit(1);
	if (owned.length === 0) throw new NotFoundError("Git identity", identityId);
	const updatedAt = nowIso();
	await db
		.insert(narratorGitIdentityBindings)
		.values({ id: generateId(), narratorId, userId, identityId, updatedAt })
		.onConflictDoUpdate({
			target: [narratorGitIdentityBindings.narratorId, narratorGitIdentityBindings.userId],
			set: { identityId, updatedAt },
		});
	invalidateNarratorGitIdentityPickCache(narratorId, userId);
}
