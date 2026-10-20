import type { PublicationEvent, PublicationRun } from "./publication-outbox";

export function publicationDedupeKey(
	run: PublicationRun,
	eventKind: PublicationEvent | "terminal",
) {
	return JSON.stringify([
		"publication",
		run.producerKind,
		run.taskId,
		run.logicalRunId,
		eventKind,
		run.recipientId,
	]);
}

/** Bounded, dialect-neutral parsing for Await's per-run result projection. */
export type AgentTerminalEvent = "completed" | "failed" | "timed_out" | "cancelled";
export interface AgentTerminalResult {
	output: string;
	/** Exact source used for this output, captured by the reader before any later run can start. */
	sourceResultRef?: string;
	/** Requested only by recovery; ordinary Await's output shape is unchanged. */
	eventKind?: AgentTerminalEvent;
}
export interface AwaitedTerminalConsumeOptions {
	sourceResultRef?: string;
}

export function agentSourceResultRef(value: unknown): string | undefined {
	return typeof value === "string" &&
		value.startsWith("message:") &&
		value.length > 8 &&
		Buffer.byteLength(value) <= 512
		? value
		: undefined;
}
export interface AgentTerminalResultReadOptions {
	/** Trusted observation of this exact run settling, not merely an initially idle actor. */
	settledRunId?: string;
	includeEventKind?: boolean;
}
export const AGENT_RESULT_JSON_MAX_BYTES = 128 * 1024;
export const AGENT_RESULT_OUTPUT_CHARS = 12_000;
export const AGENT_RESULT_TRUNCATION_MARKER =
	"\n\n[Output truncated. Open the agent session to view the full result.]";

function boundedOutput(text: string, truncated = false): string {
	if (!truncated && text.length <= AGENT_RESULT_OUTPUT_CHARS) return text;
	return (
		text.slice(0, AGENT_RESULT_OUTPUT_CHARS - AGENT_RESULT_TRUNCATION_MARKER.length) +
		AGENT_RESULT_TRUNCATION_MARKER
	);
}

export function parseRunSourceBoundary(resultRef: string | null | undefined): number | null {
	const match = /^source_after:(-?\d+)$/.exec(resultRef ?? "");
	if (!match) return null;
	const boundary = Number(match[1]);
	return Number.isSafeInteger(boundary) ? boundary : null;
}

function blocks(raw: string | null): Record<string, unknown>[] | null {
	if (raw === null || Buffer.byteLength(raw) > AGENT_RESULT_JSON_MAX_BYTES) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object")
			? (value as Record<string, unknown>[])
			: null;
	} catch {
		return null;
	}
}

export function decodeAgentTerminalSnapshot(
	raw: string | null,
	logicalRunId: string,
	includeEventKind = false,
): AgentTerminalResult | null {
	const body = blocks(raw);
	if (!body) return null;
	for (const block of body) {
		const receipt = block.publicationResult;
		if (
			block.type === "text" &&
			typeof block.text === "string" &&
			receipt !== null &&
			typeof receipt === "object" &&
			"logicalRunId" in receipt &&
			receipt.logicalRunId === logicalRunId
		) {
			const sourceResultRef = agentSourceResultRef(
				"sourceResultRef" in receipt ? receipt.sourceResultRef : undefined,
			);
			const event = "eventKind" in receipt ? receipt.eventKind : undefined;
			const eventKind =
				event === "completed" ||
				event === "failed" ||
				event === "timed_out" ||
				event === "cancelled"
					? event
					: undefined;
			return {
				...(includeEventKind && eventKind ? { eventKind } : {}),
				output: boundedOutput(block.text, "truncated" in receipt && receipt.truncated === true),
				...(sourceResultRef ? { sourceResultRef } : {}),
			};
		}
	}
	return null;
}

export function decodeRunAssistantProjection(
	plain: string | null,
	raw: string | null,
): AgentTerminalResult | null {
	if (plain !== null) return plain.length ? { output: boundedOutput(plain) } : null;
	const body = blocks(raw);
	if (!body) return null;
	const text = body.filter((block) => block.type === "text" && typeof block.text === "string");
	const output = text.map((block) => block.text).join("\n");
	return output.length ? { output: boundedOutput(output) } : null;
}
