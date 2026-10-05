/** Private, actor-owned SQLite artifacts; never public shares or client host paths. */
export type NarratorBackupProfile = "conversation-state-v1" | "conversation-tree-v1";
export interface NarratorBackupRequest {
	narratorIds: string[];
	profile: NarratorBackupProfile;
}
export interface NarratorBackupPlan {
	profile: NarratorBackupProfile;
	narratorIds: string[];
	productionDiskRestoreAllowed: false;
	exclusions: string[];
}
export type NarratorBackupJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface NarratorBackupJob {
	jobId: string;
	status: NarratorBackupJobStatus;
	artifactId?: string;
	error?: string;
}
export interface NarratorBackupArtifact {
	artifactId: string;
	verifiedSameInstance: boolean;
}
export interface NarratorRestoreMapping {
	users?: Record<string, string>;
	devices?: Record<string, string>;
	paths?: Record<string, string>;
	projects?: Record<string, string>;
}
export interface NarratorRestoreRequest {
	artifactId: string;
	mapping?: NarratorRestoreMapping;
}
export interface NarratorRestorePreview {
	artifactId: string;
	profile: NarratorBackupProfile;
	narratorIds: string[];
	verifiedSameInstance: boolean;
	sameInstanceStateRestoreAllowed: boolean;
	crossInstanceApplySupported: false;
	productionDiskRestoreAllowed: false;
	blockers: string[];
	exclusions: string[];
	manualActivationRequired: true;
}
export interface NarratorRestoreResult {
	narratorIds: string[];
	status: "archived";
	manualActivationRequired: true;
	productionDiskRestoreAllowed: false;
}
export const NARRATOR_BACKUP_LIMITS = Object.freeze({
	pageRows: 500,
	rowBytes: 4 * 1024 * 1024,
	stateBytes: 64 * 1024 * 1024,
	stateRows: 100_000,
	manifestBytes: 1024 * 1024,
	objectBytes: 64 * 1024 * 1024,
	totalObjectBytes: 1024 * 1024 * 1024,
	objects: 100_000,
	jobMs: 10 * 60_000,
	childMs: 60_000,
	jobs: 32,
	artifacts: 32,
});
