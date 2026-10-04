import {
	NARRATOR_BACKUP_LIMITS,
	type NarratorBackupArtifact,
	type NarratorBackupJob,
	type NarratorBackupPlan,
	type NarratorBackupRequest,
	type NarratorRestorePreview,
	type NarratorRestoreRequest,
	type NarratorRestoreResult,
} from "@shared/narrator-backup";
import { saveBlobAsFile } from "../file-download";
import { apiBase, authorizedFetch, request } from "./client";

const ROOT = "/narrator-backups";
const MAX_DOWNLOAD_BYTES =
	NARRATOR_BACKUP_LIMITS.totalObjectBytes + NARRATOR_BACKUP_LIMITS.stateBytes * 2;
export const BACKUP_BUFFER_DOWNLOAD_BYTES = NARRATOR_BACKUP_LIMITS.stateBytes;

interface BackupFileWriter {
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}
type BackupSavePicker = (options: {
	suggestedName: string;
}) => Promise<{ createWritable(): Promise<BackupFileWriter> }>;

/** Auth stays in a header. Large artifacts stream to disk; fallback buffering is hard bounded. */
export async function downloadNarratorBackup(
	artifactId: string,
	signal?: AbortSignal,
): Promise<void> {
	const filename = `narrator-backup-${artifactId}.sqlite`;
	const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: BackupSavePicker })
		.showSaveFilePicker;
	const handle = picker ? await picker({ suggestedName: filename }) : undefined;
	const response = await authorizedFetch(
		`${apiBase()}${ROOT}/artifacts/${encodeURIComponent(artifactId)}/download`,
		{
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(NARRATOR_BACKUP_LIMITS.jobMs)])
				: AbortSignal.timeout(NARRATOR_BACKUP_LIMITS.jobMs),
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Backup download rejected (${response.status})`);
	}
	if (!response.body) throw new Error("Backup download has no body");
	const maxBytes = handle ? MAX_DOWNLOAD_BYTES : BACKUP_BUFFER_DOWNLOAD_BYTES;
	const length = Number(response.headers.get("content-length"));
	if (length > maxBytes) {
		await response.body.cancel();
		throw new Error(
			"Backup exceeds bounded browser download; use a browser with streaming save support",
		);
	}
	const reader = response.body.getReader();
	let writer: BackupFileWriter | undefined;
	let bytes = 0;
	const chunks: ArrayBuffer[] = [];
	try {
		writer = await handle?.createWritable();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new Error("Backup byte budget exceeded; download cancelled");
			if (writer) await writer.write(chunk.value);
			else chunks.push(new Uint8Array(chunk.value).buffer);
		}
		if (writer) await writer.close();
		else saveBlobAsFile(new Blob(chunks, { type: "application/octet-stream" }), filename);
	} catch (error) {
		await reader.cancel().catch(() => {});
		await writer?.abort().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

export const narratorBackupsApi = {
	plan: (body: NarratorBackupRequest) =>
		request<NarratorBackupPlan>(`${ROOT}/plan`, { method: "POST", body: JSON.stringify(body) }),
	export: (body: NarratorBackupRequest) =>
		request<NarratorBackupJob>(`${ROOT}/exports`, { method: "POST", body: JSON.stringify(body) }),
	job: (jobId: string) => request<NarratorBackupJob>(`${ROOT}/jobs/${encodeURIComponent(jobId)}`),
	cancel: (jobId: string) =>
		request<NarratorBackupJob>(`${ROOT}/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
	upload: async (file: File): Promise<NarratorBackupArtifact> => {
		if (file.size > MAX_DOWNLOAD_BYTES)
			throw new Error("Backup upload exceeds artifact byte budget");
		const response = await authorizedFetch(`${apiBase()}${ROOT}/artifacts`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: file,
			signal: AbortSignal.timeout(NARRATOR_BACKUP_LIMITS.jobMs),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Backup upload rejected (${response.status})`);
		}
		return response.json();
	},
	preview: (body: NarratorRestoreRequest) =>
		request<NarratorRestorePreview>(`${ROOT}/preview`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	restore: (body: NarratorRestoreRequest) =>
		request<NarratorRestoreResult>(`${ROOT}/restore`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	download: downloadNarratorBackup,
};
