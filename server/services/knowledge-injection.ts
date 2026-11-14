import { KNOWLEDGE_EXCERPT_MAX_CHARS, knowledgeExcerpt } from "@shared/knowledge-excerpt";
import { formatKnowledgeInjections as formatInjectionsBare } from "@shared/sidecar-body";

export { formatInjectionsBare };

import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import {
	isCurrentFullTextEvidence,
	rankKnowledgeCandidates,
	retrieveFullTextEvidence,
} from "./knowledge/hybrid-retrieval";
import {
	MAX_KNOWLEDGE_EVIDENCE_CANDIDATES,
	readKnowledgeEvidence,
	sameKnowledgeEvidence,
} from "./knowledge/injection-evidence";
import {
	type CompiledMatcher,
	candidateKey,
	compileMatcher,
	getCompiledMatcher,
	matchWithCompiledMatcher,
	normalizeForKeywordMatch,
} from "./knowledge/keyword-index";
import { knowledgeAcl } from "./knowledge-acl";
import { knowledgeService } from "./knowledge-service";

export function injectionKey(hit: { scope?: "personal" | "global"; entryId: string }): string {
	return `${hit.scope ?? "global"}:${hit.entryId}`;
}

export interface InjectionHit {
	scope?: "personal" | "global";
	entryId: string;
	entryRevisionId?: string | null;
	title: string;
	summary: string;
}

export interface KnowledgeHintBlock {
	type: "knowledge_hint";
	entries: InjectionHit[];
	source: "user_message" | "tool_output" | "system_continuation";
	compactSeq: number;
}

export interface ToolOutputKnowledgeScanResult {
	content: string;
	hits: InjectionHit[];
}

/** De-dup set of entry ids already injected this turn (caller owns the set). */
export type InjectedSet = Set<string>;

export interface KnowledgeInjectionOptions {
	collectionId?: string;
	projectId?: string;
	already?: InjectedSet;
	signal?: AbortSignal;
	/** Budget of the complete JSON hit list, including ids, titles and revision references. */
	byteBudget?: number;
}

export const MAX_KNOWLEDGE_EVIDENCE_BYTES = 8 * 1024;
const MAX_INJECTION_ENTRIES = 16;
const MAX_INJECTION_INPUT_CHARS = 64 * 1024;
const INJECTION_DEADLINE_MS = 1_000;

const MAX_SUMMARY_CHARS = KNOWLEDGE_EXCERPT_MAX_CHARS;

/**
 * One-line excerpt of an entry body, for the hit's `summary`.
 *
 * ⚠️ This used to be `text.replace(/\s+/g, " ")` and nothing else, which is where the
 * "giant heading" rendering came from: an entry body opens with `# Title`, so collapsing
 * it to one line put the WHOLE excerpt behind that `#` and the reader-facing Markdown
 * projection painted 300 characters at display size, with the body's surviving `>` and
 * backtick markers strewn through it. Markdown has to be stripped, not merely flattened
 * — see `@shared/knowledge-excerpt`.
 *
 * `title` is passed so a body whose first line just repeats the entry title contributes
 * its SECOND line instead; the injection bubble's header already shows the title.
 */
function summarize(text: string, title?: string): string {
	return knowledgeExcerpt(text, { title, maxChars: MAX_SUMMARY_CHARS });
}

/**
 * Resolve knowledge entries relevant to `text` that the given user may read.
 *
 * The default dictionary mode preserves "input contains keyword" semantics. Opt-in hybrid
 * mode adds bounded full-text candidates, ranking declared keywords before title/body hits.
 * Neither channel is evidence by itself: current content, revision, scope and live ACL
 * are checked again before any excerpt leaves this service.
 *   - userId: the user who triggered this loop turn (null → anonymous, public only)
 *   - projectId: restrict to this project's collections + global ones (cross-project isolation)
 *   - returns at most settings.knowledge.maxInjectedEntries hits, excluding `already`
 */
