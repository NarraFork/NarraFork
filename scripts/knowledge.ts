#!/usr/bin/env bun
/**
 * Repository knowledge tree (`knowledge/`): find nodes, see what a change affects, list stale
 * nodes, measure coverage, and check the tree's shape.
 *
 *   bun scripts/knowledge.ts find <term…|path>   nodes for a feature name, identifier or code path
 *   bun scripts/knowledge.ts affected [base]      nodes whose anchors a change touches (default base: origin/main)
 *   bun scripts/knowledge.ts stale                nodes whose anchored code changed after the node's last commit
 *   bun scripts/knowledge.ts coverage [--list]    source files no node anchors
 *   bun scripts/knowledge.ts check                headers, ids, anchors, links and child lists (exit 1 on errors)
 *
 * Freshness is computed from git alone, so it works on any branch and worktree: a node is stale
 * when a commit after the node file's last commit touches one of its anchors.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

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

const KNOWLEDGE_DIR = "knowledge";
const STATUSES = new Set(["stub", "draft", "verified"]);
const SOURCE_ROOTS = ["server", "frontend", "shared"];
const SOURCE_FILE = /\.(ts|tsx|go)$/;
/** An anchor matching more source files than this is too broad to locate or date anything. */
export const BROAD_ANCHOR_FILES = 40;
const NOT_SOURCE =
	/(__tests__|\.test\.|\.browser\.|\.fixture\.|\/fixtures?\/|\.d\.ts$|routeTree\.gen\.ts$)/;

// ── git ──────────────────────────────────────────────────────────────────────

function git(root: string, args: string[]): string {
	const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
	return r.stdout.toString();
}

function lines(s: string): string[] {
	return s.split("\n").filter((l) => l.length > 0);
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

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith(".md")) out.push(p);
	}
	return out;
}

/** A native relative path as the repository path every node uses: forward slashes everywhere. */
export function repoPath(nativeRelative: string, separator: string = sep): string {
	return nativeRelative.split(separator).join("/");
}

/**
 * Loads every node under `knowledge/`. Paths are repository-relative with forward slashes on
 * every platform. Markdown files that do not parse as a node are collected in `invalid`.
 */
