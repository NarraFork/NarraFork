/**
 * The Agent card reads a delegated result's outline note from the text when the call carries no
 * metadata (calls written before it, outline P2 PR 9b): the subagent runner appends its own notes
 * after the note and the file-change block (the parent's model not in the pool, the alias taken),
 * and the reader strips them. Held here to the runner's own writers, so a change to their wording
 * that the reader would miss fails.
 */
import { describe, expect, test } from "bun:test";
import { readOutlineReportNote, readSubagentDelegation } from "@shared/outline-report-note";
import { formatSubagentModelFallbackNote } from "../subagent-model";
import { aliasConflictNote } from "../subagent-runner";

const NOTE = [
	'<outline_report task="Kx81mPqa/Ab3dEf9Q" report="Kx81mPqa/Rp1Rp1Rp" generation="1" status="late" reason="taken_over">',
	"Late result: since this agent was sent, the task was taken over by someone (claim generation 2).",
	"</outline_report>",
].join("\n");
const FILES = "\n\n<subagent_file_changes>\n- src/auth.ts +12 -3\n</subagent_file_changes>";

describe("the runner's notes after a delegated result", () => {
	test("the note is still read, so the card still marks the result late", () => {
		const fallback = formatSubagentModelFallbackNote({
			source: "pool-fallback",
			parentModel: "provider/large-model",
			poolKey: "general",
			model: "provider/small-model",
		});
		expect(fallback).not.toBe("");
		for (const background of [false, true]) {
			const text = `Report.\n\n${NOTE}${FILES}${fallback}${aliasConflictNote("fixer", "fixer-2", background)}`;
			expect(readOutlineReportNote(text)?.reason).toBe("taken_over");
			expect(readSubagentDelegation("Kx81mPqa/Ab3dEf9Q", text)?.late).toBe("taken_over");
		}
	});
});
