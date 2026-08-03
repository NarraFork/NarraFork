import { request } from "./client";
import type {
	KnowledgeBulkGrantResponse,
	KnowledgeCollection,
	KnowledgeCollectionAcl,
	KnowledgeDeletePersonalEntryResult,
	KnowledgeDraft,
	KnowledgeDraftDiff,
	KnowledgeDraftDrift,
	KnowledgeEntry,
	KnowledgeEntryLink,
	KnowledgeFinding,
	KnowledgeGrant,
	KnowledgeGraph,
	KnowledgeLevel,
	KnowledgeLinkDirection,
	KnowledgeLinkType,
	KnowledgeOpenSubmission,
	KnowledgePersonalEntry,
	KnowledgePersonalEntrySummary,
	KnowledgeRebaseResult,
	KnowledgeRebaseStrategy,
	KnowledgeReviewInboxCount,
	KnowledgeReviewResult,
	KnowledgeReviewScope,
	KnowledgeRevision,
	KnowledgeSearchResult,
	KnowledgeSubmission,
	KnowledgeSubmissionDetail,
	KnowledgeTag,
	KnowledgeTagType,
	KnowledgeTransferOwnerResult,
	KnowledgeUserAcl,
	KnowledgeVerdict,
	KnowledgeWithdrawResult,
} from "./knowledge-types";

export interface CreateEntryInput {
	collectionId: string;
	title: string;
	slug?: string;
	content?: string;
	tags?: string[];
	keywords?: string[];
	metadata?: Record<string, unknown>;
	changeNote?: string;
}

export interface UpdateEntryAclInput {
	classificationLevel?: string | null;
	controlledTags?: string[];
	reviewTags?: string[];
	ownerUserId?: string | null;
}

/** Collection ACL update payload (no reviewTags — collections have no review axis). */
export interface UpdateCollectionAclInput {
	classificationLevel?: string | null;
	controlledTags?: string[];
	ownerUserId?: string | null;
}

/** One credential granted to many users at once. userIds is capped at 200 server-side. */
export interface BulkKnowledgeGrantInput {
	collectionId?: string;
	userIds: string[];
	grantType: "clearance" | "tag" | "review";
	clearanceLevel?: string;
	tagId?: string;
	canWrite?: boolean;
}

export interface CreateEntryLinkInput {
	toEntryId: string;
	linkType: KnowledgeLinkType;
	label?: string;
	toRevisionId?: string;
}

function qs(params: Record<string, string | undefined>): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== "") sp.set(k, v);
	}
	const s = sp.toString();
	return s ? `?${s}` : "";
}