export function loadNodes(root: string, invalid: string[] = []): KnowledgeNode[] {
	const dir = join(root, KNOWLEDGE_DIR);
	if (!existsSync(dir)) return [];
	const nodes: KnowledgeNode[] = [];
	for (const abs of walk(dir).sort()) {
		const file = repoPath(relative(root, abs));
		if (file === `${KNOWLEDGE_DIR}/README.md`) continue;
		const node = parseNode(file, readFileSync(abs, "utf8"));
		if (node) nodes.push(node);
		else invalid.push(file);
	}
	return nodes;
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

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * Whether a field contains a search term. Plain ASCII words match on word boundaries, so a short
 * term such as `OLED` does not match inside `pooled`; other terms (CJK, paths, identifiers with
 * punctuation) match as substrings.
 */
export function termIn(value: string, term: string): boolean {
	if (/^[A-Za-z][A-Za-z0-9]*$/.test(term)) {
		return new RegExp(`(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)`, "i").test(value);
	}
	return value.toLowerCase().includes(term.toLowerCase());
}

export interface FindHit {
	node: KnowledgeNode;
	score: number;
	why: string[];
}

/** Text terms match id, title, keywords, summary, anchors and body; a path term matches anchors. */
export function find(nodes: KnowledgeNode[], terms: string[]): FindHit[] {
	const isPath = terms.length === 1 && /[/.]/.test(terms[0]) && !/\s/.test(terms[0]);
	const hits: FindHit[] = [];
	for (const node of nodes) {
		let score = 0;
		const why: string[] = [];
		if (isPath) {
			const p = terms[0].replace(/^\.\//, "");
			for (const a of node.anchors) {
				const ap = anchorPath(a);
				if (anchorMatches(a, p) || ap.startsWith(p.endsWith("/") ? p : `${p}/`)) {
					score += ap === p ? 10 : 6;
					why.push(`anchor ${a}`);
				}
			}
			// The node whose body talks about the file explains it; the others only anchor it.
			const base = p.split("/").filter(Boolean).pop() ?? p;
			const mentions = score > 0 ? node.body.split(base).length - 1 : 0;
			if (mentions > 0) {
				score += 4 + Math.min(mentions, 6);
				why.push(`body~${base}×${mentions}`);
			}
		}
		const fields: Array<[string, string, number]> = [
			["id", node.id, 5],
			["title", node.title, 5],
			["keywords", node.keywords.join(" "), 4],
			["summary", node.summary, 3],
			["anchors", node.anchors.join(" "), 2],
			["body", node.body, 1],
		];
		// Each term scores by the strongest field it appears in; nodes matching more terms rank first.
		let matched = 0;
		for (const term of terms) {
			const field = fields.find(([, v]) => termIn(v, term));
			if (!field) continue;
			matched++;
			score += field[2];
			why.push(`${field[0]}~${term}`);
		}
		// Matching every term counts only when a term hit more than body text.
		if (terms.length > 1 && matched === terms.length && why.some((w) => !w.startsWith("body~")))
			score += 10;
		if (score > 0) hits.push({ node, score, why });
	}
	return hits.sort((a, b) => b.score - a.score || a.node.file.localeCompare(b.node.file));
}

export interface StaleNode {
	node: KnowledgeNode;
	commits: string[];
	files: string[];
}

/** Nodes whose anchored code changed in a commit after the node file's last commit. */
export function stale(root: string, nodes: KnowledgeNode[]): StaleNode[] {
	const dirty = new Set(lines(git(root, ["status", "--porcelain"])).map((l) => l.slice(3)));
	// Each commit since a node's last commit, with every path it touched. Paths come from git
	// itself, so deletions and both sides of a rename are included, and anchors (globs with
	// braces too) are matched against them directly.
	const history = new Map<string, Array<{ commit: string; files: string[] }>>();
	const commitsSince = (since: string) => {
		let entries = history.get(since);
		if (!entries) {
			entries = [];
			// --diff-merges=combined: a merge reports the paths its result changed relative to every
			// parent (conflict resolutions, edits made in the merge), not the branches it brings in.
			const out = git(root, [
				"log",
				"--format=@@%H",
				"--name-only",
				"--no-renames",
				"--diff-merges=combined",
				`${since}..HEAD`,
			]);
			for (const l of lines(out)) {
				if (l.startsWith("@@")) entries.push({ commit: l.slice(2), files: [] });
				else entries[entries.length - 1]?.files.push(l);
			}
			history.set(since, entries);
		}
		return entries;
	};
	const out: StaleNode[] = [];
	for (const node of nodes) {
		if (node.anchors.length === 0 || dirty.has(node.file)) continue;
		const since = git(root, ["log", "-1", "--format=%H", "--", node.file]).trim();
		if (!since) continue;
		const commits: string[] = [];
		const files = new Set<string>();
		for (const entry of commitsSince(since)) {
			const hit = entry.files.filter((f) => node.anchors.some((a) => anchorMatches(a, f)));
			if (hit.length === 0) continue;
			commits.push(entry.commit);
			for (const f of hit) files.add(f);
		}
		if (commits.length > 0) out.push({ node, commits, files: [...files].sort() });
	}
	return out;
}

export interface Affected {
	nodes: Array<{ node: KnowledgeNode; files: string[] }>;
	/** Changed source files that no node anchors. */
	unanchored: string[];
}

export function affected(
	nodes: KnowledgeNode[],
	changed: string[],
	exists?: (path: string) => boolean,
): Affected {
	const result: Affected = { nodes: [], unanchored: [] };
	const covered = new Set<string>();
	for (const node of nodes) {
		const files = changed.filter((f) => node.anchors.some((a) => anchorMatches(a, f)));
		if (files.length > 0) {
			result.nodes.push({ node, files });
			for (const f of files) covered.add(f);
		}
	}
	result.unanchored = changed.filter(
		(f) =>
			!covered.has(f) &&
			// The old side of a rename is kept to match nodes, but nothing can anchor a gone file.
			(exists === undefined || exists(f)) &&
			SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)) &&
			SOURCE_FILE.test(f) &&
			!NOT_SOURCE.test(f),
	);
	return result;
}

