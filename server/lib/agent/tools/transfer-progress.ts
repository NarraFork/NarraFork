/**
 * transfer-progress.ts — pure formatters and payload builders for the
 * TransferFile tool's live progress and its completion summary.
 *
 * Split out of transfer-file.ts so the wording and the arithmetic can be unit
 * tested without a device.
 *
 * TWO CHANNELS, one source of truth
 * --------------------------------
 * A running transfer reports over both:
 *
 *   - `emitStructuredProgress` — the measurement (`ToolProgressPayload`). The UI
 *     renders it as a real progress bar. This is the primary channel.
 *   - `emitOutput` — a text form. It is what the MODEL reads, what a surface with
 *     no progress support falls back to, and what a user copies out of a card.
 *
 * The text form therefore carries no ASCII bar. A `[███░░░]` in text would be a
 * second, worse rendering of the same fact: it cannot animate, and any client
 * wanting the number back would have to parse the producer's own formatting.
 * The text says the figures; the bar draws them.
 */

import {
	formatProgressBytes,
	formatProgressDuration,
	type ToolProgressPayload,
} from "@shared/tool-progress";

/**
 * Exported under the names this module's callers already use.
 *
 * The implementations live beside the payload in `@shared/tool-progress` so the
 * runner, the detail classifier and the task drawer render the same figure from the
 * same code — see the note there on why four copies existed.
 */
export const formatTransferBytes = formatProgressBytes;
export const formatTransferDuration = formatProgressDuration;

export interface TransferProgressView {
	direction: "download" | "upload";
	/** Display name of the remote device (not its id — ids are unreadable). */
	deviceName: string;
	bytesTransferred: number;
	/**
	 * Total bytes for the whole transfer, or 0 when unknown.
	 *
	 * Zero is a real case, not a defect to paper over: an upload of an empty file
	 * and a directory whose manifest totalled nothing both land here. Percentage
	 * and bar are suppressed rather than shown as a division artefact.
	 */
	totalBytes: number;
	filesDone: number;
	totalFiles: number;
	/** Relative path of the file currently moving (directory transfers). */
	currentFile?: string;
	/** Milliseconds since the transfer started, for rate and ETA. */
	elapsedMs: number;
	/** The endpoint path on the far side, shown as the destination line. */
	remotePath: string;
	localPath: string;
}

/**
 * The measurement payload for a running transfer — the primary channel, rendered
 * as an actual progress bar.
 *
 * Bytes are the unit; `total` is omitted (not zeroed) when unknown, so the client
 * knows to draw an indeterminate bar rather than 0%.
 */
export function buildTransferProgressPayload(view: TransferProgressView): ToolProgressPayload {
	return {
		completed: view.bytesTransferred,
		...(view.totalBytes > 0 ? { total: view.totalBytes } : {}),
		...(view.totalFiles > 1 ? { itemsDone: view.filesDone, itemsTotal: view.totalFiles } : {}),
		...(view.currentFile ? { currentItem: view.currentFile } : {}),
		elapsedMs: view.elapsedMs,
		phase: view.direction,
	};
}

/**
 * The FIGURES a progress bar shows beneath itself, already formatted.
 *
 * Formatted here rather than client-side because the unit choice (KB vs MB vs GB)
 * belongs to whoever knows what is being measured, and the classifier layer these
 * strings travel to has no i18n access by design.
 *
 * Each entry is present or absent for the whole run, never appearing mid-transfer:
 * the figures line is one reserved row in the height model, and a set that grows
 * partway through would resize the card under the reader.
 */
export function transferProgressFigures(view: TransferProgressView): string[] {
	const hasTotal = view.totalBytes > 0;
	const seconds = view.elapsedMs / 1000;
	const rate = seconds > 0 ? view.bytesTransferred / seconds : 0;

	const out = [
		hasTotal
			? `${formatTransferBytes(view.bytesTransferred)} / ${formatTransferBytes(view.totalBytes)}`
			: formatTransferBytes(view.bytesTransferred),
	];
	// Rate and ETA are omitted rather than zeroed before they are observable: a
	// "0 B/s · ETA 0s" reads as a measurement of a stalled transfer.
	if (rate > 0) out.push(`${formatTransferBytes(rate)}/s`);
	if (hasTotal && rate > 0) {
		const remaining = Math.max(0, view.totalBytes - view.bytesTransferred);
		out.push(`ETA ${formatTransferDuration(remaining / rate)}`);
	}
	if (view.totalFiles > 1) {
		const file = view.currentFile ? ` ${view.currentFile}` : "";
		out.push(`file ${Math.min(view.filesDone + 1, view.totalFiles)}/${view.totalFiles}${file}`);
	}
	return out;
}

/**
 * The TEXT form of live progress — what the model reads and what a surface with
 * no progress-bar support falls back to.
 *
 * No ASCII bar: see the module header. The percentage is stated in words instead,
 * which is the part a reader (or a model deciding whether to keep waiting)
 * actually needs.
 */
export function formatTransferProgress(view: TransferProgressView): string {
	const arrow = view.direction === "upload" ? "→" : "←";
	const hasTotal = view.totalBytes > 0;
	const percent = hasTotal
		? `${Math.min(100, Math.round((view.bytesTransferred / view.totalBytes) * 100))}%`
		: "in progress";
	const route =
		view.direction === "upload"
			? `${view.localPath} ${arrow} ${view.remotePath}`
			: `${view.remotePath} ${arrow} ${view.localPath}`;
	return [
		`${view.direction} ${arrow} ${view.deviceName} — ${percent}`,
		transferProgressFigures(view).join(" · "),
		route,
	].join("\n");
}

export interface TransferSummaryView {
	direction: "download" | "upload";
	deviceName: string;
	bytesTransferred: number;
	filesTransferred: number;
	elapsedMs: number;
	remotePath: string;
	localPath: string;
}

/** The model-facing completion line (also the card's persisted output). */
export function formatTransferSummary(view: TransferSummaryView): string {
	const seconds = view.elapsedMs / 1000;
	const rate = seconds > 0 ? view.bytesTransferred / seconds : 0;
	const verb = view.direction === "download" ? "Downloaded" : "Uploaded";
	const what =
		view.filesTransferred === 1
			? formatTransferBytes(view.bytesTransferred)
			: `${view.filesTransferred} files (${formatTransferBytes(view.bytesTransferred)})`;
	const route =
		view.direction === "upload"
			? `${view.localPath} → ${view.deviceName}:${view.remotePath}`
			: `${view.deviceName}:${view.remotePath} → ${view.localPath}`;
	const rateText = rate > 0 ? `, ${formatTransferBytes(rate)}/s` : "";
	return `${verb} ${what} — ${route} in ${formatTransferDuration(seconds)}${rateText}.`;
}
