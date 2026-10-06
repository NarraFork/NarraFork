/**
 * One logical fixture set for the project read adapters, written to BOTH backends.
 *
 * The point of this module is that SQLite and PostgreSQL receive the *same* rows, so a
 * parity failure means the adapters disagree rather than the fixtures differing. Row
 * objects are therefore plain data with no table references: each side inserts them
 * through its own Drizzle table set (`server/db/schema` vs `server/db/postgres-schema`),
 * which share property names column for column.
 *
 * Every positive case in the matrix has non-empty data behind it, and every negative
 * case points at data that genuinely EXISTS but must not be returned — an empty result
 * compared against an empty result proves nothing about an ACL predicate.
 */

/** Projects deliberately share this `updatedAt`, which is the list cursor's leading key. */
export const T_SAME = "2026-02-01T00:00:00.000Z";
export const T_LATER = "2026-03-01T00:00:00.000Z";
/** Chapters c_a and c_b share this `createdAt`, so the id tiebreak is exercised. */
export const T1 = "2026-01-01T00:00:00.000Z";
export const T2 = "2026-01-02T00:00:00.000Z";
export const T3 = "2026-01-03T00:00:00.000Z";

export const USER = {
	owner: "u_owner",
	admin: "u_admin",
	read: "u_read",
	write: "u_write",
	manage: "u_manage",
	/** Holds an acl_grants row whose `domain_kind` is set — never project access. */
	domain: "u_domain",
	/** Exists, has no grant anywhere. */
	none: "u_none",
	other: "u_other",
	bulk: "u_bulk",
	/**
	 * Owns the mixed-case ordering fixtures, and has a MIXED-CASE id itself.
	 *
	 * The id matters: `owner_user_id = ?` is the ACL's ownership test, and it is an EQUALITY
	 * comparison rather than an ordering one. Under a deterministic collation (glibc
	 * `en_US.utf8` is deterministic, as is `C`) equality is byte equality either way, so this
	 * pins that the `COLLATE "C"` ordering fix did not have to touch the ACL predicates and
	 * that a mixed-case owner id still matches on both backends.
	 */
	caseMix: "u_CaseMix",
} as const;

/** Never inserted: the "unknown principal" case. */
export const GHOST_USER = "u_ghost_not_in_users";

export const PROJECT = {
	pub: "p_pub",
	pub2: "p_pub2",
	priv: "p_priv",
	arch: "p_arch",
	other: "p_other",
	bulk: "p_bulk",
	/** Holds the mixed-case ordering chapters; see {@link CASE_MIX_PROJECT_IDS}. */
	caseMix: "p_CaseMix",
} as const;

/**
 * Ids whose ORDER depends on the collation, so a backend that does not order text by bytes
 * is caught instead of agreeing by accident.
 *
 * Every id here shares its group's sort key (`updatedAt` for projects, `createdAt` for
 * chapters), which means the id tiebreak alone decides the order — the comparison under test
 * is nothing but text collation.
 *
 * Two divergence shapes, because they fail differently:
 *
 *   - `Zeta` / `alpha`: a plain case reversal. `'Z'` (0x5A) precedes `'a'` (0x61) in byte
 *     order, while a case-insensitive locale puts `alpha` first. This is the shape that
 *     reorders whole pages;
 *   - `Aa` / `aA` / `AA` / `aa`: four ids differing ONLY in case. Byte order groups them by
 *     the case of each position; glibc `en_US.utf8` sorts them adjacently, deciding on a
 *     tertiary weight. This is the shape that moves a single row across a page boundary,
 *     which is the one a cursor turns into a skipped or repeated row.
 *
 * These are all-ASCII on purpose: the bug does not need exotic characters, and using them
 * would invite the reading that this is about Unicode rather than about case.
 */
export const CASE_MIX_PROJECT_IDS = [
	"p_cmZeta",
	"p_cmalpha",
	"p_cmAA",
	"p_cmAa",
	"p_cmaA",
	"p_cmaa",
] as const;

