import { relations } from "drizzle-orm";
import {
	chapters,
	containerInstances,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRequests,
	portAllocations,
	projects,
	terminals,
	userFavoriteDirectories,
	userPreferences,
	users,
} from "./schema";

export const projectsRelations = relations(projects, ({ many }) => ({
	chapters: many(chapters),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
	project: one(projects, { fields: [chapters.projectId], references: [projects.id] }),
	parentChapter: one(chapters, {
		fields: [chapters.parentChapterId],
		references: [chapters.id],
		relationName: "chapterParent",
	}),
	childChapters: many(chapters, { relationName: "chapterParent" }),
	narrators: many(narrators),
	terminals: many(terminals),
	containerInstances: many(containerInstances),
	portAllocations: many(portAllocations),
}));

export const narratorsRelations = relations(narrators, ({ one, many }) => ({
	chapter: one(chapters, { fields: [narrators.chapterId], references: [chapters.id] }),
	parentNarrator: one(narrators, {
		fields: [narrators.parentNarratorId],
		references: [narrators.id],
		relationName: "narratorParent",
	}),
	messages: many(narratorMessages),
	toolCalls: many(narratorToolCalls),
	permissionRequests: many(permissionRequests),
}));

export const narratorMessagesRelations = relations(narratorMessages, ({ one, many }) => ({
	narrator: one(narrators, {
		fields: [narratorMessages.narratorId],
		references: [narrators.id],
	}),
	toolCalls: many(narratorToolCalls),
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

export const permissionRequestsRelations = relations(permissionRequests, ({ one }) => ({
	narrator: one(narrators, {
		fields: [permissionRequests.narratorId],
		references: [narrators.id],
	}),
	toolCall: one(narratorToolCalls, {
		fields: [permissionRequests.toolCallId],
		references: [narratorToolCalls.id],
	}),
}));

export const terminalsRelations = relations(terminals, ({ one }) => ({
	chapter: one(chapters, { fields: [terminals.chapterId], references: [chapters.id] }),
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