export async function resolveInjections(
	userId: string | null | undefined,
	text: string,
	opts: KnowledgeInjectionOptions = {},
): Promise<InjectionHit[]> {
	const { signal } = opts;
	signal?.throwIfAborted();
	const cfg = settings.knowledge;
	const requested = opts.byteBudget ?? MAX_KNOWLEDGE_EVIDENCE_BYTES;
	const byteBudget = Number.isFinite(requested)
		? Math.min(MAX_KNOWLEDGE_EVIDENCE_BYTES, Math.max(0, Math.floor(requested)))
		: 0;
	const maxEntries = Number.isFinite(cfg.maxInjectedEntries)
		? Math.min(MAX_INJECTION_ENTRIES, Math.max(0, Math.floor(cfg.maxInjectedEntries)))
		: 0;
	if (cfg.injectMode === "off" || byteBudget === 0 || maxEntries === 0) return [];
	const normalizedText = normalizeForKeywordMatch((text ?? "").slice(0, MAX_INJECTION_INPUT_CHARS));
	if (!normalizedText || normalizedText.length < cfg.minKeywordLen) return [];
	const started = Date.now();
	const withinBudget = () => {
		signal?.throwIfAborted();
		if (Date.now() - started <= INJECTION_DEADLINE_MS) return true;
		logger.warn("Knowledge evidence deadline exceeded; omitting hints", {
			durationMs: Date.now() - started,
		});
		return false;
	};

	let matcher: CompiledMatcher | undefined;
	try {
		matcher = await getCompiledMatcher({
			signal,
			userId,
			collectionId: opts.collectionId,
			projectId: opts.projectId,
		});
	} catch {
		signal?.throwIfAborted();
	}
	if (!withinBudget()) return [];
	const keywordMatches = matcher ? matchWithCompiledMatcher(normalizedText, matcher) : [];
	const fullText =
		cfg.retrievalMode === "hybrid"
			? await retrieveFullTextEvidence(normalizedText, { ...opts, userId })
			: [];
	if (!withinBudget()) return [];
	const fullTextByKey = new Map(fullText.map((row) => [candidateKey(row), row]));
	const ranked =
		cfg.retrievalMode === "hybrid"
			? rankKnowledgeCandidates(normalizedText, keywordMatches, fullText)
			: keywordMatches;
	const matched = ranked
		.filter((row) => !opts.already?.has(candidateKey(row)))
		.slice(0, MAX_KNOWLEDGE_EVIDENCE_CANDIDATES);
	if (matched.length === 0) return [];

	const caps = await knowledgeAcl.resolveCapsByUserId(userId);
	if (!withinBudget()) return [];
	const principal = { userId: caps.userId, role: caps.role };
	const readableGlobal = await knowledgeService.filterReadable(
		principal,
		matched.filter((row) => row.scope === "global"),
		{ caps },
	);
	if (!withinBudget()) return [];
	const readableIds = new Set(readableGlobal.map(candidateKey));
	const selected = matched
		.filter((row) => row.scope === "personal" || readableIds.has(candidateKey(row)))
		.slice(0, maxEntries);
	if (selected.length === 0) return [];

	// A cached keyword hit is only a candidate, never evidence or an authorization decision.
	const evidenceOptions = {
		userId,
		collectionId: opts.collectionId,
		projectId: opts.projectId,
		signal,
	};
	const evidence = await readKnowledgeEvidence(selected, evidenceOptions);
	if (!withinBudget()) return [];
	const byKey = new Map(evidence.map((row) => [candidateKey(row), row]));
	const current = selected.flatMap((row) => {
		const value = byKey.get(candidateKey(row));
		return value ? [value] : [];
	});
	let currentKeywordMatches: ReturnType<typeof matchWithCompiledMatcher>;
	try {
		currentKeywordMatches = matchWithCompiledMatcher(normalizedText, compileMatcher(current));
	} catch {
		logger.warn("Knowledge evidence keyword budget exceeded; omitting hints");
		return [];
	}
	const currentFullText = current.filter((row) => {
		const hit = fullTextByKey.get(candidateKey(row));
		return hit && isCurrentFullTextEvidence(hit, row);
	});
	const stillMatched =
		cfg.retrievalMode === "hybrid"
			? rankKnowledgeCandidates(normalizedText, currentKeywordMatches, currentFullText)
			: currentKeywordMatches;
	if (stillMatched.length === 0) return [];

	// Archive/delete/move or edits during collection invalidate the selected snapshot.
	const verified = await readKnowledgeEvidence(stillMatched, evidenceOptions);
	if (!withinBudget()) return [];
	const verifiedByKey = new Map(verified.map((row) => [candidateKey(row), row]));
	const stable = stillMatched.filter((row) => {
		const snapshot = byKey.get(candidateKey(row));
		const latest = verifiedByKey.get(candidateKey(row));
		return snapshot && latest && sameKnowledgeEvidence(snapshot, latest);
	});
	if (stable.length === 0) return [];
	// Resolve live identity and grants AFTER the last content read; do not reuse earlier caps.
	const finalCaps = await knowledgeAcl.resolveCapsByUserId(userId);
	const authorized = await knowledgeService.filterReadable(
		{ userId: finalCaps.userId, role: finalCaps.role },
		stable.filter((row) => row.scope === "global"),
		{ caps: finalCaps },
	);
	if (!withinBudget()) return [];
	const authorizedIds = new Set(authorized.map(candidateKey));
	const allowed = stable.filter(
		(row) => row.scope === "personal" || authorizedIds.has(candidateKey(row)),
	);
	const hits: InjectionHit[] = [];
	for (const row of allowed) {
		const snapshot = byKey.get(candidateKey(row));
		const latest = verifiedByKey.get(candidateKey(row));
		if (!snapshot || !latest || !sameKnowledgeEvidence(snapshot, latest)) continue;
		const searched = fullTextByKey.get(candidateKey(snapshot));
		const snippet =
			searched && isCurrentFullTextEvidence(searched, snapshot)
				? searched.snippet
				: snapshot.snippet;
		const hit: InjectionHit = {
			scope: snapshot.scope,
			entryId: snapshot.id,
			entryRevisionId: snapshot.entryRevisionId,
			title: snapshot.title,
			summary: summarize(snippet, snapshot.title),
		};
		if (Buffer.byteLength(JSON.stringify([...hits, hit]), "utf8") <= byteBudget) hits.push(hit);
	}
	return withinBudget() ? hits : [];
}

