import { relations } from "drizzle-orm";
import {
	chapterCommits,
	chapterEdges,
	chapters,
	containerInstances,
	explorationGroups,
	mergeSessions,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	portAllocations,
	projects,
	terminals,
	terminalTabs,
	terminalViewState,
	userFavoriteDirectories,
	userPreferences,
	users,
} from "./schema";

export const projectsRelations = relations(projects, ({ many }) => ({
	chapters: many(chapters),
	chapterEdges: many(chapterEdges),
	explorationGroups: many(explorationGroups),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
	project: one(projects, { fields: [chapters.projectId], references: [projects.id] }),
	parentChapter: one(chapters, {
		fields: [chapters.parentChapterId],
		references: [chapters.id],
		relationName: "chapterParent",
	}),
	childChapters: many(chapters, { relationName: "chapterParent" }),
	reviewSourceChapter: one(chapters, {
		fields: [chapters.reviewSourceChapterId],
		references: [chapters.id],
		relationName: "reviewSource",
	}),
	reviewChapters: many(chapters, { relationName: "reviewSource" }),
	explorationGroup: one(explorationGroups, {
		fields: [chapters.explorationGroupId],
		references: [explorationGroups.id],
		relationName: "explorationGroupChapters",
	}),
	sourceEdges: many(chapterEdges, { relationName: "edgeSource" }),
	targetEdges: many(chapterEdges, { relationName: "edgeTarget" }),
	narrators: many(narrators),
	terminals: many(terminals),
	containerInstances: many(containerInstances),
	portAllocations: many(portAllocations),
	commits: many(chapterCommits),
}));

export const chapterEdgesRelations = relations(chapterEdges, ({ one }) => ({
	project: one(projects, { fields: [chapterEdges.projectId], references: [projects.id] }),
	source: one(chapters, {
		fields: [chapterEdges.sourceId],
		references: [chapters.id],
		relationName: "edgeSource",
	}),
	target: one(chapters, {
		fields: [chapterEdges.targetId],
		references: [chapters.id],
		relationName: "edgeTarget",
	}),
}));

export const explorationGroupsRelations = relations(explorationGroups, ({ one, many }) => ({
	project: one(projects, {
		fields: [explorationGroups.projectId],
		references: [projects.id],
	}),
	baseChapter: one(chapters, {
		fields: [explorationGroups.baseChapterId],
		references: [chapters.id],
		relationName: "explorationBase",
	}),
	decidedChapter: one(chapters, {
		fields: [explorationGroups.decidedChapterId],
		references: [chapters.id],
		relationName: "explorationDecided",
	}),
	chapters: many(chapters, { relationName: "explorationGroupChapters" }),
}));

export const narratorsRelations = relations(narrators, ({ one, many }) => ({
	chapter: one(chapters, { fields: [narrators.chapterId], references: [chapters.id] }),
	parentNarrator: one(narrators, {
		fields: [narrators.parentNarratorId],
		references: [narrators.id],
		relationName: "narratorParent",
	}),
	childNarrators: many(narrators, { relationName: "narratorParent" }),
	forkMessage: one(narratorMessages, {
		fields: [narrators.forkMessageId],
		references: [narratorMessages.id],
	}),
	messageRefs: many(narratorMessageRefs),
	messages: many(narratorMessages),
	toolCalls: many(narratorToolCalls),
	patches: many(narratorPatches),
	terminals: many(terminals),
	commits: many(chapterCommits),
	whitelistDirs: many(narratorWhitelistDirs),
	blacklistDirs: many(narratorBlacklistDirs),
	whitelistCmds: many(narratorWhitelistCmds),
	blacklistCmds: many(narratorBlacklistCmds),
}));

export const narratorMessagesRelations = relations(narratorMessages, ({ one, many }) => ({
	narrator: one(narrators, {
		fields: [narratorMessages.narratorId],
		references: [narrators.id],
	}),
	creator: one(users, {
		fields: [narratorMessages.createdBy],
		references: [users.id],
	}),
	messageRefs: many(narratorMessageRefs),
	toolCalls: many(narratorToolCalls),
	patches: many(narratorPatches),
}));

