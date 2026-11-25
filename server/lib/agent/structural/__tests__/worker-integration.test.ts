import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { grammarCachePath } from "../grammar-store";
import { invalidateParser } from "../index";
import type { StructDocument } from "../provider";
import {
	clearOutlineCache,
	referenceCounts,
	referenceLines,
	treeSitterProvider,
} from "../tree-sitter-provider";
import {
	closeStructuralWorkers,
	runStructuralTask,
	verifyStructuralGrammar,
} from "../worker-client";
import { ensureGrammarFixture } from "./grammar-fixture";

const execute = promisify(execFile);
const hasTypescript = ensureGrammarFixture("typescript");
const hasTsx = ensureGrammarFixture("tsx");
const withTypescript = hasTypescript ? describe : describe.skip;
const withTsx = hasTsx ? describe : describe.skip;

const SOURCE = `import { render as draw } from "./renderer";
export class Service {
	run(input: number): number {
		return input + input;
	}
}
export function helper(value: number): number {
	return draw(value);
}
`;

function document(text = SOURCE): StructDocument {
	return { filePath: "/integration/service.ts", languageId: "typescript", text };
}

/** Structured-cloneable alone is insufficient: Maps and WASM wrappers are not DTOs. */
function expectPlainData(value: unknown): void {
	if (value === null || value === undefined) return;
	if (typeof value !== "object") {
		expect(["string", "number", "boolean"]).toContain(typeof value);
		return;
	}
	if (Array.isArray(value)) {
		for (const child of value) expectPlainData(child);
		return;
	}
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	for (const child of Object.values(value)) expectPlainData(child);
}

beforeEach(() => {
	clearOutlineCache();
});

afterAll(async () => {
	await closeStructuralWorkers();
});

test("the synchronous parser core refuses a main-thread import", async () => {
	const core = new URL("../tree-sitter-core.ts", import.meta.url).href;
	const { stdout } = await execute(
		process.execPath,
		[
			"--eval",
			`try {
				await import(${JSON.stringify(core)});
				console.log(JSON.stringify({ rejected: false }));
			} catch (error) {
				console.log(JSON.stringify({ rejected: true, message: String(error.message) }));
			}`,
		],
		{ timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env } },
	);
	const result = JSON.parse(stdout.trim());
	expect(result.rejected).toBe(true);
	expect(result.message).toMatch(/requires a worker thread/i);
});

