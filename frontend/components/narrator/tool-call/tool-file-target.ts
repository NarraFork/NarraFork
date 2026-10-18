import type { FileTarget } from "@shared/file-reference";
import { normalizeFileReferenceContext } from "@shared/file-reference-context";
import { fileTargetFromHref, localFileHref } from "@shared/markdown-file-path";
import type { ExecutionTargetIdentity } from "../../../lib/api/types";

export interface ToolFileExecution {
	executionDeviceId?: string | null;
	executionCwd?: string | null;
	resolvedFilePath?: string | null;
	executionTarget?: ExecutionTargetIdentity | null;
}

/** Only persisted execution facts bind a path. Input/output text is not authority. */
export function toolFileTarget(execution: ToolFileExecution, inputPath: string): FileTarget | null {
	const snapshot = execution.executionTarget;
	const deviceId = snapshot?.deviceId ?? execution.executionDeviceId;
	if (!deviceId) return null;
	const context = normalizeFileReferenceContext({
		deviceId,
		cwd: snapshot?.cwd ?? execution.executionCwd,
	});
	const path =
		snapshot?.lexicalPath ?? snapshot?.resolvedFilePath ?? execution.resolvedFilePath ?? inputPath;
	// Structured hrefs preserve literal Unicode, spaces, percent signs and # characters.
	try {
		return fileTargetFromHref(localFileHref({ deviceId, path }), context);
	} catch {
		// Unsupported UNC/URI/oversized paths remain copyable, never reinterpreted.
		return null;
	}
}

/** A different retry/COW row must not lend execution identity to this block. */
export function toolExecutionFallback(
	block: { tcId?: unknown; executionAttempt?: unknown; status?: unknown },
	call: (ToolFileExecution & { id?: unknown; executionAttempt?: unknown }) | undefined,
): ToolFileExecution | undefined {
	if (
		!call ||
		// An enriched historical block without either identity cannot borrow a row.
		(block.status !== undefined && block.tcId == null && block.executionAttempt == null) ||
		(block.tcId != null && block.tcId !== call.id) ||
		(block.executionAttempt != null && block.executionAttempt !== call.executionAttempt)
	)
		return undefined;
	return call;
}
