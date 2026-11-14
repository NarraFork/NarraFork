import { createHash } from "node:crypto";
import type { AgentEvent } from "../lib/agent/types";

const MAX_CALLS = 128;
const MAX_PASS_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;

/** Canonical JSON without invoking toJSON/getters or traversing unbounded structures. */
function boundedInput(value: unknown, byteBudget: number): string | null {
	const chunks: string[] = [];
	const ancestors = new Set<object>();
	let bytes = 0;
	let nodes = 0;
	const append = (text: string) => {
		if (text.length > byteBudget - bytes) return false;
		bytes += Buffer.byteLength(text, "utf8");
		if (bytes > byteBudget) return false;
		chunks.push(text);
		return true;
	};
	const visit = (item: unknown, depth: number): boolean => {
		if (++nodes > 256 || depth > 8) return false;
		if (item === null || typeof item === "boolean") return append(JSON.stringify(item));
		if (typeof item === "number") return Number.isFinite(item) && append(JSON.stringify(item));
		if (typeof item === "string") {
			return item.length <= byteBudget - bytes && append(JSON.stringify(item));
		}
		if (typeof item !== "object" || !item || ancestors.has(item)) return false;
		ancestors.add(item);
		if (Array.isArray(item)) {
			if (item.length > 64 || !append("[")) return false;
			for (let index = 0; index < item.length; index++) {
				const entry = Object.getOwnPropertyDescriptor(item, String(index));
				if (!entry || !("value" in entry)) return false;
				if ((index > 0 && !append(",")) || !visit(entry.value, depth + 1)) return false;
			}
			ancestors.delete(item);
			return append("]");
		}
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== null && prototype !== Object.prototype) return false;
		const keys: string[] = [];
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			if (keys.length === 64) return false;
			keys.push(key);
		}
		keys.sort();
		if (!append("{")) return false;
		for (const [index, key] of keys.entries()) {
			const entry = Object.getOwnPropertyDescriptor(item, key);
			if (!entry || !("value" in entry)) return false;
			if ((index > 0 && !append(",")) || !visit(key, depth + 1) || !append(":")) return false;
			if (!visit(entry.value, depth + 1)) return false;
		}
		ancestors.delete(item);
		return append("}");
	};
	try {
		return visit(value, 0) ? chunks.join("") : null;
	} catch {
		return null;
	}
}

/**
 * An observation, never an execution/replay credential. Only complete, persisted
 * textual receipts can establish equality; unmeasured evidence remains unknown.
 * Retains hashes only, capped at 128 calls and 128 KiB of input/output per pass.
 */
export class ContinuationProgressTracker {
	private expected = new Set<string>();
	private receipts = new Map<string, string>();
	private remainingBytes = MAX_PASS_BYTES;
	private unknown = false;

	invalidate(): void {
		this.unknown = true;
		this.expected.clear();
		this.receipts.clear();
	}

	observe(event: AgentEvent): void {
		if (this.unknown) return;
		if (event.type === "assistant_message") {
			for (const tool of event.toolUses) {
				this.expected.add(tool.toolUseId);
				if (this.expected.size > MAX_CALLS) {
					this.invalidate();
					return;
				}
			}
		} else if (event.type === "tool_result") {
			if (
				!event.input ||
				event.images?.length ||
				event.output.length > MAX_OUTPUT_BYTES ||
				event.toolName.length > 128
			) {
				this.invalidate();
				return;
			}
			if (!this.receipts.has(event.toolUseId) && this.receipts.size === MAX_CALLS) {
				this.invalidate();
				return;
			}
			const outputBytes = Buffer.byteLength(event.output, "utf8");
			if (outputBytes > MAX_OUTPUT_BYTES || outputBytes > this.remainingBytes) {
				this.invalidate();
				return;
			}
			const input = boundedInput(
				event.input,
				Math.min(MAX_INPUT_BYTES, this.remainingBytes - outputBytes),
			);
			if (input === null) {
				this.invalidate();
				return;
			}
			this.remainingBytes -= outputBytes + Buffer.byteLength(input, "utf8");
			const fingerprint = createHash("sha256")
				.update(JSON.stringify([event.toolName, input, event.isError]))
				.update("\n")
				.update(event.output)
				.digest("hex");
			const previous = this.receipts.get(event.toolUseId);
			if (previous && previous !== fingerprint) {
				this.invalidate();
				return;
			}
			this.receipts.set(event.toolUseId, fingerprint);
		}
	}

	fingerprint(): string | undefined {
		if (this.unknown || this.expected.size === 0 || this.expected.size !== this.receipts.size)
			return undefined;
		for (const id of this.expected) if (!this.receipts.has(id)) return undefined;
		// Reordering or duplicating the same observation is not new progress.
		return createHash("sha256")
			.update([...new Set(this.receipts.values())].sort().join("\n"))
			.digest("hex");
	}
}
