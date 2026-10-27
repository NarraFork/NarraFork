import type {
	OutlineBacklinksResponse,
	OutlineBlockHistoryResponse,
	OutlineBlockViewResponse,
	OutlinePageListResponse,
	OutlineResolveResponse,
	OutlineRevertResponse,
	OutlineSearchResponse,
	OutlineSpaceDetailResponse,
	OutlineSpaceKind,
	OutlineSpaceListResponse,
	OutlineSpaceResolveResponse,
	OutlineTimelineResponse,
	OutlineViewMode,
	OutlineViewStatePutRequest,
	OutlineViewStateResponse,
} from "@shared/outline-api";
import { request } from "./client";

/** `?a=1&b=2` from the defined values, or "" when there are none. */
function query(params: Record<string, string | number | undefined | null>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

const enc = encodeURIComponent;

export const outlineApi = {
	listOutlineSpaces: (params: {
		kind?: OutlineSpaceKind;
		cursor?: string | null;
		limit?: number;
	}) => request<OutlineSpaceListResponse>(`/outline/spaces${query(params)}`),
	ensurePersonalOutlineSpace: () =>
		request<OutlineSpaceResolveResponse>("/outline/spaces/personal", { method: "POST" }),
	resolveProjectOutlineSpace: (projectId: string) =>
		request<OutlineSpaceResolveResponse>(`/outline/projects/${enc(projectId)}/space`, {
			method: "POST",
		}),
	resolveNarratorOutlineSpace: (narratorId: string) =>
		request<OutlineSpaceResolveResponse>(`/outline/narrators/${enc(narratorId)}/space`, {
			method: "POST",
		}),
	getOutlineSpace: (spaceId: string) =>
		request<OutlineSpaceDetailResponse>(`/outline/spaces/${enc(spaceId)}`),
	listOutlinePages: (spaceId: string, params: { cursor?: string | null; limit?: number }) =>
		request<OutlinePageListResponse>(`/outline/spaces/${enc(spaceId)}/pages${query(params)}`),
	getOutlineBlock: (
		spaceId: string,
		blockId: string,
		params: { asOf?: number; view?: OutlineViewMode; blocks?: number },
	) =>
		request<OutlineBlockViewResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}${query(params)}`,
		),
	getOutlineBlockHistory: (
		spaceId: string,
		blockId: string,
		params: { before?: number | null; limit?: number },
	) =>
		request<OutlineBlockHistoryResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/history${query(params)}`,
		),
	getOutlineBacklinks: (spaceId: string, blockId: string) =>
		request<OutlineBacklinksResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/backlinks`,
		),
	getOutlinePageCommits: (
		spaceId: string,
		pageId: string,
		params: { before?: number | null; limit?: number },
	) =>
		request<OutlineTimelineResponse>(
			`/outline/spaces/${enc(spaceId)}/pages/${enc(pageId)}/commits${query(params)}`,
		),
	searchOutline: (params: { q: string; spaceId?: string; limit?: number }) =>
		request<OutlineSearchResponse>(`/outline/search${query(params)}`),
	/** Where a reference (`ref`, within `space` when bare) or a commit seq of `space` points. */
	resolveOutline: (params: { ref?: string; space?: string; commit?: number }) =>
		request<OutlineResolveResponse>(`/outline/resolve${query(params)}`),
	/** The caller's folding and mind-map direction of a page (defaults when never written). */
	getOutlineViewState: (pageId: string) =>
		request<OutlineViewStateResponse>(`/outline/view-state/${enc(pageId)}`),
	putOutlineViewState: (pageId: string, body: OutlineViewStatePutRequest) =>
		request<OutlineViewStateResponse>(`/outline/view-state/${enc(pageId)}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	revertOutlineCommit: (commitId: string) =>
		request<OutlineRevertResponse>(`/outline/commits/${enc(commitId)}/revert`, {
			method: "POST",
		}),
};
