import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	CreateEntryInput,
	CreateEntryLinkInput,
	KnowledgeFinding,
	KnowledgeLinkDirection,
	KnowledgeVerdict,
	UpdateEntryAclInput,
} from "../lib/api";
import { api } from "../lib/api";

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

/** Rebase a drifted draft onto current main (three-way merge). Conflict → result.ok=false. */
export function useRebaseKnowledgeDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ draftId }: { draftId: string; entryId: string }) =>
			api.rebaseKnowledgeDraft(draftId),
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
		mutationFn: (data: { title: string; content?: string; targetCollectionId?: string }) =>
			api.createPersonalEntry(data),
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
			entryId?: string;
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
