/**
 * Per-user git commit identity.
 *
 * NarraFork is a multi-user deployment where every commit — whether the model
 * runs `git commit` through the Bash tool, or a merge/dormant auto-save goes
 * through `gitService` — used to land under the HOST machine's global
 * `user.name`/`user.email`. With several people driving the same server that
 * makes the whole history look like one author's work.
 *
 * The fix is to pass the acting person's identity through the environment
 * (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`), which git honours above any config file.
 *
 * Authority is per-TURN, not per-narrator: a narrator has no fixed owner, and
 * whoever sent the message that made the agent work is the person who authored
 * the resulting commits. `narrators.ownerUserId` is only a fallback for turns
 * with no triggering user (background continuations, scheduled tasks).
 *
 * A user keeps several identities (`user_git_identities`) and may pick, per
 * narrator, which one their own turns commit under
 * (`narrator_git_identity_bindings`). Resolution is: the acting user's pick for
 * that narrator → that user's default identity → nothing, which inherits the
 * host config. The pick is keyed by (user × narrator) on purpose: two people
 * driving the same narrator each keep their own pick, and neither can see or
 * overwrite the other's.
 *
 * Deliberately NOT used by `worktree-tree-snapshot.ts`: those commits are
 * NarraFork's own bookkeeping and must stay a pure function of their content,
 * so they keep a fixed synthetic identity.
 */

/** A usable git identity. Both halves are required — see {@link buildGitIdentityEnv}. */
export interface GitIdentity {
	name: string;
	email: string;
}

/** The four `GIT_*` variables that pin both author and committer. */
export type GitIdentityEnv = Record<string, string>;

/**
 * Characters that cannot appear in a git ident.
 *
 * `<`/`>` delimit the email in the ident line and a newline ends the line
 * outright, so either one produces a syntactically corrupt commit object rather
 * than a mis-attributed one. Rejecting the identity (and thereby falling back to
 * the host config) is strictly better than writing a broken commit.
 */
const INVALID_IDENT_CHARS = /[<>\n\r]/;

/**
 * Trim and validate one half of an identity, or null when it cannot be used.
 *
 * Shared by the read path here and by the write path
 * (`services/git-identities.ts`), so "what counts as a usable half" has exactly
 * one definition: everything that reaches git has already been through this.
 */
export function normalizeGitIdentPart(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (INVALID_IDENT_CHARS.test(trimmed)) return null;
	return trimmed;
}

/**
 * Build the environment overrides for an identity, or null when it cannot be used.
 *
 * Two properties this function exists to guarantee:
 *
 * 1. **Atomic.** A half-filled identity yields null, never a partial env. Git
 *    treats `GIT_AUTHOR_NAME=""` as a hard error (`fatal: empty ident name not
 *    allowed`), so injecting an empty string does not degrade to the host
 *    identity — it makes every commit fail outright.
 * 2. **Author and committer together.** Setting only `GIT_AUTHOR_*` leaves the
 *    committer resolving from the host config, which is exactly the shared
 *    identity this module exists to stop appearing in history.
 *
 * No `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`: a commit's time should be the real
 * time it was made.
 */
export function buildGitIdentityEnv(
	identity: Partial<GitIdentity> | null | undefined,
): GitIdentityEnv | null {
	if (!identity) return null;
	const name = normalizeGitIdentPart(identity.name);
	const email = normalizeGitIdentPart(identity.email);
	if (!name || !email) return null;
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
}

/**
 * The acting user for a turn: whoever triggered it, else the narrator's owner.
 *
 * Same shape and reasoning as `resolveSubagentActingUserId` in `fast-mode.ts` —
 * several paths start a turn without a triggering user, and falling back to a
 * real person beats degrading to "no identity at all".
 */
export function resolveActingGitUserId(
	turnUserId: string | null | undefined,
	ownerUserId: string | null | undefined,
): string | null {
	return turnUserId ?? ownerUserId ?? null;
}

/**
 * Load database dependencies only when an identity is actually queried, so
 * importing this module (e.g. from a unit test of the pure builders above)
 * never opens a database connection. Mirrors `lib/fast-mode.ts`.
 */
