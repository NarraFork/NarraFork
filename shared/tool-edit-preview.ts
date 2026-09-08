/** Exact historical text only. Unknown bytes must never be represented as an empty file. */
export type ToolEditPreviewUnavailableReason =
	| "missing_evidence"
	| "binary"
	| "too_large"
	| "unsupported"
	| "invalid_encoding"
	| "unreadable"
	| "identity_unverified"
	| "ambiguous"
	| "cancelled"
	| "timeout";

export type ToolEditPreviewSide =
	| { status: "available"; content: string }
	| { status: "absent"; content: "" }
	| { status: "unavailable"; reason: ToolEditPreviewUnavailableReason };

export interface ToolEditPreview {
	toolCallId: string;
	toolUseId: string;
	/** null means the historical execution target was not recorded reliably. */
	filePath: string | null;
	deviceId: string | null;
	before: ToolEditPreviewSide;
	after: ToolEditPreviewSide;
	/** One-based inclusive old/new edit ranges, when recorded by the actual tool. */
	location?: { startLine: number; endLine: number; newEndLine: number };
	source: "evidence" | "tree" | "unavailable";
}
