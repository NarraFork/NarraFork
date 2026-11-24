/**
 * The pure rules of a repository knowledge tree (`knowledge/`), shared by the tool
 * (`scripts/knowledge.ts`) and the server's `work.ready` check (`teams/team-knowledge.ts`):
 * header parsing, anchor matching, which files count as source, and which nodes a change leaves
 * stale. Nothing here reads the disk or runs git; callers bring paths and file contents.
 *
 * Uses `Bun.Glob` for glob anchors, so it runs under Bun only (server and scripts, not the
 * browser bundle).
 */

export interface KnowledgeNode {
	/** Path relative to the repository root. */
	file: string;
	id: string;
	title: string;
	summary: string;
	status: string;
	anchors: string[];
	keywords: string[];
	body: string;
}

export const KNOWLEDGE_DIR = "knowledge";
/** The root node: a repository has a knowledge tree when this file exists. */
export const KNOWLEDGE_INDEX = `${KNOWLEDGE_DIR}/index.md`;
/** The tree's conventions: a Markdown file in the tree that is not a node. */
export const KNOWLEDGE_GUIDE = `${KNOWLEDGE_DIR}/README.md`;
/** Top-level directories whose files count as source for coverage. */
export const SOURCE_ROOTS = ["server", "frontend", "shared"] as const;
const SOURCE_FILE = /\.(ts|tsx|go)$/;
const NOT_SOURCE =
	/(__tests__|\.test\.|\.browser\.|\.fixture\.|\/fixtures?\/|\.d\.ts$|routeTree\.gen\.ts$)/;

/** Whether a repository path lies under one of the {@link SOURCE_ROOTS}. */
export function underSourceRoot(path: string): boolean {
	return SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`));
}

/** A test, fixture, declaration or generated file: never counted as source anywhere. */
export function isTestOrGenerated(path: string): boolean {
	return NOT_SOURCE.test(path);
}

/** A source file a node is expected to anchor: under a source root, a source extension, no test. */
export function isSourceFile(path: string): boolean {
	return underSourceRoot(path) && SOURCE_FILE.test(path) && !NOT_SOURCE.test(path);
}

/** Whether a repository path is a node file: Markdown under `knowledge/`, except the guide. */
export function isNodeFile(path: string): boolean {
	return path.startsWith(`${KNOWLEDGE_DIR}/`) && path.endsWith(".md") && path !== KNOWLEDGE_GUIDE;
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Parses the small YAML subset the headers use: `key: value`, `key: []`, `key:` + `  - item`. */
export function parseNode(file: string, raw: string): KnowledgeNode | null {
	// Checkouts with core.autocrlf have CRLF line endings.
	const text = raw.replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
	if (!m) return null;
	const fields: Record<string, string | string[]> = {};
	let list: string[] | null = null;
	for (const raw of m[1].split("\n")) {
		const item = /^ {2}- (.*)$/.exec(raw);
		if (item && list) {
			list.push(item[1].replace(/\s+#.*$/, "").trim());
			continue;
		}
		const kv = /^([a-z_]+):\s*(.*)$/.exec(raw);
		if (!kv) continue;
		const value = kv[2].replace(/\s+#.*$/, "").trim();
		if (value === "") {
			list = [];
			fields[kv[1]] = list;
		} else if (value === "[]") {
			list = null;
			fields[kv[1]] = [];
		} else {
			list = null;
			fields[kv[1]] = value;
		}
	}
	const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
	const arr = (k: string) => (Array.isArray(fields[k]) ? (fields[k] as string[]) : []);
	return {
		file,
		id: str("id"),
		title: str("title"),
		summary: str("summary"),
		status: str("status"),
		anchors: arr("anchors"),
		keywords: arr("keywords"),
		body: text.slice(m[0].length),
	};
}

// ── anchors ──────────────────────────────────────────────────────────────────

/** An anchor is a file, a directory (trailing `/`) or a glob; `path#Symbol` narrows to a symbol. */
export function anchorPath(anchor: string): string {
	return anchor.replace(/#.*$/, "");
}

export function anchorMatches(anchor: string, path: string): boolean {
	const a = anchorPath(anchor);
	if (a.endsWith("/")) return path.startsWith(a);
	if (/[*?[{]/.test(a)) return new Bun.Glob(a).match(path);
	return path === a;
}

/**
 * The anchors of many nodes compiled once: exact paths in a map, directories and globs in a
 * list. Matching one path costs a map lookup plus one test per pattern anchor, so a caller can
 * bound the work by (paths × pattern anchors) up front.
 */
export interface AnchorIndex {
	/** Indexes into the node list of every node one of whose anchors matches `path`. */
	nodesMatching(path: string): number[];
	patternAnchors: number;
}

export function indexAnchors(nodes: readonly KnowledgeNode[]): AnchorIndex {
	const exact = new Map<string, number[]>();
	const patterns: Array<{ test: (path: string) => boolean; node: number }> = [];
	nodes.forEach((node, index) => {
		for (const anchor of node.anchors) {
			const a = anchorPath(anchor);
			if (a.endsWith("/")) patterns.push({ test: (p) => p.startsWith(a), node: index });
			else if (/[*?[{]/.test(a)) {
				const glob = new Bun.Glob(a);
				patterns.push({ test: (p) => glob.match(p), node: index });
			} else {
				const list = exact.get(a);
				if (list) list.push(index);
				else exact.set(a, [index]);
			}
		}
	});
	return {
		patternAnchors: patterns.length,
		nodesMatching(path) {
			const hit = new Set(exact.get(path) ?? []);
			for (const pattern of patterns)
				if (!hit.has(pattern.node) && pattern.test(path)) hit.add(pattern.node);
			return [...hit];
		},
	};
}

// ── what a branch leaves stale ───────────────────────────────────────────────

export interface KnowledgeGaps {
	/** Nodes whose anchored code changed while the node file did not, with the files that hit. */
	nodes: Array<{ file: string; files: string[] }>;
	/** Added source files no node anchors. */
	uncovered: string[];
}

/**
 * What a branch leaves stale in the tree as it is at the branch head (`nodes`):
 *
 * - every node one of whose anchors matches a `changed` path, unless the node file itself is in
 *   `changed` (touching the node counts, even if only `verified_at` moved);
 * - every `added` source file ({@link isSourceFile}) that no node anchors.
 *
 * `changed` holds every path the branch changed, both sides of a rename included; `added` only
 * the paths it added (the new side of a rename is one). Both outputs are sorted. Pass `index`
 * when the caller already built it from the same `nodes` (to bound the work first).
 */
export function knowledgeGaps(
	nodes: readonly KnowledgeNode[],
	changed: readonly string[],
	added: readonly string[],
	index: AnchorIndex = indexAnchors(nodes),
): KnowledgeGaps {
	const touched = new Set(changed);
	const hits = new Map<number, string[]>();
	for (const path of changed)
		for (const node of index.nodesMatching(path)) {
			const list = hits.get(node);
			if (list) list.push(path);
			else hits.set(node, [path]);
		}
	const stale: KnowledgeGaps["nodes"] = [];
	for (const [node, files] of hits) {
		const file = nodes[node]?.file;
		if (file === undefined || touched.has(file)) continue;
		stale.push({ file, files: [...new Set(files)].sort() });
	}
	stale.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	const uncovered = added
		.filter((f) => isSourceFile(f) && index.nodesMatching(f).length === 0)
		.sort();
	return { nodes: stale, uncovered };
}
