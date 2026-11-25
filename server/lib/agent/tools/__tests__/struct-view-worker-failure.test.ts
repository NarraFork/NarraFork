import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExecutionBackend } from "../../execution/backend";
import { posixPathSemantics } from "../../execution/path-semantics";
import { treeSitterProvider } from "../../structural";
import type { OutlineNode, StructDocument } from "../../structural/provider";
import { StructuralWorkerError } from "../../structural/worker-protocol";
import type { ToolContext } from "../../types";
import { structViewTool } from "../struct-view";

const cwd = "/virtual/struct-view-worker-failure";
const definition = `${cwd}/definition.ts`;
const candidate = `${cwd}/candidate.ts`;
const barrel = `${cwd}/barrel.ts`;
const originalProvider = { ...treeSitterProvider };
const declaration: OutlineNode = {
	kind: "function",
	name: "target",
	startLine: 1,
	endLine: 1,
	depth: 0,
	exported: true,
};
const sources = new Map([
	[definition, "export function target() { return 1; }"],
	[candidate, 'import { target } from "./definition"; target();'],
	[barrel, 'export { target } from "./definition";'],
]);
let failure: { operation: string; path: string; error: Error } | undefined;
let calls: Array<{ operation: string; path: string }>;
let readFailures: Set<string>;
let statFailure: { path: string; error: Error } | undefined;
let candidatePaths: string[];
let throughBarrel: boolean;

function observe(operation: string, doc: StructDocument): void {
	calls.push({ operation, path: doc.filePath });
	if (failure?.operation === operation && failure.path === doc.filePath) throw failure.error;
}

const backend = {
	kind: "local",
	deviceId: "local",
	pathFlavor: "posix",
	paths: posixPathSemantics,
	async statFile(path: string) {
		if (statFailure?.path === path) throw statFailure.error;
		return sources.has(path) ? { isDirectory: false } : null;
	},
	async readFileBytes(path: string) {
		if (readFailures.has(path)) throw new Error("Fixture file could not be read");
		const text = sources.get(path);
		if (text === undefined) throw new Error("Fixture file does not exist");
		return { bytes: new TextEncoder().encode(text), truncated: false };
	},
	async grep() {
		return {
			stdoutBytes: new TextEncoder().encode(candidatePaths.join("\n")),
			truncatedByBytes: false,
		};
	},
} as unknown as ExecutionBackend;

