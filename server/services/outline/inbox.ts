/**
 * The outline's part of a person's inbox (human attention, outline P2 PR 7; design §3.3): only
 * what the person decides, ids and a summary per row (the client reads the rest from the
 * outline API).
 *
 *   - `outline_decision`, questions: the open questions put to them, one row per block they are
 *     under (D20), answered at once (`questions.ts`).
 *   - `outline_decision`, pending: the open changes to plans they locked (P2 PR 6), with the diff
 *     and confirm or reject on the page's pending API.
 *   - `outline_digest`: the confirmations an agent made on their behalf (a session they named to
 *     confirm for a locked plan) that they have not acknowledged: one row, each confirmation
 *     revertable. Reports join it in plan PR 11.
 *
 * A row is shown only while the person may read its space, and offers acting only while they may
 * write it. A session is named (id and title) only to people who may read it (P2 PR 6's rule);
 * others see a placeholder. Every read is indexed and bounded.
 */
import type { HumanAttentionItem } from "@shared/human-attention";
import type { OutlineDigestItem, OutlineDigestResponse } from "@shared/outline-api";
import { canReadSpace, canWriteSpace, narratorVisibility, type OutlinePrincipal } from "./access";
import { readDisplayNames } from "./access-reads";
import { isOutlineEnabled } from "./feature";
import { outlinePendingLabel } from "./model";
import { withCurrentDeciders } from "./pending";
import { listQuestionGroupsForUser } from "./questions";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export const OUTLINE_INBOX_LIMITS = {
	/** Open changes a person decides one read takes. */
	pending: 100,
	/** Unacknowledged confirmations one digest shows. */
	digest: 50,
	/** Characters of a row's summary. */
	summaryChars: 240,
} as const;

/** The id of a person's digest row (one per person). */
export const OUTLINE_DIGEST_ATTENTION_ID = "outline:d:digest";

function clip(text: string): string {
	return text.length > OUTLINE_INBOX_LIMITS.summaryChars
		? `${text.slice(0, OUTLINE_INBOX_LIMITS.summaryChars - 1)}…`
		: text;
}

/** Read and write access of the person to spaces, memoized for one request. */
function accessCache(principal: OutlinePrincipal, store: OutlineStore) {
	const spaces = new Map<string, Promise<{ space: OutlineSpaceRow; write: boolean } | null>>();
	return (spaceId: string) => {
		let found = spaces.get(spaceId);
		if (!found) {
			found = (async () => {
				const space = await store.getSpace(spaceId);
				if (!space || !(await canReadSpace(principal, space))) return null;
				return { space, write: await canWriteSpace(principal, space) };
			})();
			spaces.set(spaceId, found);
		}
		return found;
	};
}

