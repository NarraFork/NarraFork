import { describe, expect, test } from "bun:test";
import type { KnowledgeOpenSubmission, KnowledgeSubmissionOutcome } from "../../../lib/api";
import {
	hasUnknownDrafts,
	myRequestSections,
	openRequestByDraft,
	parseKnowledgeMineSearch,
	personalEntryDisplayTitle,
	personalEntryKind,
	submitBlockerKey,
	visiblePersonalEntries,
} from "./personal-entry-view";

const open = (id: string, draftId: string, status: KnowledgeOpenSubmission["status"]) =>
	({ id, draftId, entryId: null, status, createdAt: `2026-01-0${id.length}T00:00:00Z` }) as const;

const outcome = (
	id: string,
	draftId: string,
	status: KnowledgeSubmissionOutcome["status"],
	findings: KnowledgeSubmissionOutcome["findingsJson"] = null,
): KnowledgeSubmissionOutcome => ({
	id,
	draftId,
	entryId: null,
	status,
	verdict: null,
	findingsJson: findings,
	reviewedAt: "2026-02-01T00:00:00Z",
	authorReadAt: null,
	createdAt: "2026-01-01T00:00:00Z",
});

describe("personal-entry view helpers", () => {
	test("kind and display title: linked copies are named by their shared entry", () => {
		expect(personalEntryKind({ entryId: "e" })).toBe("linked");
		expect(personalEntryKind({ entryId: null })).toBe("standalone");
		expect(personalEntryDisplayTitle({ entryId: "e", title: null, entryTitle: "Shared" })).toBe(
			"Shared",
		);
		// Unreadable linked entry → no title, never the stale own-title column.
		expect(personalEntryDisplayTitle({ entryId: "e", title: "x", entryTitle: null })).toBeNull();
		expect(personalEntryDisplayTitle({ entryId: null, title: "Mine" })).toBe("Mine");
		expect(personalEntryDisplayTitle({ entryId: null, title: "  " })).toBeNull();
	});

	test("archived versions are hidden by default", () => {
		const rows = [
			{ id: "a", status: "active" as const },
			{ id: "b", status: "archived" as const },
		];
		expect(visiblePersonalEntries(rows, false).map((r) => r.id)).toEqual(["a"]);
		expect(visiblePersonalEntries(rows, true).map((r) => r.id)).toEqual(["a", "b"]);
	});

	test("openRequestByDraft keeps the newest request per version", () => {
		const m = openRequestByDraft([open("new", "d1", "pending"), open("old", "d1", "conflict")]);
		expect(m.get("d1")?.id).toBe("new");
	});

	test("my requests: open first, outcomes below, changes requested listed once with findings", () => {
		const findings = [{ severity: "major" as const, message: "cite the source" }];
		const sections = myRequestSections(
			[open("cr", "d1", "changes_requested"), open("p", "d2", "pending")],
			[outcome("cr", "d1", "changes_requested", findings), outcome("ok", "d3", "approved")],
		);
		expect(sections.open.map((r) => [r.id, r.status])).toEqual([
			["cr", "changes_requested"],
			["p", "pending"],
		]);
		expect(sections.open[0].findings).toEqual(findings);
		expect(sections.outcomes.map((r) => r.id)).toEqual(["ok"]);
		expect(sections.outcomes[0].at).toBe("2026-02-01T00:00:00Z");
	});

	test("unknown drafts are detected so archived versions can be loaded for labels", () => {
		expect(hasUnknownDrafts([{ draftId: "d1" }], [{ id: "d1" }])).toBe(false);
		expect(hasUnknownDrafts([{ draftId: "d9" }], [{ id: "d1" }])).toBe(true);
	});

	test("blocked reasons map to i18n keys", () => {
		expect(submitBlockerKey("open_request")).toBe("submitBlocker_open_request");
	});
});

describe("parseKnowledgeMineSearch", () => {
	test("only an explicit archived flag survives", () => {
		expect(parseKnowledgeMineSearch({})).toEqual({});
		expect(parseKnowledgeMineSearch({ archived: true })).toEqual({ archived: true });
		expect(parseKnowledgeMineSearch({ archived: "1" })).toEqual({ archived: true });
		expect(parseKnowledgeMineSearch({ archived: "no" })).toEqual({});
	});
});