export const knowledgeApi = {
	// ─── Collections ───
	listKnowledgeCollections: (projectId?: string) =>
		request<KnowledgeCollection[]>(`/knowledge/collections${qs({ projectId })}`),
	createKnowledgeCollection: (data: {
		name: string;
		slug?: string;
		description?: string;
		projectId?: string;
	}) =>
		request<KnowledgeCollection>("/knowledge/collections", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateKnowledgeCollection: (id: string, data: { name?: string; description?: string | null }) =>
		request<KnowledgeCollection>(`/knowledge/collections/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeCollection: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/collections/${id}`, { method: "DELETE" }),

	// ─── Entries ───
	listKnowledgeEntries: (opts: { collectionId?: string; tag?: string; q?: string } = {}) =>
		request<KnowledgeSearchResult[] | KnowledgeEntry[]>(`/knowledge/entries${qs(opts)}`),
	getKnowledgeEntry: (id: string) => request<KnowledgeEntry>(`/knowledge/entries/${id}`),
	createKnowledgeEntry: (data: CreateEntryInput) =>
		request<KnowledgeEntry>("/knowledge/entries", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateKnowledgeEntryMeta: (
		id: string,
		data: {
			title?: string;
			tags?: string[];
			keywords?: string[];
			metadata?: Record<string, unknown>;
			status?: "active" | "archived";
		},
	) =>
		request<KnowledgeEntry>(`/knowledge/entries/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeEntry: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/entries/${id}`, { method: "DELETE" }),
	updateKnowledgeEntryAcl: (id: string, data: UpdateEntryAclInput) =>
		request<KnowledgeEntry>(`/knowledge/entries/${id}/acl`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// ─── Revisions (direct main write) ───
	addKnowledgeRevision: (entryId: string, data: { content: string; changeNote?: string }) =>
		request<{ entryId: string; revisionId: string; version: number }>(
			`/knowledge/entries/${entryId}/revisions`,
			{ method: "POST", body: JSON.stringify(data) },
		),
	listKnowledgeRevisions: (entryId: string) =>
		request<KnowledgeRevision[]>(`/knowledge/entries/${entryId}/revisions`),
	getKnowledgeRevision: (id: string) => request<KnowledgeRevision>(`/knowledge/revisions/${id}`),

	// ─── Entry links (entry-scope knowledge graph) ───
	listKnowledgeEntryLinks: (entryId: string, direction: KnowledgeLinkDirection = "both") =>
		request<KnowledgeEntryLink[]>(`/knowledge/entries/${entryId}/links${qs({ direction })}`),
	createKnowledgeEntryLink: (entryId: string, data: CreateEntryLinkInput) =>
		request<KnowledgeEntryLink>(`/knowledge/entries/${entryId}/links`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeEntryLink: (linkId: string) =>
		request<{ ok: boolean }>(`/knowledge/links/${linkId}`, { method: "DELETE" }),
	getKnowledgeEntryGraph: (entryId: string, depth?: number) =>
		request<KnowledgeGraph>(
			`/knowledge/entries/${entryId}/graph${qs({ depth: depth ? String(depth) : undefined })}`,
		),

	// ─── Drafts ───
	createKnowledgeDraft: (entryId: string, data: { name?: string } = {}) =>
		request<KnowledgeDraft>(`/knowledge/entries/${entryId}/drafts`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	getMyKnowledgeDraft: (entryId: string) =>
		request<KnowledgeDraft | null>(`/knowledge/entries/${entryId}/drafts/mine`),
	getKnowledgeDraftDrift: (entryId: string) =>
		request<KnowledgeDraftDrift>(`/knowledge/entries/${entryId}/drafts/mine/drift`),
	updateKnowledgeDraft: (draftId: string, data: { content: string; name?: string }) =>
		request<KnowledgeDraft>(`/knowledge/drafts/${draftId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	getKnowledgeDraftDiff: (draftId: string, against: "base" | "current" = "current") =>
		request<KnowledgeDraftDiff>(`/knowledge/drafts/${draftId}/diff${qs({ against })}`),
	/**
	 * Rebase a drifted draft. `merge` (default) three-way merges; `theirs` replaces the draft
	 * with current main and DISCARDS local edits — confirm with the user before calling it.
	 */
	rebaseKnowledgeDraft: (draftId: string, strategy: KnowledgeRebaseStrategy = "merge") =>
		request<KnowledgeRebaseResult>(
			`/knowledge/drafts/${draftId}/rebase${qs({ strategy: strategy === "merge" ? undefined : strategy })}`,
			{ method: "POST" },
		),
	submitKnowledgeDraft: (draftId: string, data: { changeNote?: string } = {}) =>
		request<KnowledgeSubmission>(`/knowledge/drafts/${draftId}/submit`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// ─── Personal library (standalone personal entries) ───
	listMyPersonalEntries: (opts: { status?: "active" | "archived"; limit?: number } = {}) =>
		// Summary shape: the server projects the body away and reports contentLength.
		request<KnowledgePersonalEntrySummary[]>(
			`/knowledge/personal-entries${qs({
				status: opts.status,
				limit: opts.limit !== undefined ? String(opts.limit) : undefined,
			})}`,
		),
	createPersonalEntry: (data: {
		title: string;
		content?: string;
		targetCollectionId?: string;
		keywords?: string[];
	}) =>
		request<KnowledgePersonalEntry>("/knowledge/personal-entries", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	getPersonalEntry: (id: string) =>
		request<KnowledgePersonalEntry>(`/knowledge/personal-entries/${id}`),
	updatePersonalEntryMeta: (
		id: string,
		data: { title?: string; targetCollectionId?: string | null; keywords?: string[] },
	) =>
		request<KnowledgePersonalEntry>(`/knowledge/personal-entries/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	/** Soft-delete (archive) a personal entry; open publish requests are rejected server-side. */
	deletePersonalEntry: (id: string) =>
		request<KnowledgeDeletePersonalEntryResult>(`/knowledge/personal-entries/${id}`, {
			method: "DELETE",
		}),
	/**
	 * Publish history for ONE personal entry, from the author's point of view.
	 * (GET /knowledge/submissions is the reviewer view and never returns your own.)
	 */
	listPersonalEntrySubmissions: (id: string, opts: { limit?: number } = {}) =>
		request<KnowledgeSubmission[]>(
			`/knowledge/personal-entries/${id}/submissions${qs({
				limit: opts.limit !== undefined ? String(opts.limit) : undefined,
			})}`,
		),
	/** The caller's own in-flight publish requests, for badging the personal-library list. */
	listMyOpenKnowledgeSubmissions: (opts: { limit?: number } = {}) =>
		request<KnowledgeOpenSubmission[]>(
			`/knowledge/my-open-submissions${qs({
				limit: opts.limit !== undefined ? String(opts.limit) : undefined,
			})}`,
		),

	// ─── Submissions (review) ───
	listKnowledgeSubmissions: (opts: { entryId?: string; status?: string } = {}) =>
		request<KnowledgeSubmission[]>(`/knowledge/submissions${qs(opts)}`),
	getKnowledgeSubmission: (id: string) =>
		request<KnowledgeSubmissionDetail>(`/knowledge/submissions/${id}`),
	reviewKnowledgeSubmission: (
		id: string,
		data: { verdict: KnowledgeVerdict; findings?: KnowledgeFinding[] },
	) =>
		request<KnowledgeReviewResult>(`/knowledge/submissions/${id}/review`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	resolveKnowledgeConflict: (id: string, data: { resolvedContent: string; changeNote?: string }) =>
		request<KnowledgeReviewResult>(`/knowledge/submissions/${id}/resolve`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// ─── ACL admin: levels / tags / grants ───
	listKnowledgeLevels: () => request<KnowledgeLevel[]>("/knowledge/levels"),
	createKnowledgeLevel: (data: { name: string; rank: number; label?: string }) =>
		request<KnowledgeLevel>("/knowledge/levels", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateKnowledgeLevel: (
		id: string,
		data: { name?: string; rank?: number; label?: string | null },
	) =>
		request<KnowledgeLevel>(`/knowledge/levels/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeLevel: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/levels/${id}`, { method: "DELETE" }),

	listKnowledgeTags: (collectionId?: string) =>
		request<KnowledgeTag[]>(`/knowledge/tags${qs({ collectionId })}`),
	createKnowledgeTag: (data: {
		name: string;
		collectionId?: string;
		controlled?: boolean;
		typeId?: string;
	}) =>
		request<KnowledgeTag>("/knowledge/tags", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateKnowledgeTag: (
		id: string,
		data: { name?: string; controlled?: boolean; typeId?: string | null },
	) =>
		request<KnowledgeTag>(`/knowledge/tags/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeTag: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/tags/${id}`, { method: "DELETE" }),

	listKnowledgeGrants: (opts: { principalType?: string; principalId?: string } = {}) =>
		request<KnowledgeGrant[]>(`/knowledge/grants${qs(opts)}`),
	createKnowledgeGrant: (data: {
		collectionId?: string;
		principalType: "user" | "role";
		principalId: string;
		grantType: "clearance" | "tag" | "review";
		clearanceLevel?: string;
		tagId?: string;
		canWrite?: boolean;
	}) =>
		request<KnowledgeGrant>("/knowledge/grants", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeGrant: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/grants/${id}`, { method: "DELETE" }),

	// ─── Tag types ───
	listKnowledgeTagTypes: () => request<KnowledgeTagType[]>("/knowledge/tag-types"),
	createKnowledgeTagType: (data: { name: string; sortOrder?: number }) =>
		request<KnowledgeTagType>("/knowledge/tag-types", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateKnowledgeTagType: (id: string, data: { name?: string; sortOrder?: number }) =>
		request<KnowledgeTagType>(`/knowledge/tag-types/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteKnowledgeTagType: (id: string) =>
		request<{ ok: boolean }>(`/knowledge/tag-types/${id}`, { method: "DELETE" }),

	// ─── Per-user ACL ───
	getUserAcl: (userId: string) => request<KnowledgeUserAcl>(`/knowledge/users/${userId}/acl`),
	setUserAcl: (
		userId: string,
		data: {
			clearanceLevel?: string | null;
			tagIds?: string[];
			reviewTagIds?: string[];
			canWrite?: boolean;
		},
	) =>
		request<{ ok: boolean }>(`/knowledge/users/${userId}/acl`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	// ─── Entry accessible users preview ───
	getEntryAccessibleUsers: (entryId: string) =>
		request<
			{
				userId: string;
				username: string;
				role: string;
				reason: "admin" | "owner" | "grant";
			}[]
		>(`/knowledge/entries/${entryId}/accessible-users`),

	// ─── Collection ACL (admin) ───
	getKnowledgeCollectionAcl: (id: string) =>
		request<KnowledgeCollectionAcl>(`/knowledge/collections/${id}/acl`),
	updateKnowledgeCollectionAcl: (id: string, data: UpdateCollectionAclInput) =>
		request<KnowledgeCollection>(`/knowledge/collections/${id}/acl`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// ─── Bulk grants (admin) ───
	bulkKnowledgeGrant: (data: BulkKnowledgeGrantInput) =>
		request<KnowledgeBulkGrantResponse>("/knowledge/grants/bulk", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// ─── Ownership transfer (admin OR current owner; enforced server-side) ───
	transferKnowledgeEntryOwner: (entryId: string, ownerUserId: string | null) =>
		request<KnowledgeTransferOwnerResult>(`/knowledge/entries/${entryId}/transfer-owner`, {
			method: "POST",
			body: JSON.stringify({ ownerUserId }),
		}),
	transferKnowledgeCollectionOwner: (collectionId: string, ownerUserId: string | null) =>
		request<KnowledgeTransferOwnerResult>(`/knowledge/collections/${collectionId}/transfer-owner`, {
			method: "POST",
			body: JSON.stringify({ ownerUserId }),
		}),

	// ─── Review inbox badge ───
	getKnowledgeReviewInboxCount: () =>
		request<KnowledgeReviewInboxCount>("/knowledge/review-inbox/count"),

	// ─── Review state machine closure (withdraw / resubmit / scope) ───

	/** Withdraw one of YOUR open publish requests (pending / conflict) → `withdrawn`. */
	withdrawKnowledgeSubmission: (id: string, reason?: string) =>
		request<KnowledgeWithdrawResult>(`/knowledge/submissions/${id}/withdraw`, {
			method: "POST",
			body: JSON.stringify(reason ? { reason } : {}),
		}),
	/**
	 * Re-submit after `changes_requested`: a NEW submission built from the draft's current
	 * content, linked to the bounced one so the reviewer sees the round number.
	 */
	resubmitKnowledgeSubmission: (id: string, changeNote?: string) =>
		request<KnowledgeSubmission>(`/knowledge/submissions/${id}/resubmit`, {
			method: "POST",
			body: JSON.stringify(changeNote ? { changeNote } : {}),
		}),
	/** The caller's own review authority (review tags held + writable collections). */
	getMyKnowledgeReviewScope: () => request<KnowledgeReviewScope>("/knowledge/my-review-scope"),
};
