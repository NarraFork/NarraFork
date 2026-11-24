/**
 * The knowledge check of `work.ready`: a work item's branch must not leave the repository's
 * knowledge tree (`knowledge/`, conventions in `knowledge/README.md`) stale.
 *
 * Everything is read at one head commit `work.ready` pinned (`head`), against the merge base of
 * that commit and the item's base commit:
 * - a node (as it is at the head) one of whose anchors matches a changed path needs the node
 *   file changed in the same branch (touching it counts, even only `verified_at`);
 * - a source file the branch added under `server/`, `frontend/` or `shared/` needs a node that
 *   anchors it.
 * Either gap refuses readiness with 409 `TEAM_WORK_ITEM_KNOWLEDGE_STALE`. A head without a
 * regular file at exactly `knowledge/index.md` has no tree and is not checked; that is decided
 * before anything under `knowledge/` is listed.
 *
 * Git is read only through the hardened `team-git.ts`: one tree entry, a two-commit diff, a tree
 * listing with blob sizes, and the node blobs themselves, never the worktree. The count and byte
 * caps are enforced on the listed sizes before any blob is read, and each read stops past its
 * blob's size; matching work is capped too. The check fails closed: when it cannot run (git
 * error, oversized tree or listing), readiness is refused with 409
 * `TEAM_KNOWLEDGE_CHECK_UNAVAILABLE`, never passed. The rules themselves (header parsing, anchor
 * matching, source files) are `shared/knowledge-tree.ts`, the same as the tool's.
 */
import {
	indexAnchors,
	isNodeFile,
	KNOWLEDGE_DIR,
	KNOWLEDGE_INDEX,
	type KnowledgeGaps,
	type KnowledgeNode,
	knowledgeGaps,
	parseNode,
} from "@shared/knowledge-tree";
import { AppError } from "../../lib/errors";
import { type TeamGit, type TreeBlob, teamGit } from "./team-git";

/** At most this many node files are read; a larger tree fails the check. */
export const KNOWLEDGE_CHECK_MAX_NODE_FILES = 2000;
/** At most this many bytes of node files in total; a larger tree fails the check. */
export const KNOWLEDGE_CHECK_MAX_NODE_BYTES = 8 * 1024 * 1024;
/**
 * At most this many (path × directory-or-glob anchor) tests, the only part of matching that
 * grows with both sides; over it the check fails instead of holding the event loop.
 */
export const KNOWLEDGE_CHECK_MAX_MATCH_TESTS = 250_000;
/** Listed nodes and uncovered files in the refusal; the rest are counted. */
export const KNOWLEDGE_STALE_LIST_MAX = 20;
/** Changed files listed per node in the refusal; the rest are counted. */
export const KNOWLEDGE_STALE_FILES_PER_NODE = 10;
/** Node blobs read at once. */
const READ_CONCURRENCY = 16;

const DEFAULT_LIMITS = {
	maxNodeFiles: KNOWLEDGE_CHECK_MAX_NODE_FILES,
	maxNodeBytes: KNOWLEDGE_CHECK_MAX_NODE_BYTES,
	maxMatchTests: KNOWLEDGE_CHECK_MAX_MATCH_TESTS,
};
let limits = DEFAULT_LIMITS;

/** Lower the caps (tests); null restores them. */
export function setKnowledgeCheckLimitsForTests(next: Partial<typeof DEFAULT_LIMITS> | null): void {
	limits = next ? { ...DEFAULT_LIMITS, ...next } : DEFAULT_LIMITS;
}

/** The `details` of a `TEAM_WORK_ITEM_KNOWLEDGE_STALE` refusal. */
export interface KnowledgeStaleDetails {
	head: string;
	mergeBase: string;
	/** Node files to update, each with changed files that hit its anchors. */
	nodes: Array<{ file: string; files: string[]; moreFiles: number }>;
	moreNodes: number;
	/** Added source files no node anchors. */
	uncovered: string[];
	moreUncovered: number;
}

export type KnowledgeCheckResult =
	| { checked: false }
	| { checked: true; head: string; nodeCount: number };

class KnowledgeCheckUnavailable extends Error {}

function unavailable(itemId: string, reason: string): AppError {
	return new AppError(
		`The knowledge check of work item ${itemId} could not run (${reason}), so it is not known whether the branch leaves knowledge nodes stale; nothing was marked. Fix the cause and try work.ready again.`,
		409,
		"TEAM_KNOWLEDGE_CHECK_UNAVAILABLE",
	);
}

/** Refuse a node listing over the count or byte caps, from the listed sizes alone. */
function assertWithinReadCaps(files: readonly TreeBlob[]): void {
	if (files.length > limits.maxNodeFiles)
		throw new KnowledgeCheckUnavailable(
			`${KNOWLEDGE_DIR}/ holds ${files.length} node files, over the check's limit of ${limits.maxNodeFiles}`,
		);
	let bytes = 0;
	for (const file of files) {
		bytes += file.size;
		if (bytes > limits.maxNodeBytes)
			throw new KnowledgeCheckUnavailable(
				`${KNOWLEDGE_DIR}/ holds more than ${limits.maxNodeBytes} bytes of node files (${file.path} is ${file.size} bytes), over the check's limit`,
			);
	}
}

