import type { Database } from "bun:sqlite";
import {
	type CompactMessageBlock,
	type CompactMessageDetail,
	parseCompactMessageBlock,
} from "@shared/compact-message";
import { boundedBodyText } from "../narrator-bodies";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
export const COMPACT_SUMMARY_BUDGET_EXCEEDED = "COMPACT_SUMMARY_BUDGET_EXCEEDED";

export type CompactSummaryReadResult =
	| { detail: CompactMessageDetail }
	| { notFound: "Message" | "CompactSummary" };

export function storedCompactDetail(
	block: CompactMessageBlock,
	facts: Pick<CompactMessageDetail, "canRetry" | "contextPercentBefore" | "contextPercentAfter">,
): CompactMessageDetail {
	const latest = block.attempts?.at(-1);
	return {
		status: block.status,
		summary: typeof block.summary === "string" ? block.summary : "",
		model: latest?.model,
		startedAt: latest?.startedAt,
		finishedAt: latest?.finishedAt,
		error:
			typeof block.error === "string"
				? block.error
				: latest?.status === "failed"
					? latest.error
					: undefined,
		mode: block.mode,
		trigger: block.trigger,
		attempts: block.attempts ?? [],
		...facts,
	};
}

export function readCompactSummary(
	sqlite: Database,
	params: { narratorId: string; messageId: string; fromBlocks: boolean },
	signal: AbortSignal,
	maxBodyBytes = MAX_BODY_BYTES,
): CompactSummaryReadResult {
	const { narratorId, messageId, fromBlocks } = params;
	signal.throwIfAborted();
	return sqlite.transaction((): CompactSummaryReadResult => {
		const row = sqlite
			.query<
				{
					seq: number;
					isCompact: number;
					bodyRowsOnly: number;
					contextPercent: number | null;
					tokensIn: number | null;
				},
				[string, string]
			>(`SELECT r.seq, r.is_compact AS isCompact, m.body_rows_only AS bodyRowsOnly,
				m.context_percent AS contextPercent, m.tokens_in AS tokensIn
				FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
				WHERE r.narrator_id = ? AND r.message_id = ? AND m.role = 'system' LIMIT 1`)
			.get(narratorId, messageId);
		if (!row) return { notFound: "Message" };
		const body = boundedBodyText(sqlite, messageId, fromBlocks || row.bodyRowsOnly === 1, {
			maxBytes: maxBodyBytes,
		});
		if (body === undefined) {
			throw Object.assign(new Error("Compact body exceeds its read budget"), {
				code: COMPACT_SUMMARY_BUDGET_EXCEEDED,
			});
		}
		const content: unknown = JSON.parse(body);
		let block: CompactMessageBlock | null = null;
		if (Array.isArray(content)) {
			for (const element of content) {
				block = parseCompactMessageBlock(element);
				if (block) break;
			}
		}
		if (!block) return { notFound: "CompactSummary" };
		const latestCompactSeq = sqlite
			.query<{ seq: number }, [string]>(`SELECT seq FROM narrator_message_refs
				WHERE narrator_id = ? AND is_compact = 1 ORDER BY seq DESC LIMIT 1`)
			.get(narratorId)?.seq;
		let contextPercentBefore = block.contextPercentBefore;
		if (contextPercentBefore == null) {
			const previousCompactSeq = sqlite
				.query<{ seq: number }, [string, number]>(`SELECT seq FROM narrator_message_refs
					WHERE narrator_id = ? AND seq < ? AND is_compact = 1 ORDER BY seq DESC LIMIT 1`)
				.get(narratorId, row.seq)?.seq;
			contextPercentBefore = sqlite
				.query<{ contextPercent: number }, [string, number, ...number[]]>(`
					SELECT m.context_percent AS contextPercent
					FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
					WHERE r.narrator_id = ? AND r.seq < ?
						${previousCompactSeq == null ? "" : "AND r.seq > ?"}
						AND m.role != 'system' AND m.context_percent IS NOT NULL
					ORDER BY r.seq DESC LIMIT 1`)
				.get(
					narratorId,
					row.seq,
					...(previousCompactSeq == null ? [] : [previousCompactSeq]),
				)?.contextPercent;
		}
		signal.throwIfAborted();
		return {
			detail: storedCompactDetail(block, {
				canRetry:
					block.status === "failed" &&
					row.isCompact === 0 &&
					(latestCompactSeq == null || row.seq > latestCompactSeq),
				contextPercentBefore,
				contextPercentAfter:
					block.contextPercentAfter ??
					(row.tokensIn != null ? (row.contextPercent ?? undefined) : undefined),
			}),
		};
	})();
}
