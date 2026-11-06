/**
 * Reading back the note a delegated subagent's result ends with (outline P2 PR 9b): the head line
 * exactly as the writer writes it (`delegation.ts`, the same regex), only the last head line of
 * the text's end, a quoted note left alone, the line a background launch names its task in, and
 * what the Agent card shows of the task.
 */
import { describe, expect, test } from "bun:test";
import {
	noteLinkTitle,
	OUTLINE_REPORT_NOTE_WINDOW,
	readDelegationStarted,
	readOutlineReportNote,
	readSubagentDelegation,
} from "../outline-report-note";

const head = (fields: Record<string, string | number>) =>
	`<outline_report ${Object.entries(fields)
		.map(([k, v]) => `${k}="${v}"`)
		.join(" ")}>`;

const note = (fields: Record<string, string | number>, body = "The note.") =>
	[head(fields), body, "</outline_report>"].join("\n");

const CURRENT = note(
	{ task: "Kx81mPqa/Ab3dEf9Q", report: "Kx81mPqa/Rp1Rp1Rp", generation: 1, status: "current" },
	"The report is attached under the task [[Kx81mPqa/Ab3dEf9Q|Fix the refresh race]] as [[Kx81mPqa/Rp1Rp1Rp|Report (generation 1)]] (3 blocks).",
);
const LATE = note({
	task: "Kx81mPqa/Ab3dEf9Q",
	report: "Kx81mPqa/Rp1Rp1Rp",
	generation: 1,
	status: "late",
	reason: "taken_over",
});

describe("readOutlineReportNote", () => {
	test("a current note and a late one, after the report", () => {
		expect(readOutlineReportNote(`# Findings\nAll good.\n\n${CURRENT}`)).toEqual({
			task: "Kx81mPqa/Ab3dEf9Q",
			report: "Kx81mPqa/Rp1Rp1Rp",
			generation: 1,
			status: "current",
			reason: null,
		});
		expect(readOutlineReportNote(`Report.\n\n${LATE}`)).toMatchObject({
			status: "late",
			reason: "taken_over",
		});
	});

	test("every reason the writer gives; a task gone has no report", () => {
		for (const reason of ["taken_over", "redelegated", "reclaimed", "ended", "reopened"])
			expect(
				readOutlineReportNote(
					note({ task: "a/b", report: "a/c", generation: 2, status: "late", reason }),
				)?.reason,
			).toBe(reason as never);
		expect(
			readOutlineReportNote(note({ task: "a/b", generation: 2, status: "late", reason: "gone" })),
		).toEqual({ task: "a/b", report: null, generation: 2, status: "late", reason: "gone" });
		expect(
			readOutlineReportNote(note({ task: "a/b", generation: 2, status: "not_attached" })),
		).toMatchObject({ status: "not_attached", reason: null });
	});

	test("no note, a malformed head, or a note quoted at the end of a report: none", () => {
		expect(readOutlineReportNote("Just a report.")).toBeNull();
		expect(readOutlineReportNote("")).toBeNull();
		expect(readOutlineReportNote(null)).toBeNull();
		expect(readOutlineReportNote(`x\n<outline_report task="a/b" status="late">`)).toBeNull();
		// The fields out of order, or an unknown status: not the writer's line.
		expect(
			readOutlineReportNote(`x\n<outline_report generation="1" task="a/b" status="current">`),
		).toBeNull();
		expect(
			readOutlineReportNote(`x\n<outline_report task="a/b" generation="1" status="maybe">`),
		).toBeNull();
	});

	test("only the last head line counts: a note quoted earlier in the report is the report's text", () => {
		const text = `The tool said:\n${LATE}\nand then I fixed it.\n\n${CURRENT}`;
		expect(readOutlineReportNote(text)?.status).toBe("current");
		// The last head line is malformed: no note, even though a valid one is quoted before it.
		expect(readOutlineReportNote(`${CURRENT}\n\n<outline_report task="a/b">`)).toBeNull();
	});

	test("only the text's end is read, however long the report", () => {
		const long = "x".repeat(200_000);
		expect(readOutlineReportNote(`${long}\n\n${LATE}`)?.reason).toBe("taken_over");
		// A note more than a window before the end is not the result's note.
		expect(
			readOutlineReportNote(`${LATE}\n${"y".repeat(OUTLINE_REPORT_NOTE_WINDOW + 10)}`),
		).toBeNull();
		// A head the window cuts into (not the start of a line of the text) is not read.
		const cut = `${"z".repeat(10)}${head({ task: "a/b", generation: 1, status: "current" })}\nbody\n</outline_report>`;
		expect(readOutlineReportNote(cut)).toBeNull();
		// A text that is a note and nothing else.
		expect(readOutlineReportNote(LATE)?.status).toBe("late");
	});

	test("one pass over the window: a text of repeated heads stays fast", () => {
		const many = `${'<outline_report task="a/b" generation="1"\n'.repeat(20_000)}${CURRENT}`;
		const started = performance.now();
		for (let i = 0; i < 50; i++) readOutlineReportNote(many);
		expect(performance.now() - started).toBeLessThan(250);
	});
});

