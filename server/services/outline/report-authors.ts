/**
 * Who wrote a subagent report (task tree readability, PR C): the title of the subagent's session,
 * for the report's container line (「子代理报告 · 17:38 · 来自 探查-1」).
 *
 * The container is written by one system commit made for the subagent (`delegation.ts`: actor
 * `outline-report`, `narratorId` the subagent). Usually that is still the commit of the block's
 * current version; a container someone moved or edited since has it as its creating version, a
 * few versions back at most.
 *
 * Bounded, on the main thread: at most {@link OUTLINE_REPORT_AUTHOR_LIMITS.containers}
 * containers per call (the rest get no name: the line shows the time alone), one read of their
 * commits by seq, at most `historyRows` version rows (no content) for each container changed
 * since, one read of the sessions' titles.
 *
 * A name is given only to a reader who may read that session (`narratorVisible`): a report
 * attached to a page more people can read than the session never names the session to them.
 */
import { readDisplayNames } from "./access-reads";
import { OUTLINE_CHANGE } from "./model";
import { outlineStore } from "./store";
import type { OutlineCommitRow, OutlineStore } from "./store/port";

/** The system actor that attaches reports (`delegation.ts` writes its commits). */
export const OUTLINE_REPORT_ACTOR = "outline-report";

export const OUTLINE_REPORT_AUTHOR_LIMITS = {
	/** Containers named per call. */
	containers: 20,
	/** Versions of one container looked at for the one that created it. */
	historyRows: 6,
	/** Characters of a name. */
	nameChars: 80,
} as const;

function reportNarrator(commit: OutlineCommitRow | undefined): string | null {
	if (!commit || commit.actorKind !== "system" || commit.actorId !== OUTLINE_REPORT_ACTOR) {
		return null;
	}
	return commit.narratorId;
}

function clip(name: string): string {
	const flat = name.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	const max = OUTLINE_REPORT_AUTHOR_LIMITS.nameChars;
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The subagent's name for each of the report containers (`versionSeq`: the seq of the block's
 * current version), by block id; containers without a name the reader may see are left out.
 */
export async function readReportAuthors(
	spaceId: string,
	containers: ReadonlyArray<{ id: string; versionSeq: number }>,
	options: {
		narratorVisible?: (narratorId: string) => Promise<boolean>;
		/** The sessions' titles by id (null: untitled); the default reads `narrators`. */
		titles?: (narratorIds: readonly string[]) => Promise<Map<string, string | null>>;
		store?: OutlineStore;
	} = {},
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const visible = options.narratorVisible;
	if (!visible || containers.length === 0) return out;
	const store = options.store ?? outlineStore;
	const taken = containers.slice(0, OUTLINE_REPORT_AUTHOR_LIMITS.containers);
	const bySeq = new Map<number, OutlineCommitRow>();
	const load = async (seqs: readonly number[]) => {
		const missing = [...new Set(seqs)].filter((seq) => !bySeq.has(seq));
		if (missing.length === 0) return;
		for (const commit of await store.getCommitsBySeqs(spaceId, missing)) {
			bySeq.set(commit.seq, commit);
		}
	};
	await load(taken.map((c) => c.versionSeq));
	const narratorOf = new Map<string, string>();
	const created = new Map<string, number>();
	for (const container of taken) {
		const narrator = reportNarrator(bySeq.get(container.versionSeq));
		if (narrator) {
			narratorOf.set(container.id, narrator);
			continue;
		}
		// Changed since it was attached: the version that created it, if it is near.
		const history = await store.listBlockHistory(container.id, {
			limit: OUTLINE_REPORT_AUTHOR_LIMITS.historyRows,
		});
		const first = history.find((row) => (row.changeFlags & OUTLINE_CHANGE.CREATE) !== 0);
		if (first) created.set(container.id, first.fromSeq);
	}
	await load([...created.values()]);
	for (const [id, seq] of created) {
		const narrator = reportNarrator(bySeq.get(seq));
		if (narrator) narratorOf.set(id, narrator);
	}
	if (narratorOf.size === 0) return out;
	const narratorIds = [...new Set(narratorOf.values())];
	const titles = await (options.titles ?? defaultTitles)(narratorIds);
	for (const [id, narratorId] of narratorOf) {
		const title = titles.get(narratorId);
		if (!title?.trim()) continue;
		if (!(await visible(narratorId))) continue;
		out.set(id, clip(title));
	}
	return out;
}

async function defaultTitles(narratorIds: readonly string[]): Promise<Map<string, string | null>> {
	return (await readDisplayNames({ narratorIds })).narrators;
}
