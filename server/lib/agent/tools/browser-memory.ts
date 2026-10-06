import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	heapSnapshot,
	type MemoryMetrics,
	type MemoryOptions,
	memoryMetrics,
} from "../../browser/memory";
import { MAX_HEAP_SNAPSHOT_BYTES, MEMORY_CLEANUP_TIMEOUT_MS } from "../../browser/memory-constants";
import { waitForMemory } from "../../browser/memory-job";
import type { BrowserSession } from "../../browser/session";
import { generateShortId } from "../../id";
import { createShare, getMaxShareSizeBytes, getShareDir } from "../../shares";
import type { ToolResult } from "../types";

export const HEAP_SNAPSHOT_PRIVACY_NOTICE =
	"Sensitive: heap snapshots may contain tokens and page text; contents are NOT redacted. " +
	"Anyone holding this share link can download the file until it expires in 24h.";

export function formatMemoryMetrics(result: MemoryMetrics): string {
	const bytes = (value: number | null) =>
		value === null ? "unavailable" : `${value} bytes (${(value / 1024 / 1024).toFixed(2)} MB)`;
	return [
		`Timestamp: ${result.timestamp}`,
		`URL: ${result.url}`,
		`JSHeapUsedSize: ${bytes(result.JSHeapUsedSize)}`,
		`JSHeapTotalSize: ${bytes(result.JSHeapTotalSize)}`,
		...(["Documents", "Frames", "Nodes", "JSEventListeners"] as const).map(
			(name) => `${name}: ${result[name] ?? "unavailable"}`,
		),
		`Forced GC: ${result.collectGarbage}`,
		`Duration: ${result.durationMs}ms`,
		"Scope: current page target, not browser RSS/GPU/all workers. Growth alone does not prove a leak.",
	].join("\n");
}

const memoryDependencies = {
	memoryMetrics,
	heapSnapshot,
	createShare,
	getMaxShareSizeBytes,
	getShareDir,
};

export async function handleBrowserMemory(
	session: BrowserSession,
	action: "memory_metrics" | "heap_snapshot",
	opts: MemoryOptions,
	deps = memoryDependencies,
): Promise<ToolResult> {
	if (action === "memory_metrics") {
		const result = await deps.memoryMetrics(session, opts);
		return {
			output: formatMemoryMetrics(result),
			metadata: { sessionId: session.id, memoryMetrics: result },
		};
	}

	const shareId = generateShortId();
	const shareUrl = `/api/shares/${shareId}`;
	const dir = deps.getShareDir(shareId);
	const filename = `heap-${session.id}-${Date.now()}.heapsnapshot`;
	const filePath = resolve(dir, filename);
	try {
		const result = await deps.heapSnapshot(
			session,
			filePath,
			Math.min(MAX_HEAP_SNAPSHOT_BYTES, deps.getMaxShareSizeBytes()),
			opts,
		);
		opts.signal?.throwIfAborted();
		if (session.memoryDiagnosticsClosed) throw new Error("Browser session closed during snapshot");
		deps.createShare({
			id: shareId,
			originalName: filename,
			storagePath: filePath,
			size: result.fileSize,
			createdBy: "browser",
			expiryHours: 24,
		});
		return {
			output: [
				"Heap snapshot exported. Open it in Chrome DevTools Memory for object/retainer analysis.",
				`Timestamp: ${result.timestamp}`,
				`URL: ${result.url}`,
				`Snapshot file: ${filePath}`,
				`Size: ${result.fileSize} bytes`,
				`Duration: ${result.durationMs}ms`,
				`Forced GC: ${opts.collectGarbage ?? false}`,
				`Share URL: ${shareUrl}`,
				HEAP_SNAPSHOT_PRIVACY_NOTICE,
			].join("\n"),
			metadata: {
				sessionId: session.id,
				snapshotPath: filePath,
				shareId,
				shareUrl,
				...result,
				collectGarbage: opts.collectGarbage ?? false,
			},
		};
	} catch (error) {
		// Includes share registration failure: do not leave an unregistered sensitive artifact.
		await waitForMemory(
			rm(dir, { recursive: true, force: true }),
			AbortSignal.timeout(MEMORY_CLEANUP_TIMEOUT_MS),
		).catch(() => {});
		throw error;
	}
}