/** The same shapes as chapter ids, inside {@link PROJECT.caseMix}. */
export const CASE_MIX_CHAPTER_IDS = [
	"c_cmZeta",
	"c_cmalpha",
	"c_cmAA",
	"c_cmAa",
	"c_cmaA",
	"c_cmaa",
] as const;

/**
 * The order both backends must return the mixed-case groups in: BYTE order.
 *
 * Written out literally rather than computed with `.sort()`. A test that sorts the expected
 * value with the same rule it is checking passes whatever the rule is, and JS `.sort()`
 * happens to be codepoint order — so deriving it would silently assert "the backend agrees
 * with JavaScript" while looking like it asserts a specific sequence. Uppercase letters
 * precede lowercase here (`Z` = 0x5A < `a` = 0x61), which is precisely what glibc
 * `en_US.utf8` does NOT do.
 */
export const CASE_MIX_PROJECT_IDS_BYTE_ORDER = [
	"p_cmAA",
	"p_cmAa",
	"p_cmZeta",
	"p_cmaA",
	"p_cmaa",
	"p_cmalpha",
] as const;

export const CASE_MIX_CHAPTER_IDS_BYTE_ORDER = [
	"c_cmAA",
	"c_cmAa",
	"c_cmZeta",
	"c_cmaA",
	"c_cmaa",
	"c_cmalpha",
] as const;

export const CHAPTER = {
	a: "c_a",
	b: "c_b",
	c: "c_c",
	review: "c_review",
	pub: "c_pub1",
	other1: "c_o1",
	other2: "c_o2",
} as const;

export const NARRATOR = {
	pubOther: "n_pub_other",
	privOther: "n_priv_other",
	projOther: "n_proj_other",
	ownRead: "n_own_read",
	granted: "n_granted",
	pubVisible: "n_pubproj_public",
	pubHidden: "n_pubproj_private",
} as const;

export const EDGE = {
	fork: "e_fork",
	merge: "e_merge",
	dependency: "e_dep",
	cherryPick: "e_cherry",
	review: "e_review",
	otherProject: "e_other",
} as const;

/**
 * Edge ids over the mixed-case chapters, sharing one `createdAt`.
 *
 * `getGraph` orders edges by `createdAt, id` and that order decides WHICH edges survive
 * `graphEdges`, so it is collation-sensitive for the same reason the chapter list is.
 */
export const CASE_MIX_EDGE_IDS = [
	"e_cmZeta",
	"e_cmalpha",
	"e_cmAA",
	"e_cmAa",
	"e_cmaA",
	"e_cmaa",
] as const;

/** Byte order, written out literally — see {@link CASE_MIX_PROJECT_IDS_BYTE_ORDER}. */
export const CASE_MIX_EDGE_IDS_BYTE_ORDER = [
	"e_cmAA",
	"e_cmAa",
	"e_cmZeta",
	"e_cmaA",
	"e_cmaa",
	"e_cmalpha",
] as const;

/** Above the adapters' 200/201 caps, so truncation is observable rather than theoretical. */
export const BULK_PROJECT_COUNT = 205;
export const BULK_CHAPTER_COUNT = 205;
/**
 * How many of the 205 bulk rows get an UPPERCASE-marked id; the rest get a lowercase one.
 *
 * Chosen so the two halves interleave differently under the two collations at every boundary
 * the adapters actually stop at — page 1 of a 25-row walk, the 200-row clamp, and the 201-row
 * `listChapters` cap. Measured on `postgres:17` (glibc `en_US.utf8`) against byte order, with
 * this split the SETS kept at 200 and at 201 genuinely differ, not merely their order:
 *
 *   byte order drops: …ba098, ba099, ba100, ba101, ba102
 *   glibc drops:      …ba101, bA101, ba102, bA102, bA103
 *
 * That is what makes the truncation contract testable rather than nominal: a backend ordering
 * text by a locale keeps DIFFERENT rows, so the "which rows survive the cap" comparison fails
 * instead of passing with a reshuffled but equal set.
 */