export function changedFiles(root: string, base: string): string[] {
	// --no-renames keeps the old path of a rename, so nodes anchored to it are reported.
	// Knowledge files stay in: a node may anchor them (the tree's own guide does).
	const files = new Set<string>([
		...lines(git(root, ["diff", "--name-only", "--no-renames", `${base}...HEAD`])),
		...lines(git(root, ["diff", "--name-only", "--no-renames", "HEAD"])),
		...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
	]);
	return [...files].sort();
}

export function coverage(
	root: string,
	nodes: KnowledgeNode[],
): { total: number; uncovered: string[] } {
	const source = sourceFiles(root);
	const broad = new Set(broadAnchors(source, nodes).map((b) => b.anchor));
	const anchors = nodes.flatMap((n) => n.anchors).filter((a) => !broad.has(a));
	const uncovered = source.filter((f) => !anchors.some((a) => anchorMatches(a, f)));
	return { total: source.length, uncovered };
}

export function sourceFiles(root: string): string[] {
	return lines(git(root, ["ls-files", "--", ...SOURCE_ROOTS])).filter(
		(f) => SOURCE_FILE.test(f) && !NOT_SOURCE.test(f),
	);
}

/** Anchors that match more than {@link BROAD_ANCHOR_FILES} source files. */
function otherFiles(): string[] {
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
	return lines(git(root, ["ls-files"])).filter(
		(f) => !SOURCE_ROOTS.some((r) => f.startsWith(`${r}/`)) && !NOT_SOURCE.test(f),
	);
}

export function broadAnchors(
	source: string[],
	nodes: KnowledgeNode[],
): Array<{ node: KnowledgeNode; anchor: string; count: number }> {
	const out: Array<{ node: KnowledgeNode; anchor: string; count: number }> = [];
	let others: string[] | undefined;
	for (const node of nodes)
		for (const anchor of node.anchors) {
			// Outside the source roots (scripts/, .github/, …) every tracked non-test file counts.
			let pool = source;
			if (!SOURCE_ROOTS.some((r) => anchorPath(anchor).startsWith(`${r}/`))) {
				others ??= otherFiles();
				pool = others;
			}
			const count = pool.filter((f) => anchorMatches(anchor, f)).length;
			if (count > BROAD_ANCHOR_FILES) out.push({ node, anchor, count });
		}
	return out;
}