describe("the task a call was sent with", () => {
	test("the background launch line, with and without a title", () => {
		const launched = `<background_task_id>bg1</background_task_id>\nRunning in the background.\nDelegated [[Kx81mPqa/Ab3dEf9Q|Fix the refresh race]] to this agent (claim generation 2); its report will be attached under the task when it finishes.`;
		expect(readDelegationStarted(launched)).toEqual({
			address: "Kx81mPqa/Ab3dEf9Q",
			title: "Fix the refresh race",
		});
		expect(
			readDelegationStarted("Delegated [[Kx81mPqa/Ab3dEf9Q]] to this agent (claim generation 1)"),
		).toEqual({ address: "Kx81mPqa/Ab3dEf9Q", title: null });
		expect(readDelegationStarted("Delegated nothing")).toBeNull();
	});

	test("a link's title in the note", () => {
		expect(noteLinkTitle(CURRENT, "Kx81mPqa/Ab3dEf9Q")).toBe("Fix the refresh race");
		expect(noteLinkTitle(LATE, "Kx81mPqa/Ab3dEf9Q")).toBeNull();
	});

	test("what the card shows: from the note, from the launch line, else what the call wrote", () => {
		// No task: not a delegation.
		expect(readSubagentDelegation(undefined, CURRENT)).toBeNull();
		expect(readSubagentDelegation("  ", CURRENT)).toBeNull();
		// Running in the foreground: what the call wrote; linked when it is an address.
		expect(readSubagentDelegation("Ab3dEf9Q", undefined)).toEqual({
			title: "Ab3dEf9Q",
			address: null,
			late: null,
		});
		expect(readSubagentDelegation("Kx81mPqa/Ab3dEf9Q", undefined)).toEqual({
			title: "Kx81mPqa/Ab3dEf9Q",
			address: "Kx81mPqa/Ab3dEf9Q",
			late: null,
		});
		// Back, current: the note's address and the title it links.
		expect(readSubagentDelegation("Ab3dEf9Q", `Report.\n\n${CURRENT}`)).toEqual({
			title: "Fix the refresh race",
			address: "Kx81mPqa/Ab3dEf9Q",
			late: null,
		});
		// Back, late: the note names no title; the call's words stay.
		expect(readSubagentDelegation("Fix the refresh race", `Report.\n\n${LATE}`)).toEqual({
			title: "Fix the refresh race",
			address: "Kx81mPqa/Ab3dEf9Q",
			late: "taken_over",
		});
		// Gone: late, the report not attached.
		expect(
			readSubagentDelegation(
				"a/b",
				note({ task: "a/b", generation: 1, status: "late", reason: "gone" }),
			)?.late,
		).toBe("gone");
		// Not attached for a failure: not late.
		expect(
			readSubagentDelegation("a/b", note({ task: "a/b", generation: 1, status: "not_attached" }))
				?.late,
		).toBeNull();
		// A long title is one line.
		expect(readSubagentDelegation(`${"t".repeat(300)}\nsecond`, undefined)?.title.length).toBe(120);
	});
});
