import {
	contextBlockViews,
	injectionBlockViews,
	modelTextFromContentBlocks,
} from "../../shared/native-injection";

const DEFAULT_EVIDENCE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;

function boundedBytes(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(MAX_EVIDENCE_BYTES, Math.floor(value))) : 0;
}

/** Per-request accounting for optional evidence only, never rules, tasks or tool chains. */
export class ContextEvidenceBudget {
	private cap = 0;
	private generation = 0;
	private knowledgeBytes = 0;
	private memoryBytes = 0;
	private pendingBytes = 0;

	constructor(private readonly readLimit: () => number | undefined = () => undefined) {
		this.reset();
	}

	get remaining(): number {
		return Math.max(0, this.knowledgeAllowance - this.knowledgeBytes - this.pendingBytes);
	}

	get knowledgeAllowance(): number {
		return Math.max(0, this.cap - this.memoryBytes);
	}

	/** Rebuild from the authoritative compact history; late work cannot charge a new request. */
	reset(knowledgeBytes = 0): void {
		this.generation++;
		this.cap = boundedBytes(this.readLimit() ?? DEFAULT_EVIDENCE_BYTES);
		this.knowledgeBytes = Number.isFinite(knowledgeBytes)
			? Math.max(0, Math.floor(knowledgeBytes))
			: this.cap;
		this.memoryBytes = 0;
		this.pendingBytes = 0;
	}

	reserve(kind: "memory" | "knowledge", maxBytes: number) {
		const byteBudget = Math.min(this.remaining, boundedBytes(maxBytes));
		const generation = this.generation;
		this.pendingBytes += byteBudget;
		let open = true;
		const release = () => {
			if (!open) return;
			open = false;
			if (generation === this.generation) this.pendingBytes -= byteBudget;
		};
		return {
			byteBudget,
			release,
			commit: (text: string): boolean => {
				if (!open || generation !== this.generation) return false;
				release();
				// UTF-16 length rejects oversized inputs before scanning all of their bytes.
				if (!text || text.length > byteBudget) return false;
				const bytes = Buffer.byteLength(text, "utf8");
				if (bytes > byteBudget) return false;
				if (kind === "memory") this.memoryBytes += bytes;
				else this.knowledgeBytes += bytes;
				return true;
			},
		};
	}
}

/**
 * Keep recent whole knowledge blocks, preserving every nonoptional block and row.
 * This is a detached request projection; persisted messages and tool chains are not edited.
 */
export function projectKnowledgeEvidence<
	T extends { id: string; role: string; contentJson: unknown; contentText?: string | null },
>(
	messages: readonly T[],
	byteBudget: number,
): { messages: T[]; bytes: number; omittedMessageIds: string[] } {
	const cap = boundedBytes(byteBudget);
	let bytes = 0;
	const projected: T[] = [];
	const omittedMessageIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "sys" || !Array.isArray(message.contentJson)) {
			projected.push(message);
			continue;
		}
		const blocks = message.contentJson;
		const injections = injectionBlockViews(blocks).filter(
			(view) => view.block.source === "knowledge_base_hint",
		);
		const owned = new Set(injections.flatMap((view) => view.sourceIndices));
		const views = [
			...injections,
			...contextBlockViews(blocks).filter(
				(view) => view.block.type === "knowledge_hint" && !owned.has(view.blockIndex),
			),
		].sort((a, b) => b.blockIndex - a.blockIndex);
		const dropped = new Set<number>();
		for (const view of views) {
			const text = view.block.modelText ?? "";
			const size = text.length > cap - bytes ? cap + 1 : Buffer.byteLength(text, "utf8");
			if (size <= cap - bytes && cap > 0) bytes += size;
			else for (const physicalIndex of view.sourceIndices) dropped.add(physicalIndex);
		}
		if (dropped.size === 0) {
			projected.push(message);
			continue;
		}
		omittedMessageIds.push(message.id);
		const contentJson = blocks.filter((_, blockIndex) => !dropped.has(blockIndex));
		if (contentJson.length > 0) {
			projected.push({
				...message,
				contentJson,
				contentText: modelTextFromContentBlocks(contentJson),
			});
		}
	}
	return { messages: projected.reverse(), bytes, omittedMessageIds: omittedMessageIds.reverse() };
}
