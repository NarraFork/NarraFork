import { request } from "./client";

export type MemoryScope = { kind: "user" } | { kind: "project" | "session"; id: string };
export type MemoryStatus = "candidate" | "confirmed" | "rejected" | "archived";
export type MemoryDecision = "confirm" | "reject" | "archive";
export interface MemorySummary {
	id: string;
	key: string;
	scope: MemoryScope["kind"];
	version: number;
	status: MemoryStatus;
	effectiveStatus: MemoryStatus | "expired";
	expiresAt: string | null;
	updatedAt: string;
	createdByKind: "user" | "agent";
	sourceNarratorId: string | null;
	sourceMessageId: string | null;
	excerpt: string;
}
export interface MemoryDetail extends Omit<MemorySummary, "excerpt"> {
	content: string;
	contentHash: string;
	ownerUserId: string;
	projectId: string | null;
	narratorId: string | null;
	confirmedAt: string | null;
	createdAt: string;
}
export interface MemoryEvent {
	id: string;
	version: number;
	action: "propose" | "revise" | MemoryDecision;
	actorUserId: string;
	actorKind: "user" | "agent";
	contentHash: string;
	createdAt: string;
}
export interface MemoryDraft {
	content: string;
	expiresAt: string | null;
}
export interface MemoryProposal extends MemoryDraft {
	scope: MemoryScope;
	key: string;
	source?: { narratorId: string; messageId?: string };
}
const path = (id: string) => `/context-memory/${encodeURIComponent(id)}`;
function memoryRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
	const deadline = AbortSignal.timeout(30000);
	return request<T>(url, {
		...options,
		signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
		maxResponseBytes: 256 * 1024,
	});
}
export const contextMemoryApi = {
	listContextMemories: (scope: MemoryScope, cursor?: string, signal?: AbortSignal) => {
		const query = new URLSearchParams({ scope: scope.kind });
		if (scope.kind !== "user") query.set("scopeId", scope.id);
		query.set("limit", "20");
		if (cursor) query.set("cursor", cursor);
		return memoryRequest<{ items: MemorySummary[]; nextCursor: string | null }>(
			`/context-memory?${query}`,
			{ signal },
		);
	},
	getContextMemory: (id: string, signal?: AbortSignal) =>
		memoryRequest<MemoryDetail>(path(id), { signal }),
	getContextMemoryEvents: (id: string, signal?: AbortSignal) =>
		memoryRequest<MemoryEvent[]>(`${path(id)}/events`, { signal }),
	proposeContextMemory: (data: MemoryProposal) =>
		memoryRequest<MemoryDetail>("/context-memory", { method: "POST", body: JSON.stringify(data) }),
	reviseContextMemory: (id: string, data: MemoryDraft & { expectedVersion: number }) =>
		memoryRequest<MemoryDetail>(path(id), { method: "PATCH", body: JSON.stringify(data) }),
	decideContextMemory: (id: string, data: { expectedVersion: number; action: MemoryDecision }) =>
		memoryRequest<MemoryDetail>(`${path(id)}/decision`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	forgetContextMemory: (id: string, expectedVersion: number) =>
		memoryRequest<{ deleted: true }>(path(id), {
			method: "DELETE",
			body: JSON.stringify({ expectedVersion }),
		}),
};