async function createIdentityQueryDependencies() {
	const [
		{ and, asc, desc, eq },
		{ db },
		{ narratorGitIdentityBindings, narrators, userGitIdentities },
	] = await Promise.all([import("drizzle-orm"), import("../db"), import("../db/schema")]);
	return { db, eq, and, asc, desc, narrators, narratorGitIdentityBindings, userGitIdentities };
}

let identityQueryDependencies: ReturnType<typeof createIdentityQueryDependencies> | undefined;

function loadIdentityQueryDependencies() {
	identityQueryDependencies ??= createIdentityQueryDependencies();
	return identityQueryDependencies;
}

/**
 * Short-lived memo of resolved identities.
 *
 * The Bash tool resolves an identity on every single call, and this runs on the
 * server's one JS thread. Each entry is a primary-key-shaped lookup — well
 * inside what the main thread should do — but a burst of tool calls turns it
 * into needless repeated reads. A 30 s TTL keeps that flat while staying short
 * enough that a stale entry is never surprising; edits evict their own entries
 * immediately (see {@link invalidateGitIdentityCache}).
 *
 * Two kinds of entries share the map: `user:<id>` for the user's default
 * identity and `pick:<narratorId>:<userId>` for one user's choice of identity
 * for one narrator. `null` is cached in both: "nothing configured" and "no
 * pick" are common cases and must not re-query on every command.
 */
const IDENTITY_CACHE_TTL_MS = 30_000;
const identityCache = new Map<string, { identity: GitIdentity | null; expiresAt: number }>();

const userCacheKey = (userId: string) => `user:${userId}`;
// Narrator ids are nanoid-derived and never contain the separator.
const pickCacheKey = (narratorId: string, userId: string) => `pick:${narratorId}:${userId}`;

/**
 * Drop one user's cached default identity and every pick they made, or the whole
 * cache when no user is named. Called whenever their identities or picks change:
 * a user who just fixed their name must not keep committing under the old one.
 */
export function invalidateGitIdentityCache(userId?: string | null): void {
	if (!userId) {
		identityCache.clear();
		return;
	}
	identityCache.delete(userCacheKey(userId));
	const suffix = `:${userId}`;
	for (const key of identityCache.keys()) {
		if (key.startsWith("pick:") && key.endsWith(suffix)) identityCache.delete(key);
	}
}

/** Drop one user's narrated pick. Called when that pick (not their identities) changes. */
export function invalidateNarratorGitIdentityPickCache(narratorId: string, userId: string): void {
	identityCache.delete(pickCacheKey(narratorId, userId));
}

/**
 * Read a user's default git identity, or null when they have none.
 *
 * The default row is the `is_default` flag the service layer maintains, with
 * "oldest first" as the tie-break so a user whose flag was never set (restored
 * or seeded database) still resolves to something stable — and a user with a
 * single identity is their own default by construction.
 *
 * Rows are user-editable free text, so the result still goes through
 * {@link buildGitIdentityEnv}'s validation before reaching git.
 */
