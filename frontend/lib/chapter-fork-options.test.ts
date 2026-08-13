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
				axisOffset: 12,
				crossOffset: 34,
			}),
		).toEqual({
			title: "Draft",
			description: "desc",
			inheritMode: "full",
			worktreeSource: "commit",
			axisOffset: 12,
			crossOffset: 34,
		});
	});

	test("provides the fixed commit source copy used by chapter split", () => {
		expect(chaptersLocale.sourceSplitCommitFixed).toContain("fixed to commit");
	});
});
