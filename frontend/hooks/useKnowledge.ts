import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
	BulkKnowledgeGrantInput,
	CreateEntryInput,
	CreateEntryLinkInput,
	KnowledgeFinding,
	KnowledgeLinkDirection,
	KnowledgeRebaseStrategy,
	KnowledgeVerdict,
	UpdateCollectionAclInput,
	UpdateEntryAclInput,
} from "../lib/api";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const STALE = 30_000;

// ─── Collections ───
export function useKnowledgeCollections(projectId?: string) {
	return useQuery({
		queryKey: ["knowledge", "collections", projectId ?? null],
		queryFn: () => api.listKnowledgeCollections(projectId),
		staleTime: STALE,
	});
}

export function useCreateKnowledgeCollection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; slug?: string; description?: string; projectId?: string }) =>
			api.createKnowledgeCollection(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "collections"] }),
	});
}

export function useUpdateKnowledgeCollection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; name?: string; description?: string | null }) =>
			api.updateKnowledgeCollection(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "collections"] }),
	});
}

export function useDeleteKnowledgeCollection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeCollection(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "collections"] }),
	});
}

// ─── Entries ───
export function useKnowledgeEntries(opts: { collectionId?: string; tag?: string; q?: string }) {
	return useQuery({
		queryKey: ["knowledge", "entries", opts],
		queryFn: () => api.listKnowledgeEntries(opts),
		staleTime: STALE,
	});
}

export function useKnowledgeEntry(id: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "entry", id],
		queryFn: () => api.getKnowledgeEntry(id as string),
		enabled: !!id,
	});
}

export function useCreateKnowledgeEntry() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateEntryInput) => api.createKnowledgeEntry(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "entries"] }),
	});
}

export function useUpdateKnowledgeEntryMeta() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			title?: string;
			tags?: string[];
			keywords?: string[];
			metadata?: Record<string, unknown>;
			status?: "active" | "archived";
		}) => api.updateKnowledgeEntryMeta(id, data),
		onSuccess: (_r, { id }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entry", id] });
		},
	});
}

export function useDeleteKnowledgeEntry() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeEntry(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "entries"] }),
	});
}

export function useUpdateKnowledgeEntryAcl() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string } & UpdateEntryAclInput) =>
			api.updateKnowledgeEntryAcl(id, data),
		onSuccess: (_r, { id }) => qc.invalidateQueries({ queryKey: ["knowledge", "entry", id] }),
	});
}

// ─── Revisions ───
export function useKnowledgeRevisions(entryId: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "revisions", entryId],
		queryFn: () => api.listKnowledgeRevisions(entryId as string),
		enabled: !!entryId,
	});
}

export function useKnowledgeRevision(id: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "revision", id],
		queryFn: () => api.getKnowledgeRevision(id as string),
		enabled: !!id,
	});
}

export function useAddKnowledgeRevision() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, ...data }: { entryId: string; content: string; changeNote?: string }) =>
			api.addKnowledgeRevision(entryId, data),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "entry", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "revisions", entryId] });
		},
	});
}

// ─── Entry links (entry-scope knowledge graph) ───
export function useEntryLinks(
	entryId: string | undefined,
	direction: KnowledgeLinkDirection = "both",
) {
	return useQuery({
		queryKey: ["knowledge", "links", entryId, direction],
		queryFn: () => api.listKnowledgeEntryLinks(entryId as string, direction),
		enabled: !!entryId,
		staleTime: STALE,
	});
}

export function useCreateEntryLink() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, ...data }: { entryId: string } & CreateEntryLinkInput) =>
			api.createKnowledgeEntryLink(entryId, data),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "links", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "graph", entryId] });
		},
	});
}

export function useDeleteEntryLink() {
	const qc = useQueryClient();
	return useMutation({
		// entryId is passed through only to scope cache invalidation back to the anchor entry.
		mutationFn: ({ linkId }: { linkId: string; entryId?: string }) =>
			api.deleteKnowledgeEntryLink(linkId),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "links", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "graph", entryId] });
		},
	});
}

export function useEntryGraph(entryId: string | undefined, depth?: number) {
	return useQuery({
		queryKey: ["knowledge", "graph", entryId, depth ?? null],
		queryFn: () => api.getKnowledgeEntryGraph(entryId as string, depth),
		enabled: !!entryId,
		staleTime: STALE,
	});
}

// ─── Drafts ───
export function useMyKnowledgeDraft(entryId: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "draft", entryId],
		queryFn: () => api.getMyKnowledgeDraft(entryId as string),
		enabled: !!entryId,
	});
}

