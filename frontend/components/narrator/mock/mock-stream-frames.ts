/**
 * mock-stream-frames.ts — Builders for synthetic narrator WS frames.
 *
 * TEMPORARY MODULE. This whole directory exists to drive the virtual list with
 * reproducible streaming output so its measurement / animation / scroll-anchoring
 * behaviour can be tuned without asking a real model for a turn. See
 * `./README-REMOVAL.md` for how to delete it.
 *
 * Every builder returns a frame that is byte-shaped like the real thing
 * (`server/websocket/narrator-ws-types.ts`), because the consumers read specific
 * fields and a divergence here would make the harness lie:
 *
 *   - a TEXT delta carries its lane index on `event.outputIndex`
 *   - a REASONING delta carries it on `delta.outputIndex` (plus `delta.id`)
 *
 * That asymmetry is real (see `streaming-delta-fold.ts`), not a typo, and it is
 * the single easiest thing to get wrong here — hence the dedicated unit test.
 *
 * Pure: no WS, no React, no DOM.
 */

/** A frame exactly as it would arrive over `/ws/narrator`. */
export type MockFrame = Record<string, unknown>;

/**
 * One `content_block_delta` carrying assistant text.
 *
 * `outputIndex` sits on the EVENT (not the delta) for text — that is where
 * `applyStreamingDelta` reads it.
 */
export function mockTextDeltaFrame(opts: {
	narratorId: string;
	text: string;
	outputIndex?: number;
}): MockFrame {
	return {
		type: "stream_event",
		narratorId: opts.narratorId,
		event: {
			type: "content_block_delta",
			...(opts.outputIndex != null ? { outputIndex: opts.outputIndex } : {}),
			delta: { type: "text_delta", text: opts.text },
		},
	};
}

/**
 * One `content_block_delta` carrying reasoning text.
 *
 * `id` / `outputIndex` sit on the DELTA for reasoning, which is how the fold
 * keeps several reasoning lanes apart within one turn.
 */
export function mockReasoningDeltaFrame(opts: {
	narratorId: string;
	text: string;
	id?: string;
	outputIndex?: number;
}): MockFrame {
	return {
		type: "stream_event",
		narratorId: opts.narratorId,
		event: {
			type: "content_block_delta",
			delta: {
				type: "reasoning_delta",
				text: opts.text,
				...(opts.id ? { id: opts.id } : {}),
				...(opts.outputIndex != null ? { outputIndex: opts.outputIndex } : {}),
			},
		},
	};
}

/**
 * `tool_use_chunk` — the model is still writing this tool's arguments.
 *
 * `inputCharsTotal` is a RUNNING TOTAL the server recomputes each frame, while
 * `streamingField.delta` is incremental; the consumer accumulates the latter and
 * overwrites the former.
 */
export function mockToolChunkFrame(opts: {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	streamingField?: { name: string; delta: string; startsField?: boolean };
	extractedFilePath?: string;
	extractedFields?: Record<string, string>;
}): MockFrame {
	return {
		type: "tool_use_chunk",
		narratorId: opts.narratorId,
		toolCallId: null,
		toolUseId: opts.toolUseId,
		toolName: opts.toolName,
		inputCharsTotal: opts.inputCharsTotal,
		...(opts.streamingField ? { streamingField: opts.streamingField } : {}),
		...(opts.extractedFilePath ? { extractedFilePath: opts.extractedFilePath } : {}),
		...(opts.extractedFields ? { extractedFields: opts.extractedFields } : {}),
	};
}

/** `tool_started` — the INPUT finished parsing (NOT "executing"). */
export function mockToolStartedFrame(opts: {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
	streamStartedAt?: number;
}): MockFrame {
	return {
		type: "tool_started",
		narratorId: opts.narratorId,
		toolCallId: null,
		toolUseId: opts.toolUseId,
		toolName: opts.toolName,
		input: opts.input,
		...(opts.streamStartedAt != null ? { streamStartedAt: opts.streamStartedAt } : {}),
	};
}

/** `tool_executing` — the permission gate passed, work is under way. */
export function mockToolExecutingFrame(opts: {
	narratorId: string;
	toolUseId: string;
	executionStartedAt?: number;
}): MockFrame {
	return {
		type: "tool_executing",
		narratorId: opts.narratorId,
		toolUseId: opts.toolUseId,
		executionStartedAt: opts.executionStartedAt ?? Date.now(),
	};
}

/**
 * `tool_output` — streaming stdout.
 *
 * `output` is the CUMULATIVE preview, not a delta: the consumer keeps the latest
 * value per tool and throttles re-renders past 12k chars.
 */
export function mockToolOutputFrame(opts: {
	narratorId: string;
	toolUseId: string;
	output: string;
}): MockFrame {
	return {
		type: "tool_output",
		narratorId: opts.narratorId,
		toolUseId: opts.toolUseId,
		output: opts.output,
	};
}

/**
 * `tool_completed` — the terminal status plus the final output.
 *
 * `output` must be a plain STRING (or `{_text, _metadata}`), matching what
 * `narrator-session.ts` actually sends. A content-block array would be
 * JSON-dumped by `resolveDisplayText`, so the card would show structure instead
 * of the body — and the harness would be measuring the wrong thing.
 */
export function mockToolCompletedFrame(opts: {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	status?: string;
	output?: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
}): MockFrame {
	return {
		type: "tool_completed",
		narratorId: opts.narratorId,
		toolCallId: null,
		toolUseId: opts.toolUseId,
		toolName: opts.toolName,
		status: opts.status ?? "success",
		...(opts.output !== undefined ? { output: opts.output } : {}),
		...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
		...(opts.metadata ? { metadata: opts.metadata } : {}),
	};
}

/**
 * `streaming_reset` — drop every live block for this narrator.
 *
 * Sent when a mock run stops, so the synthetic row does not linger with no
 * committed message to hand off to (nothing was persisted, so the structural
 * hand-off has nothing to retire it with).
 */
export function mockStreamingResetFrame(narratorId: string): MockFrame {
	return { type: "streaming_reset", narratorId };
}
