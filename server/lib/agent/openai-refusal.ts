import type { ParsedStreamEvent } from "@shared/agent-protocol/types";

// A refusal is delivered once as a terminal event, not as success text. Bound
// what we retain while waiting for the response's usage and gateway metering.
const MAX_CHARS = 64 * 1024;
const MAX_PARTS = 64;
const OMITTED = "\n[refusal truncated]";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}
function index(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface Part {
	itemId?: string;
	output?: number;
	content: number;
	text: string;
	closed: boolean;
	clipped: boolean;
	sequence?: number;
}

type Write = "delta" | "snapshot" | "done";
type OutputRefusalEvent = ParsedStreamEvent & {
	invalidState: NonNullable<ParsedStreamEvent["invalidState"]>;
};
// Only verdicts produced by this collector are deferred for tail accounting.
// A genuine API error with code=refusal must keep its original error semantics.
const outputRefusalEvents = new WeakSet<ParsedStreamEvent>();
export function isOutputRefusalEvent(event: ParsedStreamEvent): boolean {
	return outputRefusalEvents.has(event);
}

/** Per transport attempt. Only protocol fields can establish a refusal. */
export class OpenAIRefusal {
	private readonly parts: Part[] = [];
	private used = 0;
	private overflow = false;

	get seen(): boolean {
		return this.parts.length > 0;
	}

	private part(
		value: unknown,
		mode: Write,
		item?: unknown,
		output?: unknown,
		content?: unknown,
		sequence?: unknown,
	): void {
		if (typeof value !== "string") return;
		const itemId = typeof item === "string" && item.length <= 256 ? item : undefined;
		const outputIndex = index(output) ?? (itemId ? undefined : 0);
		const contentIndex = index(content) ?? 0;
		let part = this.parts.find(
			(p) =>
				p.content === contentIndex &&
				((itemId !== undefined && p.itemId === itemId) ||
					(outputIndex !== undefined && p.output === outputIndex && (!itemId || !p.itemId))),
		);
		if (!part) {
			if (this.parts.length === MAX_PARTS) {
				this.overflow = true;
				return;
			}
			part = {
				itemId,
				output: outputIndex,
				content: contentIndex,
				text: "",
				closed: false,
				clipped: false,
			};
			this.parts.push(part);
		}
		part.output ??= outputIndex;
		part.itemId ??= itemId;
		const seq = index(sequence);
		if (
			mode === "delta" &&
			(part.closed || (seq !== undefined && part.sequence !== undefined && seq <= part.sequence))
		)
			return;
		if (seq !== undefined) part.sequence = seq;
		if (mode === "done") part.closed = true;
		// Some relays repeat an empty placeholder in the terminal item. It must
		// not erase the refusal actually received on that lane.
		if (!value.length) return;
		if (mode !== "delta" && !part.clipped && part.text.startsWith(value)) return;
		if (mode !== "delta") {
			this.used -= part.text.length;
			part.text = "";
			part.clipped = false;
		}
		const room = MAX_CHARS - this.used;
		const count = Math.min(value.length, room);
		if (count) part.text += value.slice(0, count);
		part.clipped ||= count < value.length;
		this.used += count;
	}

	private item(value: unknown, output: unknown, mode: Write): void {
		const item = record(value);
		if (
			item?.type !== "message" ||
			(item.role !== undefined && item.role !== "assistant") ||
			!Array.isArray(item.content)
		)
			return;
		for (const [i, value] of item.content.entries()) {
			const part = record(value);
			if (part?.type === "refusal") this.part(part.refusal, mode, item.id, output, i);
		}
	}

	responses(chunk: {
		type?: string;
		item_id?: string;
		output_index?: number;
		content_index?: number;
		sequence_number?: number;
		delta?: unknown;
		refusal?: unknown;
		item?: unknown;
		part?: unknown;
		response?: unknown;
	}): void {
		const type = chunk.type;
		if (type === "response.refusal.delta" || type === "response.refusal.done") {
			const delta = type === "response.refusal.delta";
			this.part(
				delta ? chunk.delta : chunk.refusal,
				delta ? "delta" : "done",
				chunk.item_id,
				chunk.output_index,
				chunk.content_index,
				chunk.sequence_number,
			);
		} else if (type === "response.content_part.added" || type === "response.content_part.done") {
			const part = record(chunk.part);
			if (part?.type === "refusal")
				this.part(
					part.refusal,
					type.endsWith(".done") ? "done" : "snapshot",
					chunk.item_id,
					chunk.output_index,
					chunk.content_index,
				);
		} else if (type === "response.output_item.added" || type === "response.output_item.done") {
			this.item(chunk.item, chunk.output_index, type.endsWith(".done") ? "done" : "snapshot");
		} else if (type === "response.completed" || type === "response.incomplete") {
			const output = record(chunk.response)?.output;
			if (Array.isArray(output))
				for (const [i, item] of output.entries()) this.item(item, i, "done");
		}
	}

	chat(
		choice:
			| { delta?: { refusal?: string | null }; message?: { refusal?: string | null } }
			| undefined,
	): void {
		if (choice?.delta?.refusal) this.part(choice.delta.refusal, "delta");
		if (choice?.message?.refusal) this.part(choice.message.refusal, "done");
	}

	event(): OutputRefusalEvent {
		const sorted = this.parts
			.slice()
			.sort(
				(a, b) =>
					(a.output ?? Number.MAX_SAFE_INTEGER) - (b.output ?? Number.MAX_SAFE_INTEGER) ||
					a.content - b.content,
			);
		const message =
			sorted
				.map((p) => p.text)
				.filter(Boolean)
				.join("\n") || "The model refused the request.";
		const event: OutputRefusalEvent = {
			invalidState: {
				reason: "refusal",
				message: message + (this.overflow || sorted.some((p) => p.clipped) ? OMITTED : ""),
				diagnostics: {
					schema: "narrafork.error-diagnostics.v1",
					source: "provider",
					phase: "output_refusal",
					reason: "refusal",
					retryable: false,
					resumable: false,
				},
			},
		};
		outputRefusalEvents.add(event);
		return event;
	}
}

// Maps are owned by one transport attempt, including direct parser callers.
// Clearing/replacing tool accumulators never leaves global response state behind.
const refusalAttempts = new WeakMap<object, OpenAIRefusal>();
export function openAIRefusalFor(owner: object): OpenAIRefusal {
	let refusal = refusalAttempts.get(owner);
	if (!refusal) {
		refusal = new OpenAIRefusal();
		refusalAttempts.set(owner, refusal);
	}
	return refusal;
}