export function useCreateKnowledgeDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, name }: { entryId: string; name?: string }) =>
			api.createKnowledgeDraft(entryId, name ? { name } : {}),
		onSuccess: (_r, { entryId }) =>
			qc.invalidateQueries({ queryKey: ["knowledge", "draft", entryId] }),
	});
}

export function useUpdateKnowledgeDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			draftId,
			...data
		}: {
			draftId: string;
			entryId: string;
			content: string;
			name?: string;
		}) => api.updateKnowledgeDraft(draftId, { content: data.content, name: data.name }),
		onSuccess: (_r, { entryId }) =>
			qc.invalidateQueries({ queryKey: ["knowledge", "draft", entryId] }),
	});
}

export function useKnowledgeDraftDiff(
	draftId: string | undefined,
	against: "base" | "current" = "current",
) {
	return useQuery({
		queryKey: ["knowledge", "draftDiff", draftId, against],
		queryFn: () => api.getKnowledgeDraftDiff(draftId as string, against),
		enabled: !!draftId,
	});
}

/** Whether the caller's active draft on this entry has drifted behind current main. */
export function useKnowledgeDraftDrift(entryId: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "draftDrift", entryId],
		queryFn: () => api.getKnowledgeDraftDrift(entryId as string),
		enabled: !!entryId,
	});
}

/**
 * Rebase a drifted draft onto current main.
 *
 * Default strategy `merge` three-way merges and may return `ok: false` with conflict sides.
 * `theirs` takes main verbatim and DISCARDS local edits (never conflicts) — callers must
 * confirm with the user first.
 */
export function useRebaseKnowledgeDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			draftId,
			strategy,
		}: {
			draftId: string;
			entryId: string;
			strategy?: KnowledgeRebaseStrategy;
		}) => api.rebaseKnowledgeDraft(draftId, strategy ?? "merge"),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "draft", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "draftDrift", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "draftDiff"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
		},
	});
}

// ─── Personal library (standalone personal entries) ───
export function useMyPersonalEntries(opts: { status?: "active" | "archived" } = {}) {
	return useQuery({
		queryKey: ["knowledge", "personalEntries", opts],
		queryFn: () => api.listMyPersonalEntries(opts),
		staleTime: 5_000,
	});
}

export function useCreatePersonalEntry() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			title: string;
			content?: string;
			targetCollectionId?: string;
			keywords?: string[];
		}) => api.createPersonalEntry(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] }),
	});
}

export function useUpdatePersonalEntryMeta() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			title?: string;
			targetCollectionId?: string | null;
			keywords?: string[];
		}) => api.updatePersonalEntryMeta(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] }),
	});
}

export function useSubmitKnowledgeDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ draftId, ...data }: { draftId: string; entryId: string; changeNote?: string }) =>
			api.submitKnowledgeDraft(draftId, { changeNote: data.changeNote }),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "draft", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
		},
	});
}

// ─── Submissions ───
export function useKnowledgeSubmissions(opts: { entryId?: string; status?: string } = {}) {
	return useQuery({
		queryKey: ["knowledge", "submissions", opts],
		queryFn: () => api.listKnowledgeSubmissions(opts),
		staleTime: 10_000,
	});
}

export function useKnowledgeSubmission(id: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "submission", id],
		queryFn: () => api.getKnowledgeSubmission(id as string),
		enabled: !!id,
	});
}

export function useReviewKnowledgeSubmission() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			verdict: KnowledgeVerdict;
			findings?: KnowledgeFinding[];
		}) => api.reviewKnowledgeSubmission(id, { verdict: data.verdict, findings: data.findings }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submission"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entry"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
		},
	});
}

export function useResolveKnowledgeConflict() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; resolvedContent: string; changeNote?: string }) =>
			api.resolveKnowledgeConflict(id, {
				resolvedContent: data.resolvedContent,
				changeNote: data.changeNote,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submission"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entry"] });
		},
	});
}

// ─── ACL admin: levels / tags / grants ───
export function useKnowledgeLevels() {
	return useQuery({
		queryKey: ["knowledge", "levels"],
		queryFn: api.listKnowledgeLevels,
		staleTime: STALE,
	});
}

export function useCreateKnowledgeLevel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; rank: number; label?: string }) =>
			api.createKnowledgeLevel(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "levels"] }),
	});
}

