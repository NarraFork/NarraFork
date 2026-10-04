/**
 * The search port: what a database backend must provide for NarraFork's text search.
 *
 * WHY A PORT AT ALL
 * -----------------
 * Every search path in this codebase is FTS5 plus `MATCH`, `snippet()` and `rank` — none of
 * which survive a dialect change. Before this file those statements were spread across four
 * modules, so "what does a second backend have to reimplement?" could only be answered by
 * grepping for `_fts`. Now it is answered by this interface: implement it and search works;
 * fail to implement a method and it is a compile error, not a runtime surprise.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * No ranking, no scoring curve, no result ordering, no ACL decision-making, and no query
 * sanitizing. Those stay with the callers because they are product behaviour shared by all
 * backends: if scoring lived here, two backends could disagree about which hit is first
 * while both "passing". The backend's job is to return the matching rows, already gated,
 * with the raw relevance value attached.
 *
 * The ACL boundary is the one part of that split that is NOT negotiable. A search hit
 * carries a title and a body excerpt, so a backend that returned everything and left
 * filtering to the caller would have already computed an excerpt from content the viewer
 * cannot read. Every method that takes a `viewer` must therefore apply the gate INSIDE the
 * query. `searchKnowledge*` is the documented exception: knowledge visibility is a dual-axis
 * clearance + controlled-tag check over grants, which no single query expresses, so its rows
 * are gated by `knowledgeService.filterReadable` afterwards. That is safe only because the
 * knowledge excerpt is bracketed body text the caller drops wholesale when the row is
 * unreadable — and it is why `KnowledgeSearchRow` carries no snippet the caller can leak by
 * forgetting to filter. Do not extend that exception to any other row type.
 *
 * ASYNCHRONOUS BY CONTRACT
 * ------------------------
 * Every method returns a Promise, because a networked backend cannot produce its rows
 * synchronously, and a port that only a synchronous driver can satisfy would pin search to
 * SQLite forever. The SQLite implementation executes its synchronous driver queries in
 * a dedicated worker; callers await genuinely asynchronous work instead of blocking the
 * HTTP thread. Query signals are forwarded to the executor for cancellation.
 *
 * The consequence for callers is load-bearing and enforced by the type system: a store
 * result that is not awaited is a Promise, and every place rows are consumed (indexed,
 * mapped, measured) is a compile error rather than a silent empty result. The backend
 * selection in `backend.ts` still refuses to hand back a backend it cannot actually
 * provide.
 */

import type {
	ChapterSearchRow,
	EntitySearchQuery,
	KnowledgeDraftSearchQuery,
	KnowledgeSearchQuery,
	KnowledgeSearchRow,
	MessageSearchRow,
	NarratorSearchRow,
	RecallMessageRow,
	RecallSearchQuery,
	ShadowedEntryQuery,
	TimelineSearchQuery,
	TimelineSearchRow,
} from "./types";

export interface SearchStore {
	/** Stable name for diagnostics and for the backend-selection test. */
	readonly backend: string;

	/**
	 * Chapters, gated by the viewer's access to the owning project.
	 *
	 * A chapter hit exposes its title, a description excerpt and the project name, so the
	 * project gate belongs in the query. A chapter whose project row has vanished must be
	 * excluded rather than treated as ungated.
	 */
	searchChapters(query: EntitySearchQuery): Promise<ChapterSearchRow[]>;

	/** Narrator messages, gated by the viewer's visibility of the owning narrator. */
	searchMessages(query: EntitySearchQuery): Promise<MessageSearchRow[]>;

	/** Narrators by title, gated by the viewer's visibility of the narrator. */
	searchNarrators(query: EntitySearchQuery): Promise<NarratorSearchRow[]>;

	/**
	 * Messages on one narrator's timeline, newest first, each with the seq to jump to.
	 *
	 * Not viewer-gated: the caller has already authorized access to this narrator, and the
	 * result set is scoped to refs the narrator owns or inherited. Timeline-hidden refs
	 * (segment-compacted) must be excluded, or search would surface messages the transcript
	 * does not show.
	 */
	searchTimeline(query: TimelineSearchQuery): Promise<TimelineSearchRow[]>;

	/**
	 * Messages for the Recall agent tool.
	 *
	 * Not viewer-gated either, and for a sharper reason: Recall runs as the narrator, whose
	 * authorization is decided by the tool's own permission flow before this call. Scoped
	 * mode must resolve through the narrator's refs so fork-shared history stays visible;
	 * global mode resolves through each message's owning narrator so a shared message is
	 * reported once, against its origin.
	 */
	searchRecallMessages(query: RecallSearchQuery): Promise<RecallMessageRow[]>;

	/**
	 * Committed knowledge entries.
	 *
	 * Rows are NOT access-filtered — see the ACL note in this file's header. Callers must
	 * pass the result through `knowledgeService.filterReadable` before exposing anything.
	 *
	 * Must reject an unrecognized `field` rather than interpolate it into a query.
	 */
	searchKnowledgeEntries(query: KnowledgeSearchQuery): Promise<KnowledgeSearchRow[]>;

	/** One author's draft versions, same ACL caveat as `searchKnowledgeEntries`. */
	searchKnowledgeDrafts(query: KnowledgeDraftSearchQuery): Promise<KnowledgeSearchRow[]>;

	/** Entry ids the given author currently shadows with a draft, so the committed
	 *  search can exclude exactly the rows the draft search supplies. */
	listShadowedEntryIds(query: ShadowedEntryQuery): Promise<string[]>;
}