export async function resolveGitIdentityForUser(
	userId: string | null | undefined,
): Promise<GitIdentity | null> {
	if (!userId) return null;

	const key = userCacheKey(userId);
	const cached = identityCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.identity;

	let identity: GitIdentity | null = null;
	try {
		identity = await fetchDefaultIdentity(userId);
	} catch {
		// A failed lookup must not fail the git operation. Falling back to the host
		// identity is the documented behaviour for "no identity configured", and it
		// is the right outcome here too: the commit still happens.
		return null;
	}

	identityCache.set(key, { identity, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
	return identity;
}

/**
 * The identity a user commits under for a given narrator.
 *
 * The pick is the more specific choice, so it wins over the default; a missing
 * pick — or no narrator at all, which is how the user-scoped call sites resolve
 * (manual commits, project init, chapter merge/cleanup) — falls back to the
 * default. `null` means "this user configured nothing", which the callers turn
 * into "inherit the host config".
 */
export async function resolveGitIdentityForTurn(
	narratorId: string | null | undefined,
	userId: string,
): Promise<GitIdentity | null> {
	if (narratorId) {
		const key = pickCacheKey(narratorId, userId);
		const cached = identityCache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.identity ?? resolveGitIdentityForUser(userId);
		}
		const picked = await fetchPickedIdentity(narratorId, userId).catch(() => null);
		identityCache.set(key, { identity: picked, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
		if (picked) return picked;
	}
	return resolveGitIdentityForUser(userId);
}

/** The default row (see {@link resolveGitIdentityForUser} for what "default" means). */
async function fetchDefaultIdentity(userId: string): Promise<GitIdentity | null> {
	const { asc, db, desc, eq, userGitIdentities } = await loadIdentityQueryDependencies();
	const rows = await db
		.select({ name: userGitIdentities.name, email: userGitIdentities.email })
		.from(userGitIdentities)
		.where(eq(userGitIdentities.userId, userId))
		.orderBy(
			desc(userGitIdentities.isDefault),
			asc(userGitIdentities.createdAt),
			asc(userGitIdentities.id),
		)
		.limit(1);
	return toIdentity(rows[0]);
}

/** The identity one user picked for one narrator, or null when they made no pick. */
async function fetchPickedIdentity(
	narratorId: string,
	userId: string,
): Promise<GitIdentity | null> {
	const { and, db, eq, narratorGitIdentityBindings, userGitIdentities } =
		await loadIdentityQueryDependencies();
	const rows = await db
		.select({ name: userGitIdentities.name, email: userGitIdentities.email })
		.from(narratorGitIdentityBindings)
		.innerJoin(userGitIdentities, eq(userGitIdentities.id, narratorGitIdentityBindings.identityId))
		.where(
			and(
				eq(narratorGitIdentityBindings.narratorId, narratorId),
				eq(narratorGitIdentityBindings.userId, userId),
			),
		)
		.limit(1);
	return toIdentity(rows[0]);
}

/** Re-validate a stored row through the shared identifier rules. */
function toIdentity(row: { name: string; email: string } | undefined): GitIdentity | null {
	const name = normalizeGitIdentPart(row?.name);
	const email = normalizeGitIdentPart(row?.email);
	return name && email ? { name, email } : null;
}

/** The env overrides for a single user, or null to inherit the host identity. */
export async function resolveUserGitIdentityEnv(
	userId: string | null | undefined,
): Promise<GitIdentityEnv | null> {
	return buildGitIdentityEnv(await resolveGitIdentityForUser(userId));
}

/**
 * The env overrides for an agent turn.
 *
 * Prefers the triggering user and falls back to the narrator's owner, so a
 * background continuation still attributes its commits to the person whose
 * session it is rather than to the host machine. Whichever of the two applies,
 * their pick for this narrator beats their default identity
 * ({@link resolveGitIdentityForTurn}).
 */
export async function resolveNarratorGitIdentityEnv(input: {
	turnUserId?: string | null;
	narratorId?: string | null;
}): Promise<GitIdentityEnv | null> {
	if (input.turnUserId) {
		const identity = await resolveGitIdentityForTurn(input.narratorId, input.turnUserId);
		// A triggering user who configured no identity does NOT hand authorship to
		// the narrator's owner: the owner did not make this change.
		return buildGitIdentityEnv(identity);
	}
	if (!input.narratorId) return null;
	const ownerUserId = await resolveNarratorOwnerUserId(input.narratorId);
	if (!ownerUserId) return null;
	return buildGitIdentityEnv(await resolveGitIdentityForTurn(input.narratorId, ownerUserId));
}

/** The owner of a narrator, used only as the no-triggering-user fallback. */
async function resolveNarratorOwnerUserId(narratorId: string): Promise<string | null> {
	try {
		const { db, eq, narrators } = await loadIdentityQueryDependencies();
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { ownerUserId: true },
		});
		return row?.ownerUserId ?? null;
	} catch {
		return null;
	}
}