export function useUpdateKnowledgeLevel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			name?: string;
			rank?: number;
			label?: string | null;
		}) => api.updateKnowledgeLevel(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "levels"] }),
	});
}

export function useDeleteKnowledgeLevel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeLevel(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "levels"] }),
	});
}

export function useKnowledgeTags(collectionId?: string) {
	return useQuery({
		queryKey: ["knowledge", "tags", collectionId ?? null],
		queryFn: () => api.listKnowledgeTags(collectionId),
		staleTime: STALE,
	});
}

export function useCreateKnowledgeTag() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			name: string;
			collectionId?: string;
			controlled?: boolean;
			typeId?: string;
		}) => api.createKnowledgeTag(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "tags"] }),
	});
}

export function useDeleteKnowledgeTag() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeTag(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "tags"] }),
	});
}

export function useKnowledgeGrants(opts: { principalType?: string; principalId?: string } = {}) {
	return useQuery({
		queryKey: ["knowledge", "grants", opts],
		queryFn: () => api.listKnowledgeGrants(opts),
		staleTime: STALE,
	});
}

export function useCreateKnowledgeGrant() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			collectionId?: string;
			principalType: "user" | "role";
			principalId: string;
			grantType: "clearance" | "tag" | "review";
			clearanceLevel?: string;
			tagId?: string;
			canWrite?: boolean;
		}) => api.createKnowledgeGrant(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "grants"] }),
	});
}

export function useDeleteKnowledgeGrant() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeGrant(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "grants"] }),
	});
}

// ─── Tag types ───
export function useKnowledgeTagTypes() {
	return useQuery({
		queryKey: ["knowledge", "tagTypes"],
		queryFn: api.listKnowledgeTagTypes,
		staleTime: STALE,
	});
}

export function useCreateKnowledgeTagType() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { name: string; sortOrder?: number }) => api.createKnowledgeTagType(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "tagTypes"] }),
	});
}

export function useUpdateKnowledgeTagType() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; name?: string; sortOrder?: number }) =>
			api.updateKnowledgeTagType(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "tagTypes"] }),
	});
}

export function useDeleteKnowledgeTagType() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteKnowledgeTagType(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["knowledge", "tagTypes"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "tags"] });
		},
	});
}

export function useUpdateKnowledgeTag() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			name?: string;
			controlled?: boolean;
			typeId?: string | null;
		}) => api.updateKnowledgeTag(id, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge", "tags"] }),
	});
}

// ─── Per-user ACL ───
export function useUserAcl(userId: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "userAcl", userId],
		queryFn: () => api.getUserAcl(userId as string),
		enabled: !!userId,
	});
}

export function useSetUserAcl() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			userId,
			...data
		}: {
			userId: string;
			clearanceLevel?: string | null;
			tagIds?: string[];
			reviewTagIds?: string[];
			canWrite?: boolean;
		}) => api.setUserAcl(userId, data),
		onSuccess: (_r, { userId }) =>
			qc.invalidateQueries({ queryKey: ["knowledge", "userAcl", userId] }),
	});
}

// ─── Entry accessible users preview ───
export function useEntryAccessibleUsers(entryId: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "entryAccessibleUsers", entryId],
		queryFn: () => api.getEntryAccessibleUsers(entryId as string),
		enabled: !!entryId,
		staleTime: STALE,
	});
}

// ─── Personal entry detail: read / delete / publish history (WP2) ───

/** One of the caller's own personal entries (author or admin; otherwise 404). */
export function usePersonalEntry(id: string | undefined) {
	return useQuery({
		queryKey: ["knowledge", "personalEntry", id],
		queryFn: () => api.getPersonalEntry(id as string),
		enabled: !!id,
	});
}

/**
 * Publish history for ONE personal entry, from the author's point of view.
 * `useKnowledgeSubmissions` is the reviewer view and never returns your own submissions.
 */
export function usePersonalEntrySubmissions(id: string | undefined, limit?: number) {
	return useQuery({
		queryKey: ["knowledge", "personalEntrySubmissions", id, limit ?? null],
		queryFn: () => api.listPersonalEntrySubmissions(id as string, { limit }),
		enabled: !!id,
		staleTime: 10_000,
	});
}

/** Soft-delete (archive) a personal entry. Open publish requests are rejected server-side. */
export function useDeletePersonalEntry() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deletePersonalEntry(id),
		onSuccess: (_r, id) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntry", id] });
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntrySubmissions", id] });
			// The delete may have rejected an open publish request → refresh reviewer + badge views.
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "myOpenSubmissions"] });
		},
	});
}

