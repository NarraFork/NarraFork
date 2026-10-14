import { request } from "./client";

export interface LegacyMigrationBlocker {
	code: string;
	message: string;
}
export interface LegacyMigrationPreview {
	projectId: string;
	projectName: string;
	syncDisabled: boolean;
	syncDrained?: boolean;
	phase: "none" | "blocked" | "cleanup_pending" | "completed";
	canMigrate: boolean;
	narratorCount: number;
	narratorIds?: string[];
	chapterCount: number;
	blockers: LegacyMigrationBlocker[];
	revision: string;
}
export interface LegacyMigrationResult {
	phase: string;
	narratorIds: string[];
	syncDisabled: true;
	blockers?: LegacyMigrationBlocker[];
}
export const legacyMigrationApi = {
	chapterTarget: (id: string) =>
		request<{ narratorId: string | null; projectId: string }>(
			`/legacy-chapters/${encodeURIComponent(id)}/target`,
		),
	preview: (id: string) =>
		request<LegacyMigrationPreview>(`/projects/${encodeURIComponent(id)}/legacy-migration/preview`),
	disableSync: (id: string) =>
		request<{ syncDisabled: true; drained: boolean }>(
			`/projects/${encodeURIComponent(id)}/legacy-sync/disable`,
			{ method: "POST" },
		),
	migrate: (id: string, revision: string) =>
		request<LegacyMigrationResult>(`/projects/${encodeURIComponent(id)}/legacy-migration`, {
			method: "POST",
			body: JSON.stringify({ revision, confirm: true }),
		}),
};