/** Render injection hits as a system-reminder style block (or null if none). */
export function formatInjections(hits: InjectionHit[], heading: string): string | null {
	if (hits.length === 0) return null;
	return `<knowledge_base_hint>\n${formatInjectionsBare(hits, heading)}\n</knowledge_base_hint>`;
}

export function createKnowledgeHintBlock(
	hits: InjectionHit[],
	source: KnowledgeHintBlock["source"],
	compactSeq: number,
): KnowledgeHintBlock {
	return { type: "knowledge_hint", entries: hits, source, compactSeq };
}

/**
 * Scan a tool output for relevant knowledge and return a reminder block to append, or null.
 * Truncates the output before scanning (performance guard) and respects the de-dup set.
 */
export async function scanToolOutputForKnowledgeDetailed(
	userId: string | null | undefined,
	output: string,
	already: InjectedSet,
	opts: Omit<KnowledgeInjectionOptions, "already"> = {},
): Promise<ToolOutputKnowledgeScanResult | null> {
	opts.signal?.throwIfAborted();
	const cfg = settings.knowledge;
	if (cfg.injectMode === "off" || !cfg.scanToolOutput) return null;
	if (!output) return null;
	const scanText =
		output.length > cfg.maxToolOutputScanChars
			? output.slice(0, cfg.maxToolOutputScanChars)
			: output;
	const hits = await resolveInjections(userId, scanText, { ...opts, already });
	if (hits.length === 0) return null;
	for (const h of hits) already.add(injectionKey(h));
	return {
		hits,
		content: formatInjectionsBare(
			hits,
			"Relevant knowledge-base entries were found based on the latest tool output:",
		),
	};
}

export async function scanToolOutputForKnowledge(
	userId: string | null | undefined,
	output: string,
	already: InjectedSet,
	opts: Omit<KnowledgeInjectionOptions, "already"> = {},
): Promise<string | null> {
	const result = await scanToolOutputForKnowledgeDetailed(userId, output, already, opts);
	return result?.content ?? null;
}

export const knowledgeInjection = {
	resolveInjections,
	formatInjections,
	formatInjectionsBare,
	createKnowledgeHintBlock,
	scanToolOutputForKnowledgeDetailed,
	scanToolOutputForKnowledge,
};