export function check(root: string, nodes: KnowledgeNode[], invalid: string[] = []): string[] {
	const errors: string[] = invalid.map(
		(f) => `${f}: no node header (--- id/title/summary/anchors/status ---)`,
	);
	const tracked = lines(git(root, ["ls-files"]));
	for (const b of broadAnchors(sourceFiles(root), nodes))
		errors.push(`${b.node.file}: anchor too broad (${b.count} source files): ${b.anchor}`);
	const ids = new Map<string, string>();
	for (const n of nodes) {
		for (const k of ["id", "title", "summary", "status"] as const)
			if (!n[k]) errors.push(`${n.file}: missing ${k}`);
		if (n.status && !STATUSES.has(n.status)) errors.push(`${n.file}: unknown status ${n.status}`);
		if (ids.has(n.id)) errors.push(`${n.file}: id ${n.id} also used by ${ids.get(n.id)}`);
		ids.set(n.id, n.file);
		for (const a of n.anchors) {
			const p = anchorPath(a);
			const exists = p.endsWith("/")
				? tracked.some((f) => f.startsWith(p))
				: tracked.some((f) => anchorMatches(p, f)) || existsSync(join(root, p));
			if (!exists) errors.push(`${n.file}: anchor matches nothing: ${a}`);
		}
		for (const [, href] of n.body.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
			if (/^[a-z]+:/.test(href)) continue;
			if (!existsSync(join(root, posix.normalize(posix.join(posix.dirname(n.file), href)))))
				errors.push(`${n.file}: broken link ${href}`);
		}
	}
	// Every node directory has an index.md that lists each child.
	for (const n of nodes) {
		if (n.file === `${KNOWLEDGE_DIR}/index.md`) continue;
		const isIndex = n.file.endsWith("/index.md");
		const parentDir = isIndex ? posix.dirname(posix.dirname(n.file)) : posix.dirname(n.file);
		const parentIndex = posix.join(parentDir, "index.md");
		const parent = nodes.find((p) => p.file === parentIndex);
		if (!parent) {
			errors.push(`${n.file}: no ${parentIndex}`);
			continue;
		}
		const rel = posix.relative(parentDir, n.file);
		if (!parent.body.includes(`](${rel})`)) errors.push(`${parentIndex}: child not listed: ${rel}`);
	}
	return errors;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function repoRoot(): string {
	return git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
}

function line(n: KnowledgeNode): string {
	return `${n.file}  ${n.title} — ${n.summary}`;
}

function main(argv: string[]): number {
	const [cmd, ...args] = argv;
	const root = repoRoot();
	const invalid: string[] = [];
	const nodes = loadNodes(root, invalid);
	switch (cmd) {
		case "find": {
			if (args.length === 0) {
				console.error("usage: find <term…|path>");
				return 2;
			}
			const hits = find(nodes, args).slice(0, 12);
			if (hits.length === 0) console.log("没有匹配的节点。");
			const staleIds = new Set(
				stale(
					root,
					hits.map((h) => h.node),
				).map((s) => s.node.id),
			);
			for (const h of hits)
				console.log(
					`${staleIds.has(h.node.id) ? "[过期] " : ""}${line(h.node)}\n    ${h.why.join(", ")}`,
				);
			return 0;
		}
		case "affected": {
			const base = args[0] ?? "origin/main";
			const res = affected(nodes, changedFiles(root, base), (f) => existsSync(join(root, f)));
			if (res.nodes.length === 0) console.log("这次改动没有碰到任何节点的锚点。");
			for (const { node, files } of res.nodes) {
				console.log(line(node));
				for (const f of files.slice(0, 8)) console.log(`    ${f}`);
				if (files.length > 8) console.log(`    …另 ${files.length - 8} 个文件`);
			}
			if (res.unanchored.length > 0) {
				console.log(`\n没有节点覆盖的改动文件（${res.unanchored.length}）：`);
				for (const f of res.unanchored.slice(0, 20)) console.log(`    ${f}`);
			}
			return 0;
		}
		case "stale": {
			const list = stale(root, nodes);
			if (list.length === 0) console.log("没有过期节点。");
			for (const s of list) {
				console.log(
					`${line(s.node)}\n    ${s.commits.length} 个提交改了：${s.files.slice(0, 6).join(", ")}${s.files.length > 6 ? " …" : ""}`,
				);
			}
			return 0;
		}
		case "coverage": {
			const { total, uncovered } = coverage(root, nodes);
			const pct = total === 0 ? 100 : Math.round(((total - uncovered.length) / total) * 100);
			console.log(`源文件 ${total} 个，有节点锚定 ${total - uncovered.length} 个（${pct}%）。`);
			const byDir = new Map<string, number>();
			for (const f of uncovered) {
				const d = f.split("/").slice(0, 3).join("/");
				byDir.set(d, (byDir.get(d) ?? 0) + 1);
			}
			const top = [...byDir].sort((a, b) => b[1] - a[1]);
			for (const [d, c] of args.includes("--list") ? top : top.slice(0, 15))
				console.log(`    ${c}\t${d}`);
			if (args.includes("--list")) for (const f of uncovered) console.log(f);
			return 0;
		}
		case "check": {
			const errors = check(root, nodes, invalid);
			for (const e of errors) console.error(e);
			console.log(
				errors.length === 0
					? `知识树检查通过（${nodes.length} 个节点）。`
					: `${errors.length} 个问题。`,
			);
			return errors.length === 0 ? 0 : 1;
		}
		default:
			console.error("usage: bun scripts/knowledge.ts find|affected|stale|coverage|check");
			return 2;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