function context(): ToolContext {
	return {
		narratorId: "worker-failure-test",
		cwd,
		locale: "en",
		signal: new AbortController().signal,
		resolveBackend: () => backend,
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

beforeEach(() => {
	failure = undefined;
	calls = [];
	readFailures = new Set();
	statFailure = undefined;
	candidatePaths = ["definition.ts", "candidate.ts"];
	throughBarrel = false;
	// Explicit provider fixtures exercise only tool error handling, never parser computation.
	treeSitterProvider.supports = (doc) => {
		observe("supports", doc);
		return "full";
	};
	treeSitterProvider.outline = async (doc) => {
		observe("outline", doc);
		return doc.filePath === definition ? [declaration] : [];
	};
	treeSitterProvider.isOutlineTruncated = async (doc) => {
		observe("truncated", doc);
		return false;
	};
	treeSitterProvider.locate = async (doc) => {
		observe("locate", doc);
		return [
			{
				kind: "function",
				name: "target",
				symbolPath: "target",
				startIndex: 0,
				endIndex: doc.text.length,
				startLine: 1,
				endLine: 1,
				exported: true,
			},
		];
	};
	treeSitterProvider.statistics = async (doc) => {
		observe("statistics", doc);
		return {
			identifiers: [{ name: "target", count: 1, lines: [1] }],
			calls: [],
			elements: [],
			truncated: false,
		};
	};
	treeSitterProvider.imports = async (doc) => {
		observe("imports", doc);
		return doc.filePath === barrel
			? {
					imports: [],
					exports: [{ name: "target", kind: "function", line: 1, from: "./definition" }],
				}
			: {
					imports: [
						{
							module: throughBarrel ? "./barrel" : "./definition",
							names: [{ local: "target" }],
							line: 1,
						},
					],
					exports: [],
				};
	};
});
afterEach(() => {
	Object.assign(treeSitterProvider, originalProvider);
});

async function assertOriginalWorkerFailure(
	args: Record<string, unknown>,
	error: StructuralWorkerError,
) {
	await expect(structViewTool.execute(args, context())).rejects.toBe(error);
}

describe("StructView worker failures stay fail-closed", () => {
	for (const code of [
		"STRUCTURAL_WORKER_TIMEOUT",
		"STRUCTURAL_WORKER_EXITED",
		"STRUCTURAL_WORKER_STALE",
	] as const) {
		test(`usages propagates candidate statistics ${code} after resolving the definition`, async () => {
			const error = new StructuralWorkerError(code);
			failure = { operation: "statistics", path: candidate, error };
			await assertOriginalWorkerFailure(
				{ file_path: "definition.ts", mode: "usages", symbol: "target" },
				error,
			);
			expect(calls).toContainEqual({ operation: "locate", path: definition });
			expect(calls).toContainEqual({ operation: "statistics", path: candidate });
		});

		test(`find propagates candidate outline ${code}, not unreadable/no-declaration success`, async () => {
			const error = new StructuralWorkerError(code);
			failure = { operation: "outline", path: candidate, error };
			await assertOriginalWorkerFailure({ mode: "find", symbol: "target" }, error);
			expect(calls.filter((call) => call.operation === "outline").map((call) => call.path)).toEqual(
				[definition, candidate],
			);
		});
	}

	test("usages does not convert candidate import worker failure to unverified success", async () => {
		const error = new StructuralWorkerError("STRUCTURAL_WORKER_EXITED");
		failure = { operation: "imports", path: candidate, error };
		await assertOriginalWorkerFailure(
			{ file_path: "definition.ts", mode: "usages", symbol: "target" },
			error,
		);
		expect(calls).toContainEqual({ operation: "statistics", path: candidate });
	});

	test("usages propagates worker failure through both barrel and import classification catches", async () => {
		const error = new StructuralWorkerError("STRUCTURAL_WORKER_STALE");
		throughBarrel = true;
		failure = { operation: "imports", path: barrel, error };
		await assertOriginalWorkerFailure(
			{ file_path: "definition.ts", mode: "usages", symbol: "target" },
			error,
		);
		expect(calls).toContainEqual({ operation: "imports", path: barrel });
	});

	test("barrel resolution preserves structural errors rather than trying another module spelling", async () => {
		const error = new StructuralWorkerError("STRUCTURAL_WORKER_EXITED");
		throughBarrel = true;
		statFailure = { path: barrel, error };
		await assertOriginalWorkerFailure(
			{ file_path: "definition.ts", mode: "usages", symbol: "target" },
			error,
		);
	});

	test("candidate provider resolution worker failure cannot become an unparsed file", async () => {
		const error = new StructuralWorkerError("STRUCTURAL_WORKER_TIMEOUT");
		failure = { operation: "supports", path: candidate, error };
		await assertOriginalWorkerFailure({ mode: "find", symbol: "target" }, error);
	});

	test("interface import grouping does not swallow worker failure", async () => {
		const error = new StructuralWorkerError("STRUCTURAL_WORKER_TIMEOUT");
		failure = { operation: "imports", path: definition, error };
		await assertOriginalWorkerFailure(
			{ file_path: "definition.ts", mode: "interface", address: "1" },
			error,
		);
		expect(calls).toContainEqual({ operation: "statistics", path: definition });
	});

	test("an ordinary unreadable usages candidate still yields partial matches", async () => {
		candidatePaths.push("unreadable.ts");
		readFailures.add(`${cwd}/unreadable.ts`);
		const result = await structViewTool.execute(
			{ file_path: "definition.ts", mode: "usages", symbol: "target" },
			context(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.files).toBe(1);
		expect(result.output).toContain("candidate.ts");
		expect(result.output).toContain("1 candidate(s) skipped");
	});

	test("an ordinary unreadable find candidate preserves parsed declarations and partial notes", async () => {
		readFailures.add(candidate);
		const result = await structViewTool.execute({ mode: "find", symbol: "target" }, context());
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.declarations).toBe(1);
		expect(result.output).toContain("definition.ts");
		expect(result.output).toContain("1 file(s) could not be read");
	});

	test("ordinary import inventory failure retains the established unverified match", async () => {
		failure = { operation: "imports", path: candidate, error: new Error("Unsupported inventory") };
		const result = await structViewTool.execute(
			{ file_path: "definition.ts", mode: "usages", symbol: "target" },
			context(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.files).toBe(1);
		expect(result.output).toContain("unverified —");
	});
});
