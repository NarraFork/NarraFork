import { describe, expect, test } from "bun:test";
import chaptersLocale from "../locales/en/chapters.json";
import {
	buildDraftForkRequest,
	buildForkChapterRequest,
	buildRulerCommitForkRequest,
	getForkDefaults,
} from "./chapter-fork-options";

describe("chapter fork options", () => {
	test("defaults ordinary forks to workspace files and a fresh conversation", () => {
		expect(getForkDefaults({ isMessageFork: false })).toEqual({
			worktreeSource: "workspace",
			inheritMode: "fresh",
		});
	});

	test("defaults message forks to message-point workspace files and full conversation", () => {
		expect(getForkDefaults({ isMessageFork: true })).toEqual({
			worktreeSource: "workspace",
			inheritMode: "full",
		});
		const payload = buildForkChapterRequest({
			title: " From message ",
			description: "",
			inheritMode: "full",
			worktreeSource: "commit",
			forkAtMessageId: "message-one",
			initialCommitSha: "must-not-override-message-point",
		});
		expect(payload).toEqual({
			title: "From message",
			description: undefined,
			inheritMode: "full",
			worktreeSource: "commit",
			forkAtMessageUuid: undefined,
			forkAtMessageId: "message-one",
			startCommitSha: undefined,
		});
	});

	test("forces dormant chapters to commit files without changing conversation defaults", () => {
		expect(
			getForkDefaults({
				isMessageFork: false,
				chapterStatus: "dormant",
				initialWorktreeSource: "workspace",
			}),
		).toEqual({ worktreeSource: "commit", inheritMode: "fresh" });
	});

	test("sends an explicit commit source for ruler ticks", () => {
		expect(buildRulerCommitForkRequest("abc123")).toEqual({
			startCommitSha: "abc123",
			worktreeSource: "commit",
		});
	});

	test("keeps draft conversation inheritance separate from file source", () => {
		expect(
			buildDraftForkRequest({
				title: "Draft",
				description: "desc",
				inheritMode: "full",
				worktreeSource: "commit",
				x: 12,
				y: 34,
			}),
		).toEqual({
			title: "Draft",
			description: "desc",
			inheritMode: "full",
			worktreeSource: "commit",
			graphX: 12,
			graphY: 34,
		});
	});

	test("sends a draft's canvas position as classic coordinates, not ruler offsets", () => {
		// The draft node's coordinates are absolute React Flow world coordinates. Sending
		// them as axisOffset/crossOffset stored a classic position in the columns ruler
		// reads as offsets from a commit tick, which is what made a ruler-arranged project
		// unusable after switching to classic.
		const request = buildDraftForkRequest({
			title: "Draft",
			description: "",
			inheritMode: "fresh",
			worktreeSource: "workspace",
			x: -120,
			y: -40,
		});
		expect(request).not.toHaveProperty("axisOffset");
		expect(request).not.toHaveProperty("crossOffset");
		expect(request).not.toHaveProperty("anchorCommitSha");
		// Negative coordinates survive: a canvas has no origin the user is confined to.
		expect(request.graphX).toBe(-120);
		expect(request.graphY).toBe(-40);
	});

	test("provides the fixed commit source copy used by chapter split", () => {
		expect(chaptersLocale.sourceSplitCommitFixed).toContain("fixed to commit");
	});
});