/**
 * Save the body of a personal entry (standalone or linked) by draft id.
 *
 * `useUpdateKnowledgeDraft` requires an `entryId` for cache invalidation, which a
 * standalone personal entry doesn't have. This variant keys invalidation on the personal
 * entry id instead so the standalone detail page can save its content.
 */
export function useUpdatePersonalEntryContent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, content, name }: { id: string; content: string; name?: string }) =>
			api.updateKnowledgeDraft(id, { content, name }),
		onSuccess: (_r, { id }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntry", id] });
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] });
			// updateDraft rejects any open publish request for this entry (stale proposal).
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntrySubmissions", id] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "myOpenSubmissions"] });
		},
	});
}

/**
 * The caller's own in-flight publish requests, keyed by draftId. One bounded query for the
 * whole personal-library list (badges), instead of one request per card.
 */
export function useMyOpenKnowledgeSubmissions(limit?: number) {
	return useQuery({
		queryKey: ["knowledge", "myOpenSubmissions", limit ?? null],
		queryFn: () => api.listMyOpenKnowledgeSubmissions({ limit }),
		staleTime: 10_000,
	});
}

/**
 * Publish a personal entry (create a publish request). Standalone entries need a target
 * collection + title first — the backend enforces this and the UI disables the button.
 */
export function usePublishPersonalEntry() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, changeNote }: { id: string; changeNote?: string }) =>
			api.submitKnowledgeDraft(id, { changeNote }),
		onSuccess: (_r, { id }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntry", id] });
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "personalEntrySubmissions", id] });
			qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "myOpenSubmissions"] });
		},
	});
}

// ─── Collection ACL (admin) ───

/** Read a collection's ACL for echo-back. admin-only endpoint; pass enabled=false otherwise. */
export function useKnowledgeCollectionAcl(id: string | undefined, enabled = true) {
	return useQuery({
		queryKey: ["knowledge", "collectionAcl", id],
		queryFn: () => api.getKnowledgeCollectionAcl(id as string),
		enabled: !!id && enabled,
		staleTime: STALE,
	});
}

export function useUpdateKnowledgeCollectionAcl() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string } & UpdateCollectionAclInput) =>
			api.updateKnowledgeCollectionAcl(id, data),
		onSuccess: (_r, { id }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "collectionAcl", id] });
			// The collection ACL is the FIRST read gate, so changing it can change which
			// collections and entries are visible at all — invalidate both listings.
			qc.invalidateQueries({ queryKey: ["knowledge", "collections"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
		},
	});
}

// ─── Bulk grants (admin) ───

/** Grant one credential to many users at once (userIds capped at 200 server-side). */
export function useBulkKnowledgeGrant() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: BulkKnowledgeGrantInput) => api.bulkKnowledgeGrant(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["knowledge", "grants"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "userAcl"] });
		},
	});
}

// ─── Ownership transfer (admin OR current owner; enforced server-side) ───

export function useTransferKnowledgeEntryOwner() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, ownerUserId }: { entryId: string; ownerUserId: string | null }) =>
			api.transferKnowledgeEntryOwner(entryId, ownerUserId),
		onSuccess: (_r, { entryId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "entry", entryId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
			qc.invalidateQueries({ queryKey: ["knowledge", "entryAccessibleUsers", entryId] });
		},
	});
}

export function useTransferKnowledgeCollectionOwner() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			collectionId,
			ownerUserId,
		}: {
			collectionId: string;
			ownerUserId: string | null;
		}) => api.transferKnowledgeCollectionOwner(collectionId, ownerUserId),
		onSuccess: (_r, { collectionId }) => {
			qc.invalidateQueries({ queryKey: ["knowledge", "collectionAcl", collectionId] });
			qc.invalidateQueries({ queryKey: ["knowledge", "collections"] });
			// Owner short-circuits reads, so a transfer changes entry visibility too.
			qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
		},
	});
}

// ─── Review inbox badge (live) ───

/** React Query key for the bounded review-inbox count. */
export const REVIEW_INBOX_COUNT_KEY = ["knowledge", "reviewInboxCount"] as const;

/**
 * Bounded count of open publish requests the current user may review.
 *
 * `capped: true` means there may be more than `count` — render `${count}+`.
 * Kept fresh by {@link useKnowledgeNotifications}, which invalidates this key when
 * the server pushes a `knowledge:review_inbox_changed` WS frame, so no polling.
 */