const BULK_UPPER_COUNT = 103;

export const userRows = [
	{ id: USER.owner, username: "owner", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{ id: USER.admin, username: "admin", passwordHash: "x", role: "admin" as const, createdAt: T1 },
	{ id: USER.read, username: "reader", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{ id: USER.write, username: "writer", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{ id: USER.manage, username: "manager", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{
		id: USER.domain,
		username: "domained",
		passwordHash: "x",
		role: "user" as const,
		createdAt: T1,
	},
	{ id: USER.none, username: "nobody", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{ id: USER.other, username: "other", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{ id: USER.bulk, username: "bulk", passwordHash: "x", role: "user" as const, createdAt: T1 },
	{
		id: USER.caseMix,
		username: "CaseMix",
		passwordHash: "x",
		role: "user" as const,
		createdAt: T1,
	},
];

export const projectRows = [
	{
		id: PROJECT.pub,
		name: "Public project",
		visibility: "public" as const,
		status: "active" as const,
		ownerUserId: USER.owner,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	{
		id: PROJECT.pub2,
		name: "Public project owned by someone else",
		visibility: "public" as const,
		status: "active" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	{
		id: PROJECT.priv,
		name: "Private project",
		visibility: "private" as const,
		status: "active" as const,
		ownerUserId: USER.owner,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	{
		id: PROJECT.arch,
		name: "Archived private project",
		visibility: "private" as const,
		status: "archived" as const,
		ownerUserId: USER.owner,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	{
		id: PROJECT.other,
		name: "Project of another owner",
		visibility: "private" as const,
		status: "active" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T_LATER,
	},
	{
		id: PROJECT.bulk,
		name: "Bulk project",
		visibility: "private" as const,
		status: "active" as const,
		ownerUserId: USER.bulk,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	{
		id: PROJECT.caseMix,
		name: "Mixed-case ordering project",
		visibility: "private" as const,
		status: "active" as const,
		ownerUserId: USER.caseMix,
		createdAt: T1,
		updatedAt: T_SAME,
	},
	// The mixed-case ordering GROUP: six projects differing only in the case of their ids,
	// all sharing `updatedAt`, so the id tiebreak is the whole comparison. `u_CaseMix` owns
	// them, which keeps them out of every other principal's listing.
	...CASE_MIX_PROJECT_IDS.map((id) => ({
		id,
		name: `Case mix ${id}`,
		visibility: "private" as const,
		status: "active" as const,
		ownerUserId: USER.caseMix,
		createdAt: T1,
		updatedAt: T_SAME,
	})),
];

/**
 * `p_bA001`…`p_bA103` then `p_ba001`…`p_ba102` — MIXED CASE, one shared `updatedAt`.
 *
 * These ids used to be all-lowercase (`p_b001`…), which made every paging and truncation
 * comparison in the suite blind to the defect this fixture now catches: with one case only,
 * byte order and a case-insensitive locale produce the SAME sequence, so PostgreSQL agreed
 * with SQLite no matter which collation it used. Real ids come from `nanoid`, whose alphabet
 * is mixed case, so the all-lowercase fixture was the least realistic choice available.
 *
 * The two case runs are interleaved by NUMBER (`bA001`, `ba001`, `bA002`, …), so the two
 * collations disagree from the very first page rather than only deep in the walk. See
 * {@link BULK_UPPER_COUNT} for the measured effect at each cap.
 */
export function bulkProjectRows() {
	return Array.from({ length: BULK_PROJECT_COUNT }, (_, index) => {
		const upper = index < BULK_UPPER_COUNT;
		const ordinal = upper ? index + 1 : index + 1 - BULK_UPPER_COUNT;
		return {
			id: `p_b${upper ? "A" : "a"}${String(ordinal).padStart(3, "0")}`,
			name: `Bulk ${index + 1}`,
			visibility: "private" as const,
			status: "active" as const,
			ownerUserId: USER.bulk,
			createdAt: T1,
			updatedAt: T_SAME,
		};
	});
}

export function bulkProjectIds(): string[] {
	return bulkProjectRows().map((row) => row.id);
}

/**
 * Chapters, in two batches because `c_review` points at `c_a` through a self
 * referencing foreign key that must already exist.
 */
export const chapterRowsFirst = [
	{
		id: CHAPTER.a,
		projectId: PROJECT.priv,
		title: "Chapter A",
		status: "active" as const,
		role: "trunk" as const,
		branch: "main",
		baseBranch: "main",
		worktreePath: null,
		isRoot: 1,
		commitCount: 3,
		headCommitSha: "aaa1111",
		graphX: 10,
		graphY: 20,
		panelExpanded: 1,
		panelWidth: 400,
		panelHeight: 300,
		detachedPanelsJson: '[{"id":"dp-a"}]',
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: CHAPTER.b,
		projectId: PROJECT.priv,
		title: "Chapter B",
		status: "active" as const,
		role: "branch" as const,
		branch: "feat/b",
		baseBranch: "main",
		worktreePath: null,
		commitCount: 1,
		headCommitSha: "bbb2222",
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: CHAPTER.c,
		projectId: PROJECT.priv,
		title: "Chapter C",
		status: "dormant" as const,
		role: "exploration" as const,
		branch: "explore/c",
		baseBranch: "main",
		createdAt: T2,
		updatedAt: T2,
	},
	{
		id: CHAPTER.pub,
		projectId: PROJECT.pub,
		title: "Public chapter",
		status: "active" as const,
		role: "trunk" as const,
		branch: "main",
		baseBranch: "main",
		detachedPanelsJson: '[{"id":"dp-pub"}]',
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: CHAPTER.other1,
		projectId: PROJECT.other,
		title: "Foreign chapter 1",
		status: "active" as const,
		role: "trunk" as const,
		branch: "main",
		baseBranch: "main",
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: CHAPTER.other2,
		projectId: PROJECT.other,
		title: "Foreign chapter 2",
		status: "active" as const,
		role: "branch" as const,
		branch: "feat/foreign",
		baseBranch: "main",
		createdAt: T2,
		updatedAt: T2,
	},
];

export const chapterRowsSecond = [
	{
		id: CHAPTER.review,
		projectId: PROJECT.priv,
		title: "Review chapter",
		status: "active" as const,
		role: "review" as const,
		branch: "review/a",
		baseBranch: "main",
		reviewSourceChapterId: CHAPTER.a,
		reviewStatus: "pending",
		createdAt: T3,
		updatedAt: T3,
	},
];

/**
 * `c_bkA001`…`c_bkA103` then `c_bka001`…`c_bka102` — MIXED CASE, all sharing `createdAt`.
 *
 * Same reasoning as {@link bulkProjectRows}: the id tiebreak alone decides the order of 205
 * rows, so with a single letter case the comparison could not tell byte order from a
 * case-insensitive locale. This set is what makes the 201-row `listChapters` cap and the
 * 200-chapter `getGraph` cap disagree between collations, in the retained SET and not only in
 * its order.
 *
 * `branch` carries the case marker too, because `(project_id, branch)` is UNIQUE: deriving it
 * from the ordinal alone would collide between the two case runs.
 */
export function bulkChapterRows() {
	return Array.from({ length: BULK_CHAPTER_COUNT }, (_, index) => {
		const upper = index < BULK_UPPER_COUNT;
		const marker = upper ? "A" : "a";
		const suffix = String(upper ? index + 1 : index + 1 - BULK_UPPER_COUNT).padStart(3, "0");
		return {
			id: `c_bk${marker}${suffix}`,
			projectId: PROJECT.bulk,
			title: "b",
			status: "active" as const,
			role: "branch" as const,
			branch: `bulk/${marker}${suffix}`,
			baseBranch: "main",
			createdAt: T1,
			updatedAt: T1,
		};
	});
}

export function bulkChapterIds(): string[] {
	return bulkChapterRows().map((row) => row.id);
}

/**
 * Six chapters of `p_CaseMix` differing only in id case, all sharing `createdAt`.
 *
 * Small on purpose: the bulk set proves the collation decides which rows survive a CAP, and
 * this one proves it decides the ORDER of a complete, untruncated page. The second is the
 * cheaper failure to read when something regresses, and it is also the case a reviewer can
 * check by eye against {@link CASE_MIX_CHAPTER_IDS_BYTE_ORDER}.
 */
export function caseMixChapterRows() {
	return CASE_MIX_CHAPTER_IDS.map((id) => ({
		id,
		projectId: PROJECT.caseMix,
		title: `Case mix ${id}`,
		status: "active" as const,
		role: "branch" as const,
		branch: `casemix/${id}`,
		baseBranch: "main",
		createdAt: T1,
		updatedAt: T1,
	}));
}

/**
 * Edges over the mixed-case chapters, sharing one `createdAt`.
 *
 * Chained `AA -> Aa -> Zeta -> aA -> aa -> alpha` in BYTE order so every edge has both
 * endpoints inside the group; `getGraph` drops an edge whose endpoints are missing, and a
 * dangling edge would make this fixture report truncation for the wrong reason.
 */
export function caseMixEdgeRows() {
	return CASE_MIX_EDGE_IDS.map((id, index) => ({
		id,
		projectId: PROJECT.caseMix,
		sourceId: CASE_MIX_CHAPTER_IDS_BYTE_ORDER[index] as string,
		targetId: CASE_MIX_CHAPTER_IDS_BYTE_ORDER[
			(index + 1) % CASE_MIX_CHAPTER_IDS_BYTE_ORDER.length
		] as string,
		type: "fork" as const,
		metadata: null,
		createdAt: T1,
	}));
}

/** Every edge type the schema declares, plus one edge in an unreadable project. */
export const chapterEdgeRows = [
	{
		id: EDGE.fork,
		projectId: PROJECT.priv,
		sourceId: CHAPTER.a,
		targetId: CHAPTER.b,
		type: "fork" as const,
		metadata: { reason: "fork-edge" },
		createdAt: T1,
	},
	{
		id: EDGE.merge,
		projectId: PROJECT.priv,
		sourceId: CHAPTER.b,
		targetId: CHAPTER.a,
		type: "merge" as const,
		metadata: { strategy: "squash" },
		createdAt: T2,
	},
	{
		id: EDGE.dependency,
		projectId: PROJECT.priv,
		sourceId: CHAPTER.c,
		targetId: CHAPTER.a,
		type: "dependency" as const,
		metadata: null,
		createdAt: T2,
	},
	{
		id: EDGE.cherryPick,
		projectId: PROJECT.priv,
		sourceId: CHAPTER.c,
		targetId: CHAPTER.b,
		type: "cherry_pick" as const,
		metadata: { shas: ["deadbee"] },
		createdAt: T3,
	},
	{
		id: EDGE.review,
		projectId: PROJECT.priv,
		sourceId: CHAPTER.review,
		targetId: CHAPTER.a,
		type: "review" as const,
		metadata: null,
		createdAt: T3,
	},
	{
		id: EDGE.otherProject,
		projectId: PROJECT.other,
		sourceId: CHAPTER.other1,
		targetId: CHAPTER.other2,
		type: "fork" as const,
		metadata: null,
		createdAt: T1,
	},
];

/**
 * Narrators covering each visibility branch. The ones in `p_pub` matter most: the
 * project gate is open to everyone there, so only the narrator's own ACL can hide
 * `n_pubproj_private`.
 */
export const narratorRows = [
	{
		id: NARRATOR.pubOther,
		chapterId: CHAPTER.a,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "public" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.privOther,
		chapterId: CHAPTER.a,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "working" as const,
		substatus: "[]",
		visibility: "private" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.projOther,
		chapterId: CHAPTER.b,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "project" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.ownRead,
		chapterId: CHAPTER.b,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "private" as const,
		ownerUserId: USER.read,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.granted,
		chapterId: CHAPTER.c,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "private" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.pubVisible,
		chapterId: CHAPTER.pub,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "public" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: NARRATOR.pubHidden,
		chapterId: CHAPTER.pub,
		type: "primary" as const,
		variant: "primary" as const,
		inheritMode: "fresh" as const,
		status: "idle" as const,
		substatus: "[]",
		visibility: "private" as const,
		ownerUserId: USER.other,
		createdAt: T1,
		updatedAt: T1,
	},
];

export const containerRows = [
	{
		id: "ci_run",
		chapterId: CHAPTER.a,
		serviceName: "app",
		status: "running" as const,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: "ci_removed",
		chapterId: CHAPTER.b,
		serviceName: "app",
		status: "removed" as const,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: "ci_created",
		chapterId: CHAPTER.c,
		serviceName: "db",
		status: "created" as const,
		createdAt: T1,
		updatedAt: T1,
	},
	{
		id: "ci_pub",
		chapterId: CHAPTER.pub,
		serviceName: "app",
		status: "running" as const,
		createdAt: T1,
		updatedAt: T1,
	},
];

/**
 * Grants. `g_domain` is the trap: a project-scoped row with `capability = 'read'` whose
 * `domain_kind` is set is a knowledge credential, and reading it as project access is
 * exactly the leak `domain_kind is null` exists to prevent.
 */
export const aclGrantRows = [
	{
		id: "g_read",
		scopeType: "project" as const,
		scopeId: PROJECT.priv,
		principalType: "user" as const,
		principalId: USER.read,
		capability: "read" as const,
		createdAt: T1,
	},
	{
		id: "g_write",
		scopeType: "project" as const,
		scopeId: PROJECT.priv,
		principalType: "user" as const,
		principalId: USER.write,
		capability: "write" as const,
		createdAt: T1,
	},
	{
		id: "g_manage",
		scopeType: "project" as const,
		scopeId: PROJECT.priv,
		principalType: "user" as const,
		principalId: USER.manage,
		capability: "manage" as const,
		createdAt: T1,
	},
	{
		id: "g_domain",
		scopeType: "project" as const,
		scopeId: PROJECT.priv,
		principalType: "user" as const,
		principalId: USER.domain,
		capability: "read" as const,
		domainKind: "clearance" as const,
		domainValue: "secret",
		createdAt: T1,
	},
	{
		id: "g_narrator",
		scopeType: "narrator" as const,
		scopeId: NARRATOR.granted,
		principalType: "user" as const,
		principalId: USER.read,
		capability: "read" as const,
		createdAt: T1,
	},
];

/** Chapter ids of `p_priv`, in the order both adapters must return them. */
export const PRIV_CHAPTER_IDS_ORDERED = [CHAPTER.a, CHAPTER.b, CHAPTER.c, CHAPTER.review];
export const PRIV_EDGE_IDS = [EDGE.fork, EDGE.merge, EDGE.dependency, EDGE.cherryPick, EDGE.review];

/**
 * Proof that the mixed-case ids really are collation-sensitive, checked WITHOUT a database.
 *
 * A fixture claiming to expose a collation difference is worthless if a later edit quietly
 * removes the property — the suite would keep passing while testing nothing, which is the
 * exact failure mode that let the original defect hide behind all-lowercase ids. So the
 * property is asserted rather than trusted: a case-insensitive ordering (`localeCompare` with
 * `sensitivity: "base"`, standing in for what glibc `en_US.utf8` does at the primary level)
 * must NOT produce the same sequence as byte order.
 *
 * This is a necessary condition, not the real test. Whether PostgreSQL agrees with SQLite is
 * decided against a live server in the parity matrix, on both a musl and a glibc image.
 */
export function caseInsensitiveOrderDiffers(ids: readonly string[]): boolean {
	const byteOrder = [...ids].sort();
	const caseInsensitive = [...ids].sort((a, b) =>
		a.localeCompare(b, "en", { sensitivity: "base" }),
	);
	return byteOrder.join(",") !== caseInsensitive.join(",");
}