/** The person's outline rows, by id. Empty while the outline is switched off. */
export async function listOutlineAttention(
	principal: OutlinePrincipal,
	options: { store?: OutlineStore } = {},
): Promise<HumanAttentionItem[]> {
	if (!isOutlineEnabled() || !principal.userId) return [];
	const store = options.store ?? outlineStore;
	const access = accessCache(principal, store);
	const visible = narratorVisibility(principal);
	const items: HumanAttentionItem[] = [];
	const base = {
		source: "outline" as const,
		toolCallId: "",
		parentNarratorId: null,
		rootNarratorId: null,
		blocking: false,
	};

	const { groups } = await listQuestionGroupsForUser(principal.userId, { store });
	const pending = await withCurrentDeciders(
		await store.listOpenPendingForDecider(principal.userId, OUTLINE_INBOX_LIMITS.pending),
		{ store },
	);
	const narratorIds = [
		...groups.flatMap((g) => g.askers.slice(0, 1)),
		...pending.flatMap((p) => (p.requesterSession ? [p.requesterSession] : [])),
	];
	const names = await readDisplayNames({ narratorIds });

	for (const group of groups) {
		const a = await access(group.spaceId);
		if (!a) continue;
		const asker = group.askers[0] ?? "";
		const shown = asker !== "" && (await visible(asker));
		items.push({
			...base,
			id: `outline:q:${group.groupBlockId}`,
			kind: "outline_decision",
			requestId: `q:${group.groupBlockId}`,
			toolName: "Ask",
			narratorId: shown ? asker : "",
			narratorTitle: shown ? (names.narrators.get(asker) ?? null) : null,
			createdAt: group.createdAt,
			canAct: a.write,
			summary: clip(group.title),
			outline: {
				what: "questions",
				spaceId: group.spaceId,
				pageId: group.pageId,
				blockId: group.groupBlockId,
				pendingId: null,
				count: group.questionIds.length,
				sessionHidden: asker !== "" && !shown,
			},
		});
	}

	for (const row of pending) {
		// Who decides it now: the lock as it is (a change of delegate since does not move it).
		const by = row.deciderJson.by;
		if (by.kind !== "human" || by.id !== principal.userId) continue;
		const a = await access(row.spaceId);
		if (!a) continue;
		const proposer = row.requesterSession ?? "";
		const shown = proposer !== "" && (await visible(proposer));
		items.push({
			...base,
			id: `outline:p:${row.id}`,
			kind: "outline_decision",
			requestId: `p:${row.id}`,
			toolName: "OutlineEdit",
			narratorId: shown ? proposer : "",
			narratorTitle: shown ? (names.narrators.get(proposer) ?? null) : null,
			createdAt: row.createdAt,
			canAct: a.write,
			summary: clip(row.summary || outlinePendingLabel(row.id)),
			outline: {
				what: "pending",
				spaceId: row.spaceId,
				pageId: row.pageId,
				blockId: row.rootBlockId,
				pendingId: row.id,
				count: row.opCount,
				sessionHidden: proposer !== "" && !shown,
			},
		});
	}

	const digest = await readOutlineDigest(principal, { store });
	if (digest.items.length > 0) {
		const first = digest.items[0] as OutlineDigestItem;
		items.push({
			...base,
			id: OUTLINE_DIGEST_ATTENTION_ID,
			kind: "outline_digest",
			requestId: "d:digest",
			toolName: "OutlineEdit",
			narratorId: "",
			narratorTitle: null,
			createdAt: first.decidedAt ?? new Date(0).toISOString(),
			canAct: true,
			// Localized by the client from the count.
			summary: "",
			outline: {
				what: "digest",
				spaceId: null,
				pageId: null,
				blockId: null,
				pendingId: null,
				count: digest.items.length,
				sessionHidden: false,
			},
		});
	}
	return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The confirmations agents made on the person's behalf that they have not acknowledged, in spaces
 * they may still read, oldest first (at most {@link OUTLINE_INBOX_LIMITS.digest}).
 */
export async function readOutlineDigest(
	principal: OutlinePrincipal,
	options: { store?: OutlineStore } = {},
): Promise<OutlineDigestResponse> {
	const store = options.store ?? outlineStore;
	const rows = await store.listUnseenDelegateConfirmations(
		principal.userId,
		OUTLINE_INBOX_LIMITS.digest + 1,
	);
	const access = accessCache(principal, store);
	const visible = narratorVisibility(principal);
	const narratorIds = rows.flatMap((r) =>
		r.decidedByJson?.kind === "agent" ? [r.decidedByJson.id] : [],
	);
	const names = await readDisplayNames({ narratorIds });
	const items: OutlineDigestItem[] = [];
	for (const row of rows.slice(0, OUTLINE_INBOX_LIMITS.digest)) {
		const a = await access(row.spaceId);
		if (!a || row.decidedByJson?.kind !== "agent") continue;
		const decider = row.decidedByJson.id;
		const shown = await visible(decider);
		items.push({
			pendingId: row.id,
			label: outlinePendingLabel(row.id),
			spaceId: row.spaceId,
			spaceKey: a.space.key,
			pageId: row.pageId,
			rootBlockId: row.rootBlockId,
			summary: clip(row.summary),
			opCount: row.opCount,
			decidedAt: row.decidedAt,
			decidedBy: {
				narratorId: shown ? decider : null,
				title: shown ? (names.narrators.get(decider) ?? null) : null,
				hidden: !shown,
			},
			commitId: row.decisionCommitId,
			canRevert: a.write,
		});
	}
	return { items, truncated: rows.length > OUTLINE_INBOX_LIMITS.digest };
}

/** The person acknowledges confirmations in their digest; returns how many. */
export async function markOutlineDigestSeen(
	principal: OutlinePrincipal,
	pendingIds: readonly string[],
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	return await store.markDelegateConfirmationsSeen(
		principal.userId,
		pendingIds.slice(0, OUTLINE_INBOX_LIMITS.digest),
		(options.now?.() ?? new Date()).toISOString(),
	);
}
