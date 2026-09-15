/**
 * StructSed tool-level tests.
 *
 * These cover the tool's GATES rather than its text arithmetic (that lives in
 * edit-ops.test.ts): address validation, the dry-run default, ambiguity reporting, and
 * the recorded input that replay depends on.
 *
 * Every case here runs without a tool-call binding, so the write path is deliberately
 * refused — which is itself one of the behaviours under test. The mutations are verified
 * through dry-run output plus the pure functions, so no test in this file writes a file.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGrammarFixture } from "../../structural/__tests__/grammar-fixture";
import type { ToolContext } from "../../types";
import { structSedTool } from "../struct-sed";

const TS_SOURCE = `export class PaymentService {
	/** Charge one order. */
	async charge(orderId: string): Promise<string> {
		return orderId;
	}

	refund(orderId: string): void {
		void orderId;
	}
}
`;

const PLAIN_SOURCE = "alpha\nbravo\ncharlie\ndelta\n";

let workDir: string;
let tsFile: string;
let plainFile: string;
let hasGrammar = false;

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "struct-sed-test-"));
	tsFile = join(workDir, "payment.ts");
	plainFile = join(workDir, "notes.txt");
	writeFileSync(tsFile, TS_SOURCE, "utf8");
	writeFileSync(plainFile, PLAIN_SOURCE, "utf8");
	hasGrammar = await ensureGrammarFixture("typescript");
});

function makeCtx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	return structSedTool.execute(args, makeCtx());
}

describe("registration", () => {
	test("is not marked read-only", () => {
		// A read-only flag would let it through plan mode and the read-only tool paths.
		expect(structSedTool.metadata?.readOnly).toBeFalsy();
	});

	test("routes as a write operation", () => {
		// A `read` routing would put this on the read path even for real mutations.
		const routing = structSedTool.executionRouting;
		expect(routing?.kind).toBe("single");
		if (routing?.kind !== "single") throw new Error("expected single routing");
		const request = routing.resolve({ file_path: "/tmp/x.ts", command: "delete" }, {} as never);
		expect(request && "operation" in request ? request.operation : null).toBe("write");
	});
});

describe("address validation", () => {
	test("both symbol and address is refused rather than guessed", () => {
		// Picking one silently could delete a different range than the model named.
		return run({
			file_path: plainFile,
			command: "delete",
			symbol: "charge",
			address: "1,2",
		}).then((result) => {
			expect(result.isError).toBe(true);
			expect(result.output).toContain("not both");
		});
	});

	test("neither is refused", async () => {
		const result = await run({ file_path: plainFile, command: "delete" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("address is required");
	});

	test("an unknown command is refused", async () => {
		const result = await run({ file_path: plainFile, command: "teleport", address: "1" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unknown command");
	});

	test("an invalid address reports the parse error", async () => {
		const result = await run({
			file_path: plainFile,
			command: "delete",
			address: "not-an-address",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Invalid address");
	});

	test("an address matching nothing is an error, not a silent no-op", async () => {
		const result = await run({ file_path: plainFile, command: "delete", address: "/zzz-absent/" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("matched nothing");
	});

	test("a missing file reports a read error", async () => {
		const result = await run({
			file_path: join(workDir, "absent.txt"),
			command: "delete",
			address: "1",
		});
		expect(result.isError).toBe(true);
	});
});

describe("dry run is the default", () => {
	test("no dry_run flag means preview, and nothing is written", async () => {
		const before = readFileSync(plainFile, "utf8");
		const result = await run({ file_path: plainFile, command: "delete", address: "2" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
		expect(result.metadata?.dryRun).toBe(true);
		expect(readFileSync(plainFile, "utf8")).toBe(before);
	});

	test("the preview reports the resolved range", async () => {
		const result = await run({ file_path: plainFile, command: "delete", address: "2,3" });
		expect(result.metadata?.startLine).toBe(2);
		expect(result.metadata?.endLine).toBe(3);
	});

	test("the preview shows before and after", async () => {
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "2",
			content: "BRAVO",
		});
		expect(result.output).toContain("Before:");
		expect(result.output).toContain("After:");
		expect(result.output).toContain("BRAVO");
	});

	test("the preview carries before/after text for the card's diff", async () => {
		// The card renders these as a real diff; the changed region plus context, numbered
		// from where it starts. The output text stays for the model.
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "2",
			content: "BRAVO",
		});
		expect(typeof result.metadata?.diffBefore).toBe("string");
		expect(typeof result.metadata?.diffAfter).toBe("string");
		expect(result.metadata?.diffBefore).toContain("bravo");
		expect(result.metadata?.diffAfter).toContain("BRAVO");
		expect(typeof result.metadata?.diffStartLine).toBe("number");
	});

	test("a change spanning the whole file omits the diff so the card keeps the preview", async () => {
		// A move from the top of a large file to the bottom would diff the entire file,
		// which is more overwhelming than the preview it would replace.
		const big = join(workDir, "big.txt");
		writeFileSync(big, Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n"), "utf8");
		const result = await run({
			file_path: big,
			command: "move",
			address: "1",
			to_address: "900",
			placement: "after",
		});
		expect(result.isError).toBeFalsy();
		expect(result.metadata?.diffBefore).toBeUndefined();
		expect(result.output).toContain("Before:");
	});

	test("substitute reports its replacement count", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1,$",
			pattern: "a",
			replacement: "A",
			flags: "g",
		});
		expect(typeof result.metadata?.replacements).toBe("number");
		expect(result.metadata?.replacements).toBeGreaterThan(0);
	});

	test("dry_run: false without a tool-call binding refuses to write", async () => {
		// Edit falls back to an unrecorded write here; StructSed does not. A structural
		// rewrite with no snapshot evidence cannot be reverted, and revert is exactly what
		// matters for the large edits this tool exists to make.
		const before = readFileSync(plainFile, "utf8");
		const result = await run({
			file_path: plainFile,
			command: "delete",
			address: "2",
			dry_run: false,
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("recorded tool call");
		expect(readFileSync(plainFile, "utf8")).toBe(before);
	});
});

describe("missing command arguments", () => {
	test("replace without content", async () => {
		const result = await run({ file_path: plainFile, command: "replace", address: "1" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `content`");
	});

	test("substitute without pattern", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1",
			replacement: "x",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires `pattern`");
	});

	test("an unsupported substitute flag is rejected", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1",
			pattern: "a",
			replacement: "b",
			flags: "gm",
		});
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Unsupported substitute flags");
	});
});

describe("no-op detection", () => {
	test("replacing content with itself reports no change", async () => {
		const result = await run({
			file_path: plainFile,
			command: "replace",
			address: "1",
			content: "alpha",
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No changes");
	});

	test("a substitute that matches nothing reports no change", async () => {
		const result = await run({
			file_path: plainFile,
			command: "substitute",
			address: "1,$",
			pattern: "zzz",
			replacement: "y",
		});
		expect(result.output).toContain("No changes");
	});
});

describe("structural addressing", () => {
	test("a symbol resolves to that declaration's range", async () => {
		if (!hasGrammar) return;
		const result = await run({
			file_path: tsFile,
			command: "delete",
			symbol: "PaymentService.charge",
		});
		expect(result.isError).toBeFalsy();
		// The method spans its doc comment's following lines through its closing brace.
		expect(result.metadata?.startLine).toBe(3);
		expect(result.metadata?.endLine).toBe(5);
	});

	test("a bare method name resolves without naming the class", async () => {
		if (!hasGrammar) return;
		const result = await run({ file_path: tsFile, command: "delete", symbol: "refund" });
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("DRY RUN");
	});

	test("an absent symbol points at StructView rather than failing blankly", async () => {
		if (!hasGrammar) return;
		const result = await run({ file_path: tsFile, command: "delete", symbol: "notThere" });
		expect(result.isError).toBe(true);
		expect(result.output).toContain("StructView");
	});

	test("replacing a method re-indents the content to the class body", async () => {
		if (!hasGrammar) return;
		const result = await run({
			file_path: tsFile,
			command: "replace",
			symbol: "refund",
			// Written at column 0; must land at the method indent in the preview.
			content: "voidRefund(): void {}",
		});
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("\tvoidRefund(): void {}");
	});

	test("a symbol on a file with no grammar suggests the address form", async () => {
		const result = await run({ file_path: plainFile, command: "delete", symbol: "alpha" });
		expect(result.isError).toBe(true);
		// notes.txt has no language, so the structural path cannot apply.
		expect(result.output).toMatch(/address|provider/i);
	});
});

describe("cleanup", () => {
	test("removes the temp workspace", () => {
		rmSync(workDir, { recursive: true, force: true });
		expect(true).toBe(true);
	});
});
