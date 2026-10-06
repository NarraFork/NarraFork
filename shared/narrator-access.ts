/**
 * Narrator access audiences, and the rule that relates them.
 *
 * A narrator carries two audience columns, and they are NOT independent — the write
 * audience is nested inside the read audience, because being able to drive a session
 * presupposes being able to see it. Writing without reading is not a state anyone can
 * usefully be in, and allowing the pair to disagree made `visibility` lie: a session
 * marked `private` while its write audience was `project` was in fact readable by the
 * whole project, and the UI said otherwise.
 *
 * The nesting is expressed once, here, as {@link WRITE_AUDIENCE_BY_VISIBILITY}. Server
 * validation, the creation defaults and the frontend's option list all derive from it.
 * Written as data rather than as conditionals in three places because three copies
 * drift, and the direction they drift in is back towards `visibility` lying.
 *
 * Shared rather than server-only so the panel can grey out the options a given read
 * audience forbids instead of letting the user pick one and get a 400.
 */

/**
 * Who may READ a narrator.
 *
 * - private: the owner plus individually granted users
 * - project: additionally the members of the owning project
 * - public:  additionally every signed-in user
 *
 * `project` resolves the owning project the same way every other check does — chapter
 * first, then `contextProjectId` — so a session that belongs to no project grants
 * nothing through this tier.
 */
export const NARRATOR_VISIBILITIES = ["private", "project", "public"] as const;
export type NarratorVisibility = (typeof NARRATOR_VISIBILITIES)[number];

/**
 * Who may DRIVE a narrator: send messages, decide permission requests, change models,
 * roll back history, open terminals.
 *
 * - owner:   the owner, admins, and holders of an explicit write grant
 * - project: additionally project members holding write/manage. Members with only
 *            `read` are excluded: that tier means "cannot change the project", and
 *            driving a session inside it would go around that line.
 * - public:  additionally anyone who can pass the project gate
 *
 * Both non-owner tiers still require the project gate, so removing someone from a
 * project immediately stops them driving its sessions.
 */
export const NARRATOR_WRITE_AUDIENCES = ["owner", "project", "public"] as const;
export type NarratorWriteAudience = (typeof NARRATOR_WRITE_AUDIENCES)[number];

/**
 * The write audiences each read audience permits — the nesting rule itself.
 *
 * Ordered narrowest-first within each entry, so the last element is the widest write
 * audience that read audience allows (which is what {@link clampWriteAudience} needs).
 *
 * The three combinations this forbids are exactly the three that made `visibility`
 * lie: private+project, private+public, and project+public.
 */
export const WRITE_AUDIENCE_BY_VISIBILITY: Record<
	NarratorVisibility,
	readonly NarratorWriteAudience[]
> = {
	private: ["owner"],
	project: ["owner", "project"],
	public: ["owner", "project", "public"],
};

/**
 * Whether this pair is legal.
 *
 * Takes strings rather than the union types because both values arrive from the
 * database and from HTTP bodies, where an out-of-enum value is possible. An
 * unrecognized value on either side is refused (fail closed) rather than treated as
 * some default.
 */
export function isWriteAudienceAllowed(visibility: string, writeAudience: string): boolean {
	const allowed = WRITE_AUDIENCE_BY_VISIBILITY[visibility as NarratorVisibility];
	if (!allowed) return false;
	return allowed.includes(writeAudience as NarratorWriteAudience);
}

/** The widest write audience a read audience permits. Unknown visibility → "owner". */
export function widestWriteAudienceFor(visibility: string): NarratorWriteAudience {
	const allowed = WRITE_AUDIENCE_BY_VISIBILITY[visibility as NarratorVisibility];
	return allowed?.at(-1) ?? "owner";
}

/**
 * The write audience to keep when the read audience is narrowed.
 *
 * Returns the current value when it is already legal, otherwise the widest one the new
 * read audience permits — so `public` becomes `project` when visibility drops to
 * `project`, rather than collapsing all the way to `owner`.
 *
 * This exists because narrowing a read audience must never be REFUSED for producing an
 * illegal pair. Refusing would leave the user stuck at the more open setting they were
 * trying to back out of, which is the worst possible direction for a safety control to
 * fail in. Widening the write audience is the opposite case and is rejected instead:
 * that would enlarge an audience the user did not ask to enlarge.
 */
export function clampWriteAudience(
	visibility: string,
	writeAudience: string,
): NarratorWriteAudience {
	if (isWriteAudienceAllowed(visibility, writeAudience)) {
		return writeAudience as NarratorWriteAudience;
	}
	return widestWriteAudienceFor(visibility);
}