/** Read and parse the node blobs of the head; call it only after {@link assertWithinReadCaps}. */
async function readNodes(git: TeamGit, files: readonly TreeBlob[]): Promise<KnowledgeNode[]> {
	const nodes: KnowledgeNode[] = [];
	for (let start = 0; start < files.length; start += READ_CONCURRENCY) {
		const batch = files.slice(start, start + READ_CONCURRENCY);
		const texts = await Promise.all(
			batch.map(async (file) => ({
				file: file.path,
				text: await git.readBlob(file.oid, file.size),
			})),
		);
		for (const { file, text } of texts) {
			// A Markdown file without a node header anchors nothing (`check` reports it).
			const node = parseNode(file, text);
			if (node) nodes.push(node);
		}
	}
	return nodes;
}

function staleDetails(head: string, mergeBase: string, gaps: KnowledgeGaps): KnowledgeStaleDetails {
	return {
		head,
		mergeBase,
		nodes: gaps.nodes.slice(0, KNOWLEDGE_STALE_LIST_MAX).map((node) => ({
			file: node.file,
			files: node.files.slice(0, KNOWLEDGE_STALE_FILES_PER_NODE),
			moreFiles: Math.max(0, node.files.length - KNOWLEDGE_STALE_FILES_PER_NODE),
		})),
		moreNodes: Math.max(0, gaps.nodes.length - KNOWLEDGE_STALE_LIST_MAX),
		uncovered: gaps.uncovered.slice(0, KNOWLEDGE_STALE_LIST_MAX),
		moreUncovered: Math.max(0, gaps.uncovered.length - KNOWLEDGE_STALE_LIST_MAX),
	};
}

/** A few names for the message, the rest counted ("a, b and 4 more"). */
function sample(names: readonly string[], shown = 2): string {
	const head = names.slice(0, shown).join(", ");
	return names.length > shown ? `${head} and ${names.length - shown} more` : head;
}

function staleError(itemId: string, gaps: KnowledgeGaps, details: KnowledgeStaleDetails) {
	const parts: string[] = [];
	if (gaps.nodes.length > 0)
		parts.push(
			`${gaps.nodes.length} node(s) anchor code this branch changed but were not updated in it (${sample(gaps.nodes.map((node) => node.file))})`,
		);
	if (gaps.uncovered.length > 0)
		parts.push(
			`${gaps.uncovered.length} added source file(s) have no node anchoring them (${sample(gaps.uncovered)})`,
		);
	return new AppError(
		`Work item ${itemId} leaves the knowledge tree stale: ${parts.join("; ")}. Nothing was marked. Send the worker back: update each node in details.nodes from the code (or, after checking it still holds, bump only its verified_at), anchor each file in details.uncovered in the node that covers it, commit, then call work.ready again.`,
		409,
		"TEAM_WORK_ITEM_KNOWLEDGE_STALE",
		undefined,
		details,
	);
}

/**
 * Refuse readiness when the branch at `head` leaves the knowledge tree stale (see the module
 * comment). `head` is the commit `work.ready` pinned; the worktree's files are never read, only
 * git objects. Resolves when there is no tree or nothing is stale; throws
 * `TEAM_WORK_ITEM_KNOWLEDGE_STALE` or `TEAM_KNOWLEDGE_CHECK_UNAVAILABLE` otherwise.
 */
export async function assertKnowledgeFresh(input: {
	itemId: string;
	worktree: string;
	head: string;
	baseRef: string;
}): Promise<KnowledgeCheckResult> {
	const git = teamGit(input.worktree);
	const head = input.head;
	let gaps: KnowledgeGaps;
	let mergeBase: string;
	let nodeCount: number;
	try {
		// The marker first, by its exact path: a large knowledge/ without it is never listed.
		const marker = await git.treeEntry(head, KNOWLEDGE_INDEX);
		const isRegularFile =
			marker?.type === "blob" && (marker.mode === "100644" || marker.mode === "100755");
		if (!isRegularFile) return { checked: false };
		const files = (await git.treeBlobs(head, `${KNOWLEDGE_DIR}/`)).filter((file) =>
			isNodeFile(file.path),
		);
		assertWithinReadCaps(files);
		const changes = await git.branchFileChanges(input.baseRef, head);
		if (!changes)
			throw new KnowledgeCheckUnavailable(
				`the base ${input.baseRef} does not resolve to a commit sharing history with the branch`,
			);
		mergeBase = changes.mergeBase;
		const nodes = await readNodes(git, files);
		nodeCount = nodes.length;
		const index = indexAnchors(nodes);
		const tests = (changes.changed.length + changes.added.length) * index.patternAnchors;
		if (tests > limits.maxMatchTests)
			throw new KnowledgeCheckUnavailable(
				`${changes.changed.length} changed files against ${index.patternAnchors} directory or glob anchors is more matching than the check does`,
			);
		gaps = knowledgeGaps(nodes, changes.changed, changes.added, index);
	} catch (error) {
		// A KnowledgeCheckUnavailable, a GitError from team-git, or anything else: never a pass.
		const reason = error instanceof Error ? error.message : String(error);
		throw unavailable(input.itemId, reason.slice(0, 300));
	}
	if (gaps.nodes.length > 0 || gaps.uncovered.length > 0)
		throw staleError(input.itemId, gaps, staleDetails(head, mergeBase, gaps));
	return { checked: true, head, nodeCount };
}