withTypescript("real structural worker", () => {
	test("preserves outline, location, imports and reference statistics as plain data", async () => {
		const doc = document();
		expect(await treeSitterProvider.supports(doc)).toBe("full");
		const outline = await treeSitterProvider.outline(doc);
		expect(
			outline.map(({ name, kind, startLine, endLine }) => ({ name, kind, startLine, endLine })),
		).toEqual([
			{ name: "Service", kind: "class", startLine: 2, endLine: 6 },
			{ name: "helper", kind: "function", startLine: 7, endLine: 9 },
		]);
		expect(outline[0]?.children?.map((node) => node.name)).toEqual(["run"]);
		expect(await treeSitterProvider.isOutlineTruncated?.(doc)).toBe(false);

		const located = await treeSitterProvider.locate(doc, { symbol: "Service.run" });
		expect(located).toHaveLength(1);
		expect(located[0]).toMatchObject({
			name: "run",
			kind: "method",
			symbolPath: "Service.run",
			startLine: 3,
			endLine: 5,
		});
		expect(SOURCE.slice(located[0]?.startIndex, located[0]?.endIndex)).toContain("input + input");
		const enclosing = await treeSitterProvider.enclosing(doc, { line: 4 });
		expect(enclosing.map((node) => node.symbolPath)).toEqual(["Service.run", "Service"]);

		const imports = await treeSitterProvider.imports?.(doc);
		if (!imports) throw new Error("Real worker did not return import metadata");
		expect(imports.imports).toEqual([
			{
				module: "./renderer",
				names: [{ local: "draw", original: "render" }],
				line: 1,
				form: "import_statement",
			},
		]);
		expect(imports?.exports.map((entry) => entry.name)).toEqual(["Service", "helper"]);
		const statistics = await treeSitterProvider.statistics?.(doc);
		if (!statistics) throw new Error("Real worker did not return reference statistics");
		expect(statistics.identifiers.find((entry) => entry.name === "input")).toMatchObject({
			count: 3,
			lines: [3, 4],
		});
		expect(statistics?.calls).toContainEqual({ name: "draw", count: 1 });
		expect(await referenceCounts(doc)).toEqual(
			new Map(statistics?.identifiers.map(({ name, count }) => [name, count])),
		);
		expect(await referenceLines(doc)).toEqual(
			new Map(
				statistics.identifiers.flatMap(({ name, lines }) =>
					lines ? [[name, lines] as const] : [],
				),
			),
		);

		// Exercise the actual request/reply protocol in addition to the public facade.
		expect(await runStructuralTask("outline", doc)).toEqual({ nodes: outline, truncated: false });
		expect(await runStructuralTask("locate", doc, { selector: { symbol: "Service.run" } })).toEqual(
			located,
		);
		expect(await runStructuralTask("imports", doc)).toEqual(imports);
		expect(await runStructuralTask("statistics", doc)).toEqual(statistics);
		for (const result of [outline, located, enclosing, imports, statistics]) {
			expectPlainData(result);
			expect(structuredClone(result)).toEqual(result);
		}
	});

	test("the worker core caches repeated outline and statistics without reparsing", async () => {
		const core = new URL("../tree-sitter-core.ts", import.meta.url).href;
		const parsers = new URL("../parser-pool.ts", import.meta.url).href;
		const worker = new Worker(
			`
			const { parentPort, workerData, threadId } = require("node:worker_threads");
			(async () => {
				const { handleStructuralRequest } = await import(${JSON.stringify(core)});
				const { acquireParser } = await import(${JSON.stringify(parsers)});
				const lease = await acquireParser("typescript");
				if (!lease.ok) throw new Error("TypeScript fixture did not load");
				let parses = 0;
				const parse = lease.parser.parse;
				lease.parser.parse = function (...args) {
					parses++;
					return parse.apply(this, args);
				};
				const outline = await handleStructuralRequest({ operation: "outline", doc: workerData });
				const cachedOutline = await handleStructuralRequest({ operation: "outline", doc: workerData });
				const afterOutline = parses;
				const statistics = await handleStructuralRequest({ operation: "statistics", doc: workerData });
				const cachedStatistics = await handleStructuralRequest({ operation: "statistics", doc: workerData });
				parentPort.postMessage({ threadId, afterOutline, afterStatistics: parses,
					sameOutline: JSON.stringify(outline) === JSON.stringify(cachedOutline),
					sameStatistics: JSON.stringify(statistics) === JSON.stringify(cachedStatistics) });
			})().catch(error => { throw error; });
		`,
			{ eval: true, workerData: document() },
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await new Promise<{
				threadId: number;
				afterOutline: number;
				afterStatistics: number;
				sameOutline: boolean;
				sameStatistics: boolean;
			}>((resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("Core cache probe timed out")), 15_000);
				worker.once("message", resolve);
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`Core cache probe exited: ${code}`)));
			});
			expect(result.threadId).toBeGreaterThan(0);
			expect(result.afterOutline).toBe(1);
			expect(result.afterStatistics).toBe(2);
			expect(result.sameOutline).toBe(true);
			expect(result.sameStatistics).toBe(true);
		} finally {
			clearTimeout(timeout);
			await worker.terminate();
		}
	}, 30_000);

	for (const fault of [
		{
			name: "grammar engine load failure rejects supports instead of degrading",
			kind: "language-load",
			operation: "supports",
			message: /Structural grammar runtime could not be loaded/,
		},
		{
			name: "a parser returning no tree rejects outline instead of reporting empty success",
			kind: "null-tree",
			operation: "outline",
			message: /Structural parser returned no tree/,
		},
	] as const) {
		test(fault.name, async () => {
			const core = new URL("../tree-sitter-core.ts", import.meta.url).href;
			const parsers = new URL("../parser-pool.ts", import.meta.url).href;
			const runtime = new URL("../tree-sitter-runtime.ts", import.meta.url).href;
			const worker = new Worker(
				`
				const { parentPort, workerData, threadId } = require("node:worker_threads");
				(async () => {
					const { handleStructuralRequest } = await import(${JSON.stringify(core)});
					let injectedCalls = 0;
					if (workerData.fault === "language-load") {
						const { getTreeSitterRuntime } = await import(${JSON.stringify(runtime)});
						const runtime = await getTreeSitterRuntime();
						runtime.Language.load = async () => {
							injectedCalls++;
							throw new Error("injected language engine failure");
						};
					} else {
						const { acquireParser } = await import(${JSON.stringify(parsers)});
						const lease = await acquireParser("typescript");
						if (!lease.ok) throw new Error("TypeScript fixture did not load");
						lease.parser.parse = () => { injectedCalls++; return null; };
					}
					try {
						const value = await handleStructuralRequest({
							operation: workerData.operation, doc: workerData.doc
						});
						parentPort.postMessage({ rejected: false, threadId, injectedCalls, value });
					} catch (error) {
						parentPort.postMessage({ rejected: true, threadId, injectedCalls,
							name: error.name, message: error.message });
					}
				})().catch(error => { throw error; });
			`,
				{
					eval: true,
					workerData: { fault: fault.kind, operation: fault.operation, doc: document() },
				},
			);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await new Promise<{
					rejected: boolean;
					threadId: number;
					injectedCalls: number;
					name?: string;
					message?: string;
				}>((resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("Core failure probe timed out")), 15_000);
					worker.once("message", resolve);
					worker.once("error", reject);
					worker.once("exit", (code) => reject(new Error(`Core failure probe exited: ${code}`)));
				});
				expect(result.threadId).toBeGreaterThan(0);
				expect(result.injectedCalls).toBe(1);
				expect(result.rejected).toBe(true);
				expect(result.name).toBe("Error");
				expect(result.message).toMatch(fault.message);
			} finally {
				clearTimeout(timeout);
				await worker.terminate();
			}
		}, 30_000);
	}

	test("sequential outline and statistics requests reuse the same real worker thread", async () => {
		const workers = new Set<number>();
		const postMessage = Worker.prototype.postMessage;
		const posting = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			workers.add(this.threadId);
			return postMessage.apply(this, args);
		});
		try {
			const first = await treeSitterProvider.outline(document());
			await treeSitterProvider.statistics?.(document());
			expect(await treeSitterProvider.outline(document())).toEqual(first);
			await referenceLines(document());
			expect(workers.size).toBe(1);
			expect([...workers][0]).toBeGreaterThan(0);
		} finally {
			posting.mockRestore();
		}
	});

	test("cache keys distinguish equal-length documents with identical heads and tails", async () => {
		const head = `/*${"same head ".repeat(160)}*/\n`;
		const tail = `\n/*${"same tail ".repeat(160)}*/`;
		const first = document(`${head}export function alpha() { return alpha; }${tail}`);
		const second = document(`${head}export function bravo() { return bravo; }${tail}`);
		expect(first.text.length).toBe(second.text.length);
		expect(first.text.slice(0, 1024)).toBe(second.text.slice(0, 1024));
		expect(first.text.slice(-1024)).toBe(second.text.slice(-1024));
		expect((await treeSitterProvider.outline(first)).map((node) => node.name)).toEqual(["alpha"]);
		expect((await treeSitterProvider.outline(second)).map((node) => node.name)).toEqual(["bravo"]);
		const counts = await referenceCounts(second);
		expect(counts?.get("bravo")).toBe(2);
		expect(counts?.has("alpha")).toBe(false);
		expect((await treeSitterProvider.outline(first)).map((node) => node.name)).toEqual(["alpha"]);
	});

	test("main-thread heartbeat continues after a large parse request has actually been posted", async () => {
		// Warm up the reusable worker so startup alone cannot satisfy the heartbeat.
		expect(await treeSitterProvider.supports(document())).toBe("full");
		const text = Array.from(
			{ length: 4500 },
			(_, index) =>
				`export function item${index}(value: number): number {\n${" value = value + Math.abs(value % 17);\n".repeat(
					8,
				)} return value;\n}\n`,
		).join("");
		expect(Buffer.byteLength(text)).toBeLessThan(2 * 1024 * 1024);
		expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
		let posted = false;
		let settled = false;
		let ticksDuringRequest = 0;
		const postMessage = Worker.prototype.postMessage;
		const posting = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			posted = true;
			return postMessage.apply(this, args);
		});
		const heartbeat = setInterval(() => {
			if (posted && !settled) ticksDuringRequest++;
		}, 1);
		try {
			const outline = await treeSitterProvider.outline(document(text));
			settled = true;
			expect(posted).toBe(true);
			expect(outline.some((node) => node.name === "item0")).toBe(true);
			expect(ticksDuringRequest).toBeGreaterThanOrEqual(3);
		} finally {
			settled = true;
			clearInterval(heartbeat);
			posting.mockRestore();
		}
	}, 30_000);

	test("grammar verification parses real offline fixture bytes in the worker", async () => {
		const bytes = new Uint8Array(await readFile(grammarCachePath("typescript")));
		expect(await verifyStructuralGrammar(bytes)).toBeNull();
		expect(await verifyStructuralGrammar(new Uint8Array([0, 1, 2, 3]))).not.toBeNull();
	});

	for (const invalidation of ["index invalidateParser", "clearOutlineCache"] as const) {
		test(`${invalidation} discards loaded parsers after grammar deletion and replacement`, async () => {
			const path = grammarCachePath("typescript");
			const original = await readFile(path);
			const invalidate = (): void => {
				if (invalidation === "index invalidateParser") invalidateParser("typescript");
				else clearOutlineCache();
			};
			try {
				expect(await treeSitterProvider.supports(document())).toBe("full");
				await unlink(path);
				invalidate();
				expect(await treeSitterProvider.supports(document())).toBe("degraded");
				await writeFile(path, "invalid wasm integration fixture");
				invalidate();
				expect(await treeSitterProvider.supports(document())).toBe("degraded");
				await writeFile(path, original);
				invalidate();
				expect(await treeSitterProvider.supports(document())).toBe("full");
				expect(
					(await treeSitterProvider.outline(document())).some((node) => node.name === "Service"),
				).toBe(true);
			} finally {
				await writeFile(path, original);
				invalidate();
			}
		}, 30_000);
	}
});

withTsx("real TSX worker", () => {
	test("element tree preserves nesting, conditions and structural attributes", async () => {
		const doc: StructDocument = {
			filePath: "/integration/view.tsx",
			languageId: "tsx",
			text: `export function View() {\n return <Stack ref={rootRef}>\n  {ready && <Child key={id} />}\n </Stack>;\n}\n`,
		};
		expect(await treeSitterProvider.supports(doc)).toBe("full");
		const tree = await treeSitterProvider.elementTree?.(doc);
		if (!tree) throw new Error("Real worker did not return the element tree");
		expect(tree).toEqual([
			{
				name: "Stack",
				line: 2,
				endLine: 4,
				attributes: ["ref"],
				children: [{ name: "Child", line: 3, endLine: 3, attributes: ["key"], condition: "and" }],
			},
		]);
		expect(await runStructuralTask("elementTree", doc)).toEqual(tree);
		expectPlainData(tree);
		expect(JSON.stringify(tree)).not.toContain("rootRef");
	});
});
