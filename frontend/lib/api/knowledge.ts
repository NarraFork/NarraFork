import { request } from "./client";
import type {
	KnowledgeCollection,
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
	KnowledgePersonalEntry,
	KnowledgeRebaseResult,
	KnowledgeReviewResult,
	KnowledgeRevision,
	KnowledgeSearchResult,
	KnowledgeSubmission,
	KnowledgeSubmissionDetail,
	KnowledgeTag,
	KnowledgeTagType,
	KnowledgeUserAcl,
	KnowledgeVerdict,
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
	rebaseKnowledgeDraft: (draftId: string) =>
		request<KnowledgeRebaseResult>(`/knowledge/drafts/${draftId}/rebase`, { method: "POST" }),
	submitKnowledgeDraft: (draftId: string, data: { changeNote?: string } = {}) =>
		request<KnowledgeSubmission>(`/knowledge/drafts/${draftId}/submit`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// ─── Personal library (standalone personal entries) ───
	listMyPersonalEntries: (opts: { status?: "active" | "archived"; limit?: number } = {}) =>
		request<KnowledgePersonalEntry[]>(
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
};
