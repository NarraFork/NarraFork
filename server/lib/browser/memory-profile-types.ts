import type { AllocationSummary } from "./allocation-summary";
import type { GcSummary } from "./gc-trace-summary";

export const MEMORY_PROFILE_TRACE_CATEGORIES = [
	"devtools.timeline",
	"v8",
	"disabled-by-default-v8.gc",
	"blink.user_timing",
] as const;
export interface MemoryProfileFailureDiagnostic {
	diagnosticStage: "trace_capability";
	browserVersion: string;
	missingCategories: (typeof MEMORY_PROFILE_TRACE_CATEGORIES)[number][];
}

/** Protocol product only: never carry arbitrary browser/worker text into a diagnostic. */
export function profileDiagnosticBrowserVersion(value: unknown): string {
	return typeof value === "string" &&
		/^(?:Chrome|HeadlessChrome|Chromium)\/\d{1,4}(?:\.\d{1,6}){1,3}$/.test(value)
		? value
		: "unavailable";
}

export type MemoryProfileMode = "allocation" | "gc" | "both";
export type MemoryProfileState =
	| "idle"
	| "starting"
	| "recording"
	| "finalizing"
	| "completed"
	| "failed"
	| "cancelled";
export interface MemoryProfileConfig {
	mode: MemoryProfileMode;
	durationMs: number;
	samplingIntervalBytes: number;
}
export interface MemoryProfileRequest {
	profileId: string;
	wsEndpoint: string;
	targetId: string;
	dir: string;
	maxArtifactsBytes: number;
	config: MemoryProfileConfig;
}
export interface HeapTrendPoint {
	elapsedMs: number;
	usedBytes: number | null;
	totalBytes: number | null;
}
export interface MemoryProfileSummary {
	status: "complete" | "partial";
	browserVersion: string;
	mode: MemoryProfileMode;
	requestedConfig?: MemoryProfileConfig & {
		stackDepth: number;
		includeObjectsCollectedByMinorGC: boolean;
		includeObjectsCollectedByMajorGC: boolean;
	};
	startedAt: string;
	endedAt: string;
	durationMs: number;
	stopReason: "manual" | "duration_limit" | "buffer_limit";
	allocation?: AllocationSummary;
	gc?: GcSummary;
	heapTrend: HeapTrendPoint[];
	warnings: string[];
}
export interface MemoryProfileArtifact {
	kind: "allocation" | "gc" | "summary";
	filename: "allocation.heapprofile" | "gc.trace.json" | "summary.json";
	size: number;
}
export type MemoryProfileWorkerReply =
	| { kind: "ready" }
	| {
			kind: "recording";
			profileId: string;
			startedAt: string;
			browserVersion: string;
			warnings: string[];
	  }
	| {
			kind: "progress";
			profileId: string;
			elapsedMs: number;
			heapPoints: number;
			traceUsage: number;
	  }
	| { kind: "finalizing"; profileId: string; stopReason: MemoryProfileSummary["stopReason"] }
	| {
			kind: "result";
			profileId: string;
			summary: MemoryProfileSummary;
			artifacts: MemoryProfileArtifact[];
			traceStopped: boolean;
	  }
	| {
			kind: "failed" | "cancelled";
			profileId: string;
			stage: string;
			traceStopped: boolean;
			diagnostic?: MemoryProfileFailureDiagnostic;
	  };
export type MemoryProfileWorkerCommand =
	| { kind: "start"; request: MemoryProfileRequest }
	| { kind: "stop" | "cancel"; profileId: string };
export interface MemoryProfileView {
	profileId?: string;
	state: MemoryProfileState;
	config?: MemoryProfileConfig;
	startedAt?: string;
	deadline?: string;
	elapsedMs?: number;
	browserVersion?: string;
	stage?: string;
	diagnostic?: MemoryProfileFailureDiagnostic;
	warnings?: string[];
	summary?: MemoryProfileSummary;
	artifacts?: Array<MemoryProfileArtifact & { shareId: string; shareUrl: string; path: string }>;
}
