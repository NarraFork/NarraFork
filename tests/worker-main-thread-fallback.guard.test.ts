/** Worker failure must preserve its isolation boundary, never choose the same work on the host. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@babel/parser";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_ROOTS = [
	"server",
	"frontend",
	"shared",
	"scripts",
	"update-server",
	"vscode-extension",
];
const SKIP = new Set([
	"node_modules",
	"dist",
	"generated",
	"build",
	"out",
	".git",
	".worktrees",
	"__tests__",
	"__fixtures__",
	"fixtures",
]);
const RETIRED = new Set([
	"inlineFallback",
	"warnedInlineFallback",
	"INLINE_SLICE_ENVELOPES",
	"INLINE_SLICE_SOURCE_BYTES",
	"inlineIndexQueueReader",
	"loadShikiTokensOnMainThread",
]);
const CANDIDATE = new RegExp(`\\b(?:${[...RETIRED].join("|")})\\b`);

type Ast = Record<string, unknown>;
function node(value: unknown): Ast | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Ast)
		: null;
}
function walk(value: unknown, visit: (value: Ast) => void): void {
	if (Array.isArray(value)) {
		for (const child of value) walk(child, visit);
		return;
	}
	const object = node(value);
	if (!object) return;
	if (typeof object.type === "string") visit(object);
	for (const [key, child] of Object.entries(object)) {
		if (!["loc", "start", "end", "comments", "tokens"].includes(key)) walk(child, visit);
	}
}
function ast(path: string, text = readFileSync(join(ROOT, path), "utf8")) {
	return parse(text, {
		sourceType: "unambiguous",
		plugins: path.endsWith("tsx") ? ["typescript", "jsx"] : ["typescript"],
	});
}
function* sourceFiles(directory: string): Generator<string> {
	for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(path);
		else if (
			/\.(?:[cm]?js|tsx?)$/.test(entry.name) &&
			!/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)
		)
			yield path;
	}
}
function unwrapped(value: unknown): Ast | null {
	let result = node(value);
	while (
		result &&
		[
			"TSAsExpression",
			"TSTypeAssertion",
			"TSNonNullExpression",
			"ParenthesizedExpression",
		].includes(String(result.type))
	)
		result = node(result.expression);
	return result;
}
function callName(value: Ast): string | undefined {
	const callee = unwrapped(value.callee);
	if (callee?.type === "Identifier") return String(callee.name);
	if (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") {
		const property = node(callee.property);
		const name =
			property?.type === "Identifier"
				? String(property.name)
				: property?.type === "StringLiteral"
					? String(property.value)
					: undefined;
		if (name && ["call", "apply", "bind"].includes(name))
			return callName({ callee: callee.object });
		return name;
	}
	return undefined;
}
function calls(tree: unknown): string[] {
	const result: string[] = [];
	walk(tree, (value) => {
		if (["CallExpression", "OptionalCallExpression"].includes(String(value.type))) {
			const name = callName(value);
			if (name) result.push(name);
		}
	});
	return result;
}

describe("worker execution isolation policy", () => {
	test("CLAUDE declares the repository-wide failure boundary and fault-injection requirement", () => {
		const rule = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
		for (const text of [
			"Worker 隔离不可降级",
			"禁止回退到服务主线程或浏览器 UI 线程执行原任务",
			"创建失败",
			"超时",
			"被禁用",
			"故障注入",
			"第三方组件也适用",
		])
			expect(rule).toContain(text);
	});

	test("retired failure-to-inline switches cannot return in production clients", () => {
		const violations: string[] = [];
		for (const directory of SOURCE_ROOTS)
			for (const path of sourceFiles(directory)) {
				const text = readFileSync(join(ROOT, path), "utf8");
				if (!CANDIDATE.test(text)) continue;
				walk(ast(path, text), (value) => {
					if (value.type === "Identifier" && RETIRED.has(String(value.name)))
						violations.push(`${path}: ${value.name}`);
				});
			}
		expect(violations).toEqual([]);
	}, 30_000);

	test("worker clients do not import or call their heavy task implementation on the host", () => {
		const boundaries: Record<string, string[]> = {
			"server/services/narrator-block-backfill.ts": [
				"runBlockBackfillSlice",
				"runBlockVerifySlice",
				"runBlockReindexSlice",
				"runBlockProjectionSlice",
			],
			"server/services/narrator-block-index.ts": ["runBlockIndexQueueSlice"],
			"server/lib/fs-scan-worker/client.ts": ["measureDirectoryTrees"],
			"frontend/lib/shiki-token-worker-client.ts": [
				"codeToTokens",
				"loadShikiTokensOnMainThread",
				"runFallback",
			],
			"frontend/lib/shiki-token-cache.ts": ["codeToTokens", "loadShikiTokensOnMainThread"],
		};
		for (const [path, banned] of Object.entries(boundaries)) {
			const tree = ast(path);
			expect(calls(tree).filter((name) => banned.includes(name))).toEqual([]);
			walk(tree, (value) => {
				if (value.type !== "ImportDeclaration" || value.importKind === "type") return;
				for (const specifier of value.specifiers as Ast[]) {
					if (specifier.importKind === "type") continue;
					const imported = node(specifier.imported);
					expect(banned).not.toContain(String(imported?.name ?? imported?.value));
				}
			});
		}
	});

	test("the ORM worker error path never executes the original query", () => {
		const tree = ast("server/db/worker-read.ts");
		const violations: string[] = [];
		walk(tree, (value) => {
			if (value.type !== "CatchClause") return;
			walk(value.body, (child) => {
				if (child.type === "AwaitExpression" && unwrapped(child.argument)?.name === "query")
					violations.push("await query");
				if (["CallExpression", "OptionalCallExpression"].includes(String(child.type))) {
					const callee = unwrapped(child.callee);
					if (unwrapped(callee?.object)?.name === "query") violations.push(String(callName(child)));
				}
			});
		});
		expect(violations).toEqual([]);
	});

	test("outline worker failures do not read a large structure inline", () => {
		const tree = ast("server/services/outline/store/sqlite-read.ts");
		walk(tree, (value) => {
			if (value.type === "CatchClause") expect(calls(value.body)).not.toContain("inlineValues");
		});
	});

	test("mindmap cold cache uses a placeholder instead of measuring on the UI thread", () => {
		const tree = ast("frontend/components/outline/mindmap/measure.ts");
		const found = new Set<string>();
		walk(tree, (value) => {
			const name = node(value.id)?.name;
			if (value.type === "FunctionDeclaration" && (name === "bodySize" || name === "measureKey")) {
				found.add(name);
				for (const heavy of ["measureBody", "parseToPM"])
					expect(calls(value.body)).not.toContain(heavy);
			}
		});
		expect([...found].sort()).toEqual(["bodySize", "measureKey"]);
	});

	test("the scanner catches disguised casts without treating comments as executable fallback", () => {
		const tree = ast(
			"self-check.ts",
			"async function read() { try { await worker(); } catch (e) { return await (query as Query); } } // inlineFallback",
		);
		let caught = false;
		walk(tree, (value) => {
			if (value.type === "AwaitExpression" && unwrapped(value.argument)?.name === "query")
				caught = true;
		});
		expect(caught).toBe(true);
		expect(calls(ast("alias.ts", "core['measureDirectoryTrees'].call(undefined);"))).toEqual([
			"measureDirectoryTrees",
		]);
		const commentOnly = ast("comment.ts", "// inlineFallback\nconst value = 'inlineFallback';");
		const retired: string[] = [];
		walk(commentOnly, (value) => {
			if (value.type === "Identifier" && RETIRED.has(String(value.name)))
				retired.push(String(value.name));
		});
		expect(retired).toEqual([]);
	});
});

test("Monaco installs its versioned strict failure boundary before exposing editor services", () => {
	const loader = ast("frontend/components/narrator/file-editor/monaco-loader.ts");
	let installedAt = Number.POSITIVE_INFINITY;
	let apiAt = Number.POSITIVE_INFINITY;
	walk(loader, (value) => {
		if (value.type === "CallExpression" && callName(value) === "installMonacoWorkerPolicy")
			installedAt = Number(value.start);
		const callee = node(value.callee);
		const source =
			value.type === "ImportExpression"
				? node(value.source)
				: value.type === "CallExpression" && callee?.type === "Import"
					? node((value.arguments as unknown[])[0])
					: null;
		if (
			source?.type === "StringLiteral" &&
			/editor\/editor\.api(?:\.js)?$/.test(String(source.value))
		)
			apiAt = Number(value.start);
	});
	expect(Number.isFinite(installedAt)).toBe(true);
	expect(Number.isFinite(apiAt)).toBe(true);
	expect(installedAt).toBeLessThan(apiAt);
	const installed = JSON.parse(
		readFileSync(join(ROOT, "node_modules/monaco-editor/package.json"), "utf8"),
	);
	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	expect(installed.version).toBe("0.56.0");
	expect(manifest.dependencies["monaco-editor"]).toBe(installed.version);
	const policyPath = "frontend/components/narrator/file-editor/monaco-worker-policy.ts";
	const text = readFileSync(join(ROOT, policyPath), "utf8");
	expect(text).toContain('MONACO_WORKER_POLICY_VERSION = "0.56.0"');
	let throws = false;
	walk(ast(policyPath, text), (value) => {
		if (value.type === "NewExpression")
			expect(["SynchronousWorkerClient", "EditorWorker"]).not.toContain(node(value.callee)?.name);
		if (value.type === "FunctionDeclaration" && node(value.id)?.name === "fallback") {
			walk(value.body, (child) => {
				if (child.type === "ThrowStatement") throws = true;
			});
		}
	});
	expect(throws).toBe(true);
});
