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

function normalizeIdentPart(value: string | null | undefined): string | null {
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
	const name = normalizeIdentPart(identity.name);
	const email = normalizeIdentPart(identity.email);
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
	const [{ eq }, { db }, { narrators, users }] = await Promise.all([
		import("drizzle-orm"),
		import("../db"),
		import("../db/schema"),
	]);
	return { db, eq, narrators, users };
}

let identityQueryDependencies: ReturnType<typeof createIdentityQueryDependencies> | undefined;

function loadIdentityQueryDependencies() {
	identityQueryDependencies ??= createIdentityQueryDependencies();
	return identityQueryDependencies;
}

/**
 * Short-lived memo of userId → identity.
 *
 * The Bash tool resolves an identity on every single call, and this runs on the
 * server's one JS thread. The query itself is a primary-key lookup of two
 * columns — well inside what the main thread should do — but a burst of tool
 * calls turns it into needless repeated reads. A 30 s TTL keeps that flat while
 * staying short enough that a stale entry is never surprising; profile edits
 * evict their own entry immediately (see {@link invalidateGitIdentityCache}).
 *
 * `null` is cached too: "this user has not configured an identity" is the common
 * case and must not re-query on every command.
 */
const IDENTITY_CACHE_TTL_MS = 30_000;
const identityCache = new Map<string, { identity: GitIdentity | null; expiresAt: number }>();

/** Drop a user's cached identity. Called when the profile is updated. */
export function invalidateGitIdentityCache(userId?: string | null): void {
	if (!userId) {
		identityCache.clear();
		return;
	}
	identityCache.delete(userId);
}

/**
 * Read a user's configured git identity, or null when either half is missing.
 *
 * The columns are user-editable free text (`PATCH /api/auth/me`), so the result
 * still goes through {@link buildGitIdentityEnv}'s validation before reaching git.
 */
export async function resolveGitIdentityForUser(
	userId: string | null | undefined,
): Promise<GitIdentity | null> {
	if (!userId) return null;

	const cached = identityCache.get(userId);
	if (cached && cached.expiresAt > Date.now()) return cached.identity;

	let identity: GitIdentity | null = null;
	try {
		const { db, eq, users } = await loadIdentityQueryDependencies();
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { gitUsername: true, gitEmail: true },
		});
		const name = normalizeIdentPart(row?.gitUsername);
		const email = normalizeIdentPart(row?.gitEmail);
		if (name && email) identity = { name, email };
	} catch {
		// A failed lookup must not fail the git operation. Falling back to the host
		// identity is the documented behaviour for "no identity configured", and it
		// is the right outcome here too: the commit still happens.
		return null;
	}

	identityCache.set(userId, { identity, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
	return identity;
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
 * session it is rather than to the host machine.
 */
export async function resolveNarratorGitIdentityEnv(input: {
	turnUserId?: string | null;
	narratorId?: string | null;
}): Promise<GitIdentityEnv | null> {
	if (input.turnUserId) {
		const env = await resolveUserGitIdentityEnv(input.turnUserId);
		// A triggering user who configured no identity does NOT hand authorship to
		// the narrator's owner: the owner did not make this change.
		if (env) return env;
		return null;
	}
	if (!input.narratorId) return null;
	return resolveUserGitIdentityEnv(await resolveNarratorOwnerUserId(input.narratorId));
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
