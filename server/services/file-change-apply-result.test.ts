import { describe, expect, test } from "bun:test";
import { localBackend } from "../lib/agent/execution/local-backend";
import { applyLocalFileChange } from "./file-change-apply-result";
import type {
	FileChangeLocalIo,
	LocalFileApplyInput,
	LocalFileApplyResult,
} from "./file-change-local-io";
import { normalizeLocalIoEvidence } from "./file-change-local-io-evidence";
import type { LocalWriteFootprint } from "./file-change-write-footprint";

const path = localBackend.paths.resolve(process.cwd(), "fake-range/file.txt");
const parent = localBackend.paths.dirname(path);
const footprint: LocalWriteFootprint = {
	anchor: process.cwd(),
	anchorIdentity: "fixture",
	ranges: [{ kind: "subtree", canonicalPath: parent }],
};
const input: LocalFileApplyInput = {
	backend: localBackend,
	canonicalPath: path,
	lexicalPath: path,
	before: { bytes: null, mode: null, identity: null },
	nextBytes: new Uint8Array(),
	signal: new AbortController().signal,
	assertTarget: async () => {},
	onDispatch() {},
};
const emptyParents = { createdPaths: [], possiblePaths: [] };
function ioResult(result: LocalFileApplyResult): FileChangeLocalIo {
	return { read: async () => input.before, apply: async () => result };
}

describe("runtime trusts explicit local IO stage proofs only", () => {
	test("bare EACCES or absent state is not evidence of no mutation", async () => {
		const io: FileChangeLocalIo = {
			read: async () => input.before,
			apply: async () => {
				throw Object.assign(new Error("wrapper failed after writing"), { code: "EACCES" });
			},
		};
		const summary = await applyLocalFileChange(io, input, footprint);
		expect(summary).toMatchObject({
			receiptOutcome: "unknown",
			confirmed: false,
			leaseOutcome: "unknown",
		});
	});

	test("completed parent creation does not pretend the target was applied", async () => {
		const summary = await applyLocalFileChange(
			ioResult({
				kind: "parent_only",
				error: new Error("target denied"),
				parentEffects: { createdPaths: [parent], possiblePaths: [] },
			}),
			input,
			footprint,
		);
		expect(summary).toMatchObject({
			receiptOutcome: "not_applied",
			confirmed: true,
			leaseOutcome: "not_applied",
			diagnostics: { outcome: "parent_only", createdParentCount: 1 },
		});
	});

	test("uncertain parent creation retains a barrier even when the target is not applied", async () => {
		const summary = await applyLocalFileChange(
			ioResult({
				kind: "parent_only",
				error: new Error("parent IO failed"),
				parentEffects: { createdPaths: [], possiblePaths: [parent] },
			}),
			input,
			footprint,
		);
		expect(summary).toMatchObject({
			receiptOutcome: "not_applied",
			confirmed: true,
			leaseOutcome: "unknown",
		});
	});

	test("parent effects outside the grant are never accepted as safe", async () => {
		const summary = await applyLocalFileChange(
			ioResult({
				kind: "parent_only",
				error: new Error("bad adapter"),
				parentEffects: { createdPaths: [process.cwd()], possiblePaths: [] },
			}),
			input,
			footprint,
		);
		expect(summary).toMatchObject({
			receiptOutcome: "unknown",
			confirmed: false,
			leaseOutcome: "unknown",
		});
		expect(String(summary.result.error)).toContain("escaped");
	});

	test("unsupported or missing results are conservative, never implicit applied", async () => {
		for (const result of [
			undefined,
			{ kind: "applied", parentEffects: emptyParents, error: new Error("close failed") },
			{
				kind: "not_applied",
				error: new Error("bad"),
				parentEffects: { createdPaths: [parent], possiblePaths: [] },
			},
		]) {
			const summary = await applyLocalFileChange(
				ioResult(result as LocalFileApplyResult),
				input,
				footprint,
			);
			expect(summary.leaseOutcome).toBe("unknown");
			expect(summary.confirmed).toBe(false);
		}
	});

	test("bounded receipt diagnostics reject hidden fields and invalid counts", () => {
		expect(() =>
			normalizeLocalIoEvidence({
				version: 1,
				outcome: "applied",
				createdParentCount: 0,
				uncertainParentCount: 1,
			}),
		).toThrow();
		expect(() =>
			normalizeLocalIoEvidence({
				version: 1,
				outcome: "parent_only",
				createdParentCount: 129,
				uncertainParentCount: 0,
			}),
		).toThrow();
		expect(
			normalizeLocalIoEvidence({
				version: 1,
				outcome: "not_applied",
				createdParentCount: 0,
				uncertainParentCount: 0,
			}),
		).toEqual({
			version: 1,
			outcome: "not_applied",
			createdParentCount: 0,
			uncertainParentCount: 0,
		});
	});
});