export function useReviewInboxCount() {
	return useQuery({
		queryKey: REVIEW_INBOX_COUNT_KEY,
		queryFn: api.getKnowledgeReviewInboxCount,
		staleTime: STALE,
	});
}

/**
 * Subscribe to knowledge-base publish/review pushes and invalidate the affected
 * queries. The WS frame carries ids only (no entry content), so every refresh goes
 * back through the ACL-checked HTTP endpoints.
 *
 * Mount once high in the tree (the app shell) so the nav badge stays live regardless
 * of which page is open.
 */
export function useKnowledgeNotifications(): void {
	const qc = useQueryClient();
	useEffect(() => {
		const handle = narratorWSManager.addListener(
			{ types: ["knowledge:review_inbox_changed"] },
			(data) => {
				if (data.type !== "knowledge:review_inbox_changed") return;
				qc.invalidateQueries({ queryKey: REVIEW_INBOX_COUNT_KEY });
				qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
				qc.invalidateQueries({ queryKey: ["knowledge", "submission"] });
				qc.invalidateQueries({ queryKey: ["knowledge", "myOpenSubmissions"] });
				qc.invalidateQueries({ queryKey: ["knowledge", "personalEntries"] });
				const entryId = typeof data.entryId === "string" ? data.entryId : undefined;
				if (data.reason === "entry_published") {
					qc.invalidateQueries({ queryKey: ["knowledge", "entries"] });
					if (entryId) {
						qc.invalidateQueries({ queryKey: ["knowledge", "entry", entryId] });
						qc.invalidateQueries({ queryKey: ["knowledge", "revisions", entryId] });
					}
				}
				if (entryId) {
					qc.invalidateQueries({ queryKey: ["knowledge", "draft", entryId] });
					qc.invalidateQueries({ queryKey: ["knowledge", "draftDrift", entryId] });
				}
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [qc]);
}

// ─── Review state machine closure: withdraw / resubmit / scope (WP5) ───

/**
 * Every view that shows a submission's state, invalidated after withdraw / resubmit.
 *
 * Both mutations move a submission between the author's queue and the reviewer's, so the
 * author-scoped views (personal entry history, my-open badge) and the reviewer-scoped views
 * (submissions list, inbox count) all go stale at once.
 */
function invalidateSubmissionViews(qc: ReturnType<typeof useQueryClient>, id?: string): void {
	qc.invalidateQueries({ queryKey: ["knowledge", "submissions"] });
	qc.invalidateQueries({ queryKey: ["knowledge", "submission"] });
	qc.invalidateQueries({ queryKey: ["knowledge", "myOpenSubmissions"] });
	qc.invalidateQueries({ queryKey: REVIEW_INBOX_COUNT_KEY });
	// The history list is keyed by personal-entry (draft) id; invalidate the whole prefix
	// when the caller only knows the submission id.
	if (id) qc.invalidateQueries({ queryKey: ["knowledge", "personalEntrySubmissions", id] });
	else qc.invalidateQueries({ queryKey: ["knowledge", "personalEntrySubmissions"] });
}

/**
 * Withdraw one of YOUR open publish requests (pending / conflict).
 *
 * `personalEntryId` is passed through only to scope cache invalidation to that entry's
 * publish history; the server identifies the target by submission id alone.
 */
export function useWithdrawKnowledgeSubmission() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, reason }: { id: string; reason?: string; personalEntryId?: string }) =>
			api.withdrawKnowledgeSubmission(id, reason),
		onSuccess: (_r, { personalEntryId }) => invalidateSubmissionViews(qc, personalEntryId),
	});
}

/**
 * Re-submit after a reviewer requested changes. The new submission is built from the draft's
 * CURRENT content server-side, so unsaved local edits must be saved first.
 */
export function useResubmitKnowledgeSubmission() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			changeNote,
		}: {
			id: string;
			changeNote?: string;
			personalEntryId?: string;
		}) => api.resubmitKnowledgeSubmission(id, changeNote),
		onSuccess: (_r, { personalEntryId }) => invalidateSubmissionViews(qc, personalEntryId),
	});
}

/**
 * The current user's review authority (review tags held + collections they may publish into),
 * for the review-tab explainer. Changes only when an admin edits grants, so it is cached like
 * other ACL reads.
 */
export function useMyKnowledgeReviewScope(enabled = true) {
	return useQuery({
		queryKey: ["knowledge", "myReviewScope"],
		queryFn: api.getMyKnowledgeReviewScope,
		enabled,
		staleTime: STALE,
	});
}
