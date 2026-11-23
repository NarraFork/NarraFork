import { createHash } from "node:crypto";
import type { GitLineStats } from "../../shared/git-line-stats";
import type {
	GitStatusPage,
	GitStatusPageCacheState,
	GitStatusPageErrorCode,
	GitStatusPageLimitReason,
	GitStatusPageQuery,
	GitStatusPageResult,
	GitStatusPageScopeProof,
	GitStatusPageStatsQuery,
	GitStatusPageStatsResponse,
	GitStatusPageStatsResult,
	GitStatusPageValidation,
} from "../../shared/git-status-page";

import { normalizePathForOS } from "../lib/platform-path";

export const GIT_STATUS_PAGE_RAW_MAX_CHARS = 1024 * 1024 + 1;
export const GIT_STATUS_PAGE_CONCURRENCY = 2;
export const GIT_STATUS_PAGE_QUEUE = 16;

/** Canonical local keys overlap by path component; remote generation keys match exactly. */
export function gitStatusPageScopesOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		const left: unknown = JSON.parse(a);
		const right: unknown = JSON.parse(b);
		if (
			!Array.isArray(left) ||
			!Array.isArray(right) ||
			left[0] !== "local" ||
			right[0] !== "local" ||
			typeof left[1] !== "string" ||
			typeof right[1] !== "string"
		)
			return false;
		const x = normalizePathForOS(left[1], process.platform);
		const y = normalizePathForOS(right[1], process.platform);
		return (
			x === y ||
			x.startsWith(y.endsWith("/") ? y : `${y}/`) ||
			y.startsWith(x.endsWith("/") ? x : `${x}/`)
		);
	} catch {
		return false;
	}
}

export interface GitStatusPageScope {
	actorId: string;
	workspaceKey: string;
	/** Canonical workspace identity, including device connection generation for remote roots. */
	queryKey: string;
}

export interface GitStatusPageRawResult {
	stdout: string;
	/** Missing completeness metadata is deliberately treated as incomplete. */
	complete?: boolean;
	limitReason?: GitStatusPageLimitReason;
}

export type GitStatusPageSourceDescriptor =
	| { kind: "local"; cwd: string }
	| { kind: "remote"; identity: string };

export type GitStatusPageSource =
	| { kind: "local"; cwd: string }
	| {
			kind: "remote";
			identity: string;
			read: (signal: AbortSignal) => Promise<GitStatusPageRawResult>;
	  };

export function gitStatusPageSourceIdentity(source: GitStatusPageSourceDescriptor): string {
	const descriptor =
		source.kind === "local"
			? { kind: source.kind, cwd: source.cwd }
			: { kind: source.kind, identity: source.identity };
	return createHash("sha256").update(JSON.stringify(descriptor)).digest("base64url");
}

export interface GitStatusPageRequest {
	scope: GitStatusPageScope;
	query: GitStatusPageQuery;
	source: GitStatusPageSourceDescriptor;
	operation?:
		| "validate"
		| "assert"
		| "stats"
		| "observe"
		| "cache-state"
		| "read-on-demand"
		| "stats-on-demand";
	statsQuery?: GitStatusPageStatsQuery;
	proof?: GitStatusPageScopeProof;
	files?: string[];
}

export class GitStatusPageError extends Error {
	readonly status: number;
	constructor(
		readonly code: GitStatusPageErrorCode,
		message: string = code,
	) {
		super(message);
		this.name = "GitStatusPageError";
		this.status =
			code === "GIT_STATUS_PAGE_BUSY"
				? 429
				: code === "GIT_STATUS_PAGE_EXPIRED"
					? 409
					: code === "GIT_STATUS_PAGE_CANCELLED"
						? 499
						: code === "GIT_STATUS_PAGE_RECORD_TOO_LARGE"
							? 413
							: code === "GIT_STATUS_PAGE_CLOSED" || code === "GIT_STATUS_PAGE_SOURCE_FAILED"
								? 503
								: 400;
	}
}

export type GitStatusPageWorkerInput =
	| { action: "ping" }
	| { action: "read"; id: number; request: GitStatusPageRequest }
	| { action: "cancel"; id: number }
	| { action: "remote"; id: number; result?: GitStatusPageRawResult; error?: string }
	| { action: "stats"; id: number; result?: GitLineStats; error?: string }
	| { action: "invalidate-stats"; queryKey: string }
	| { action: "invalidate"; queryKey: string }
	| { action: "retain"; queryKey: string; sourceIdentity?: string }
	| { action: "release"; queryKey: string; sourceIdentity?: string }
	| { action: "close" };

export type GitStatusPageWorkerValue =
	| GitStatusPage
	| GitStatusPageStatsResult
	| GitStatusPageResult
	| GitStatusPageStatsResponse
	| GitStatusPageCacheState
	| GitStatusPageValidation
	| true;

export type GitStatusPageWorkerOutput =
	| { ready: true }
	| { action: "remote"; id: number }
	| { action: "stats"; id: number; readId: number }
	| { action: "stats-cancel"; readId: number }
	| { action: "cache-published"; id: number; cache: GitStatusPageCacheState }
	| { action: "result"; id: number; value: GitStatusPageWorkerValue }
	| { action: "error"; id: number; code: GitStatusPageErrorCode; message: string }
	| { action: "closed" };
