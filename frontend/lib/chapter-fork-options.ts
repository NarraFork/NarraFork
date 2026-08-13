import type { ForkWorktreeSource } from "@shared/chapter-fork";
import type { ForkChapterRequest } from "./api/chapters";

export type ForkInheritMode = "fresh" | "compressed" | "full";

export function getForkDefaults(options: {
	isMessageFork: boolean;
	chapterStatus?: string | null;
	initialWorktreeSource?: ForkWorktreeSource;
	initialInheritMode?: ForkInheritMode;
}): { worktreeSource: ForkWorktreeSource; inheritMode: ForkInheritMode } {
	return {
		worktreeSource:
			options.chapterStatus === "dormant"
				? "commit"
				: (options.initialWorktreeSource ?? "workspace"),
		inheritMode: options.initialInheritMode ?? (options.isMessageFork ? "full" : "fresh"),
	};
}

export function buildForkChapterRequest(options: {
	title: string;
	description: string;
	inheritMode: ForkInheritMode;
	worktreeSource: ForkWorktreeSource;
	forkAtMessageUuid?: string;
	forkAtMessageId?: string;
	initialCommitSha?: string;
}): ForkChapterRequest {
	const isMessageFork = !!(options.forkAtMessageUuid || options.forkAtMessageId);
	return {
		title: options.title.trim(),
		description: options.description.trim() || undefined,
		inheritMode: options.inheritMode,
		worktreeSource: options.worktreeSource,
		forkAtMessageUuid: options.forkAtMessageUuid,
		forkAtMessageId: options.forkAtMessageId,
		startCommitSha:
			options.worktreeSource === "commit" && !isMessageFork ? options.initialCommitSha : undefined,
	};
}

export function buildRulerCommitForkRequest(commitSha: string) {
	return { startCommitSha: commitSha, worktreeSource: "commit" as const };
}

export function buildDraftForkRequest(options: {
	title: string;
	description: string;
	inheritMode: ForkInheritMode;
	worktreeSource: ForkWorktreeSource;
	axisOffset: number;
	crossOffset: number;
}): ForkChapterRequest {
	return {
		title: options.title,
		description: options.description || undefined,
		inheritMode: options.inheritMode,
		worktreeSource: options.worktreeSource,
		axisOffset: options.axisOffset,
		crossOffset: options.crossOffset,
	};
}
