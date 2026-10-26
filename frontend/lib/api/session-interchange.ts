/**
 * Client for importing and exporting Claude Code / Codex sessions.
 *
 * Mirrors `server/routes/session-interchange.ts` (scan, import) and the two
 * `session-export*` narrator routes.
 */

import {
	ApiError,
	apiBase,
	authorizedFetch,
	getToken,
	postFormDataWithProgress,
	readFetchError,
	request,
} from "./client";
import { parseContentDispositionFileName } from "./narrators";

export type SessionFormat = "claude-code" | "codex";

export type SessionLocation =
	| { target: "local"; root?: string }
	| { target: "device"; deviceId: string; root?: string };

export interface SessionWarning {
	kind: string;
	count: number;
	sample?: string;
}

export interface SessionCandidate {
	format: SessionFormat;
	path: string;
	sessionId: string;
	size: number;
	mtime: string;
	title?: string;
	cwd?: string;
	subagentCount?: number;
	archived?: boolean;
}

export interface SessionCandidatePage {
	root: string;
	candidates: SessionCandidate[];
	nextCursor: string | null;
	truncated: boolean;
}

export interface SessionImportOverrides {
	cwd?: string;
	model?: string;
	title?: string;
}

export interface SessionImportResult {
	narratorId: string;
	subagentIds: string[];
	messageCount: number;
	warnings: SessionWarning[];
}

export interface SessionExportOptions {
	format: SessionFormat;
	cwd?: string;
	codexModelProvider?: string;
	dropAllReasoning?: boolean;
}

export interface SessionExportWriteResult {
	format: SessionFormat;
	sessionId: string;
	cwd: string;
	title?: string;
	root: string;
	paths: string[];
	cwdExists: boolean;
	resumeCommand: string;
	warnings: SessionWarning[];
}

export interface SessionExportDownload {
	blob: Blob;
	fileName: string | null;
	sessionId: string | null;
	resumeCommand: string | null;
	warnings: SessionWarning[];
	/**
	 * Single-file download only: the file's path under the CLI's config dir, which a
	 * browser download drops. Null for a zip, whose entries carry their own layout.
	 */
	placement: string | null;
}

function exportQuery(options: SessionExportOptions): string {
	const params = new URLSearchParams({ format: options.format });
	if (options.cwd) params.set("cwd", options.cwd);
	if (options.codexModelProvider) params.set("codexModelProvider", options.codexModelProvider);
	if (options.dropAllReasoning) params.set("dropAllReasoning", "true");
	return params.toString();
}

function decodeHeader(value: string | null): string | null {
	if (!value) return null;
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function parseWarnings(value: string | null): SessionWarning[] {
	const decoded = decodeHeader(value);
	if (!decoded) return [];
	try {
		const parsed = JSON.parse(decoded);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export const sessionInterchangeApi = {
	scanSessions: (
		input: { format: SessionFormat; location: SessionLocation; cursor?: string; limit?: number },
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams({ format: input.format, target: input.location.target });
		if (input.location.target === "device") params.set("deviceId", input.location.deviceId);
		if (input.location.root) params.set("root", input.location.root);
		if (input.cursor) params.set("cursor", input.cursor);
		if (input.limit) params.set("limit", String(input.limit));
		return request<SessionCandidatePage>(`/session-interchange/scan?${params}`, { signal });
	},

	importSessionFromPath: (
		input: {
			format: SessionFormat;
			location: SessionLocation;
			path: string;
		} & SessionImportOverrides,
	) =>
		request<SessionImportResult>("/session-interchange/import/path", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	/** Main transcript plus any subagent files; the server works out which is which. */
	importSessionUpload: async (
		files: File[],
		input: { format: SessionFormat | "auto" } & SessionImportOverrides,
		opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
	): Promise<SessionImportResult> => {
		const form = new FormData();
		for (const file of files) form.append("files", file);
		form.append("format", input.format);
		if (input.cwd) form.append("cwd", input.cwd);
		if (input.model) form.append("model", input.model);
		if (input.title) form.append("title", input.title);
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await postFormDataWithProgress(
			`${apiBase()}/session-interchange/import/upload`,
			form,
			{
				headers,
				onProgress: opts.onProgress,
				signal: opts.signal,
			},
		);
		if (!res.ok) {
			const error = await readFetchError(res, "Import failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return (await res.json()) as SessionImportResult;
	},

	downloadSessionExport: async (
		narratorId: string,
		options: SessionExportOptions,
	): Promise<SessionExportDownload> => {
		const res = await authorizedFetch(
			`${apiBase()}/narrators/${encodeURIComponent(narratorId)}/session-export?${exportQuery(options)}`,
		);
		if (!res.ok) {
			const error = await readFetchError(res, "Export failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
			sessionId: res.headers.get("x-session-id"),
			resumeCommand: decodeHeader(res.headers.get("x-resume-command")),
			warnings: parseWarnings(res.headers.get("x-session-warnings")),
			placement: decodeHeader(res.headers.get("x-session-path")),
		};
	},

	writeSessionExport: (
		narratorId: string,
		input: SessionExportOptions & { location: SessionLocation },
	) =>
		request<SessionExportWriteResult>(
			`/narrators/${encodeURIComponent(narratorId)}/session-export-to`,
			{ method: "POST", body: JSON.stringify(input) },
		),
};