export const narratorMessageRefsRelations = relations(narratorMessageRefs, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorMessageRefs.narratorId],
		references: [narrators.id],
	}),
	message: one(narratorMessages, {
		fields: [narratorMessageRefs.messageId],
		references: [narratorMessages.id],
	}),
}));

export const narratorToolCallsRelations = relations(narratorToolCalls, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorToolCalls.narratorId],
		references: [narrators.id],
	}),
	message: one(narratorMessages, {
		fields: [narratorToolCalls.messageId],
		references: [narratorMessages.id],
	}),
}));

export const narratorPatchesRelations = relations(narratorPatches, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorPatches.narratorId],
		references: [narrators.id],
	}),
	message: one(narratorMessages, {
		fields: [narratorPatches.messageId],
		references: [narratorMessages.id],
	}),
}));

export const terminalsRelations = relations(terminals, ({ one }) => ({
	chapter: one(chapters, { fields: [terminals.chapterId], references: [chapters.id] }),
	narrator: one(narrators, { fields: [terminals.narratorId], references: [narrators.id] }),
}));

export const terminalTabsRelations = relations(terminalTabs, ({ one }) => ({
	chapter: one(chapters, { fields: [terminalTabs.chapterId], references: [chapters.id] }),
	narrator: one(narrators, { fields: [terminalTabs.narratorId], references: [narrators.id] }),
}));

export const terminalViewStateRelations = relations(terminalViewState, ({ one }) => ({
	user: one(users, { fields: [terminalViewState.userId], references: [users.id] }),
	chapter: one(chapters, { fields: [terminalViewState.chapterId], references: [chapters.id] }),
	narrator: one(narrators, { fields: [terminalViewState.narratorId], references: [narrators.id] }),
}));

export const containerInstancesRelations = relations(containerInstances, ({ one }) => ({
	chapter: one(chapters, {
		fields: [containerInstances.chapterId],
		references: [chapters.id],
	}),
}));

export const portAllocationsRelations = relations(portAllocations, ({ one }) => ({
	chapter: one(chapters, {
		fields: [portAllocations.chapterId],
		references: [chapters.id],
	}),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
	favoriteDirectories: many(userFavoriteDirectories),
	preferences: one(userPreferences, {
		fields: [users.id],
		references: [userPreferences.userId],
	}),
}));

export const userFavoriteDirectoriesRelations = relations(userFavoriteDirectories, ({ one }) => ({
	user: one(users, {
		fields: [userFavoriteDirectories.userId],
		references: [users.id],
	}),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
	user: one(users, {
		fields: [userPreferences.userId],
		references: [users.id],
	}),
}));

export const mergeSessionsRelations = relations(mergeSessions, ({ one }) => ({
	targetChapter: one(chapters, {
		fields: [mergeSessions.targetChapterId],
		references: [chapters.id],
	}),
}));

export const chapterCommitsRelations = relations(chapterCommits, ({ one }) => ({
	chapter: one(chapters, {
		fields: [chapterCommits.chapterId],
		references: [chapters.id],
	}),
	narrator: one(narrators, {
		fields: [chapterCommits.narratorId],
		references: [narrators.id],
	}),
	narratorMessage: one(narratorMessages, {
		fields: [chapterCommits.narratorMessageId],
		references: [narratorMessages.id],
	}),
}));

export const narratorWhitelistDirsRelations = relations(narratorWhitelistDirs, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorWhitelistDirs.narratorId],
		references: [narrators.id],
	}),
}));

export const narratorBlacklistDirsRelations = relations(narratorBlacklistDirs, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorBlacklistDirs.narratorId],
		references: [narrators.id],
	}),
}));

export const narratorWhitelistCmdsRelations = relations(narratorWhitelistCmds, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorWhitelistCmds.narratorId],
		references: [narrators.id],
	}),
}));

export const narratorBlacklistCmdsRelations = relations(narratorBlacklistCmds, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorBlacklistCmds.narratorId],
		references: [narrators.id],
	}),
}));
