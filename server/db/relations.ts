import { relations } from "drizzle-orm";
import {
	apiRequests,
	backgroundTasks,
	benchmarkRuns,
	benchmarkSuites,
	benchmarkTaskResults,
	chapterCommits,
	chapterEdges,
	chapters,
	containerInstances,
	explorationGroups,
	gatewaySessionMappings,
	hooks,
	integrationAuthorities,
	integrationCapabilityGrants,
	mergeSessions,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorBufferedMessages,
	narratorDrafts,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	portAllocations,
	projects,
	remoteDevices,
	reviewConclusions,
	specFileRevisions,
	specNamespaceFiles,
	specNamespaces,
	specProtectedTasks,
	terminals,
	terminalViewState,
	userFavoriteDirectories,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	volumeSnapshotApplications,
	volumeSnapshots,
	workspaces,
} from "./schema";

export const projectsRelations = relations(projects, ({ many }) => ({
	chapters: many(chapters),
	chapterEdges: many(chapterEdges),
	explorationGroups: many(explorationGroups),
	volumeSnapshots: many(volumeSnapshots),
	hooks: many(hooks),
	oauthGrantProjects: many(oauthGrantProjects),
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
	snapshotApplications: many(volumeSnapshotApplications),
	reviewConclusionsAsReview: many(reviewConclusions, { relationName: "reviewChapter" }),
	reviewConclusionsAsSource: many(reviewConclusions, { relationName: "sourceChapter" }),
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
	contextProject: one(projects, {
		fields: [narrators.contextProjectId],
		references: [projects.id],
	}),
	oauthOwnerGrant: one(oauthGrants, {
		fields: [narrators.oauthOwnerGrantId],
		references: [oauthGrants.id],
		relationName: "oauthGrantNarrators",
	}),
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
	sideCars: many(narratorSidecars),
	fileSnapshots: many(narratorFileSnapshots),
	terminals: many(terminals),
	commits: many(chapterCommits),
	whitelistDirs: many(narratorWhitelistDirs),
	blacklistDirs: many(narratorBlacklistDirs),
	whitelistCmds: many(narratorWhitelistCmds),
	blacklistCmds: many(narratorBlacklistCmds),
	bufferedMessages: many(narratorBufferedMessages),
	drafts: many(narratorDrafts),
	specNamespace: one(specNamespaces, {
		fields: [narrators.id],
		references: [specNamespaces.narratorId],
	}),
}));

export const specNamespacesRelations = relations(specNamespaces, ({ one, many }) => ({
	narrator: one(narrators, { fields: [specNamespaces.narratorId], references: [narrators.id] }),
	forkedFrom: one(specNamespaces, {
		fields: [specNamespaces.forkedFromNamespaceId],
		references: [specNamespaces.id],
		relationName: "specNamespaceFork",
	}),
	forks: many(specNamespaces, { relationName: "specNamespaceFork" }),
	files: many(specNamespaceFiles),
	revisions: many(specFileRevisions),
	protectedTasks: many(specProtectedTasks),
}));

export const specNamespaceFilesRelations = relations(specNamespaceFiles, ({ one }) => ({
	namespace: one(specNamespaces, {
		fields: [specNamespaceFiles.namespaceId],
		references: [specNamespaces.id],
	}),
	revision: one(specFileRevisions, {
		fields: [specNamespaceFiles.revisionId],
		references: [specFileRevisions.id],
	}),
}));

export const specFileRevisionsRelations = relations(specFileRevisions, ({ one, many }) => ({
	namespace: one(specNamespaces, {
		fields: [specFileRevisions.namespaceId],
		references: [specNamespaces.id],
	}),
	parentRevision: one(specFileRevisions, {
		fields: [specFileRevisions.parentRevisionId],
		references: [specFileRevisions.id],
		relationName: "specRevisionParent",
	}),
	childRevisions: many(specFileRevisions, { relationName: "specRevisionParent" }),
	currentFiles: many(specNamespaceFiles),
}));

export const specProtectedTasksRelations = relations(specProtectedTasks, ({ one }) => ({
	namespace: one(specNamespaces, {
		fields: [specProtectedTasks.namespaceId],
		references: [specNamespaces.id],
	}),
	firstRevision: one(specFileRevisions, {
		fields: [specProtectedTasks.firstRevisionId],
		references: [specFileRevisions.id],
		relationName: "specProtectedTaskFirstRevision",
	}),
	lastRevision: one(specFileRevisions, {
		fields: [specProtectedTasks.lastRevisionId],
		references: [specFileRevisions.id],
		relationName: "specProtectedTaskLastRevision",
	}),
}));

export const narratorBufferedMessagesRelations = relations(narratorBufferedMessages, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorBufferedMessages.narratorId],
		references: [narrators.id],
	}),
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
	sideCars: many(narratorSidecars),
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

export const narratorSidecarsRelations = relations(narratorSidecars, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorSidecars.narratorId],
		references: [narrators.id],
	}),
	message: one(narratorMessages, {
		fields: [narratorSidecars.messageId],
		references: [narratorMessages.id],
	}),
}));

export const narratorFileSnapshotsRelations = relations(narratorFileSnapshots, ({ one }) => ({
	narrator: one(narrators, {
		fields: [narratorFileSnapshots.narratorId],
		references: [narrators.id],
	}),
}));

export const remoteDevicesRelations = relations(remoteDevices, ({ one }) => ({
	project: one(projects, { fields: [remoteDevices.projectId], references: [projects.id] }),
	oauthOwnerGrant: one(oauthGrants, {
		fields: [remoteDevices.oauthOwnerGrantId],
		references: [oauthGrants.id],
		relationName: "oauthGrantDevices",
	}),
}));

export const terminalsRelations = relations(terminals, ({ one }) => ({
	chapter: one(chapters, { fields: [terminals.chapterId], references: [chapters.id] }),
	narrator: one(narrators, { fields: [terminals.narratorId], references: [narrators.id] }),
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
	workspaces: many(workspaces),
	drafts: many(narratorDrafts),
	recentTabs: many(userRecentTabs),
	preferences: one(userPreferences, {
		fields: [users.id],
		references: [userPreferences.userId],
	}),
	recentTabsMeta: one(userRecentTabsMeta, {
		fields: [users.id],
		references: [userRecentTabsMeta.userId],
	}),
	oauthClientsCreated: many(oauthClients, { relationName: "oauthClientCreator" }),
	oauthClientsRevoked: many(oauthClients, { relationName: "oauthClientRevoker" }),
	oauthGrants: many(oauthGrants, { relationName: "oauthGrantUser" }),
	oauthGrantsRevoked: many(oauthGrants, { relationName: "oauthGrantRevoker" }),
	oauthGrantEvents: many(oauthGrantEvents, { relationName: "oauthGrantEventUser" }),
	oauthGrantEventsActed: many(oauthGrantEvents, { relationName: "oauthGrantEventActor" }),
	oauthAuthorizationCodes: many(oauthAuthorizationCodes),
	oauthAccessTokens: many(oauthAccessTokens, { relationName: "oauthAccessTokenUser" }),
	oauthAccessTokensRevoked: many(oauthAccessTokens, {
		relationName: "oauthAccessTokenRevoker",
	}),
}));

export const narratorDraftsRelations = relations(narratorDrafts, ({ one }) => ({
	user: one(users, { fields: [narratorDrafts.userId], references: [users.id] }),
	narrator: one(narrators, {
		fields: [narratorDrafts.narratorId],
		references: [narrators.id],
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

export const userRecentTabsRelations = relations(userRecentTabs, ({ one }) => ({
	user: one(users, {
		fields: [userRecentTabs.userId],
		references: [users.id],
	}),
}));

export const userRecentTabsMetaRelations = relations(userRecentTabsMeta, ({ one }) => ({
	user: one(users, {
		fields: [userRecentTabsMeta.userId],
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

export const volumeSnapshotsRelations = relations(volumeSnapshots, ({ one, many }) => ({
	project: one(projects, {
		fields: [volumeSnapshots.projectId],
		references: [projects.id],
	}),
	sourceChapter: one(chapters, {
		fields: [volumeSnapshots.sourceChapterId],
		references: [chapters.id],
	}),
	createdByUser: one(users, {
		fields: [volumeSnapshots.createdBy],
		references: [users.id],
	}),
	applications: many(volumeSnapshotApplications),
}));

export const volumeSnapshotApplicationsRelations = relations(
	volumeSnapshotApplications,
	({ one }) => ({
		snapshot: one(volumeSnapshots, {
			fields: [volumeSnapshotApplications.snapshotId],
			references: [volumeSnapshots.id],
		}),
		chapter: one(chapters, {
			fields: [volumeSnapshotApplications.chapterId],
			references: [chapters.id],
		}),
		appliedByUser: one(users, {
			fields: [volumeSnapshotApplications.appliedBy],
			references: [users.id],
		}),
	}),
);

export const workspacesRelations = relations(workspaces, ({ one }) => ({
	user: one(users, {
		fields: [workspaces.userId],
		references: [users.id],
	}),
}));

export const reviewConclusionsRelations = relations(reviewConclusions, ({ one }) => ({
	reviewChapter: one(chapters, {
		fields: [reviewConclusions.reviewChapterId],
		references: [chapters.id],
		relationName: "reviewChapter",
	}),
	sourceChapter: one(chapters, {
		fields: [reviewConclusions.sourceChapterId],
		references: [chapters.id],
		relationName: "sourceChapter",
	}),
}));

export const apiRequestsRelations = relations(apiRequests, ({ one }) => ({
	narrator: one(narrators, {
		fields: [apiRequests.narratorId],
		references: [narrators.id],
	}),
	message: one(narratorMessages, {
		fields: [apiRequests.messageId],
		references: [narratorMessages.id],
	}),
}));

export const hooksRelations = relations(hooks, ({ one }) => ({
	project: one(projects, {
		fields: [hooks.projectId],
		references: [projects.id],
	}),
}));

// === IM Gateway ===

export const gatewaySessionMappingsRelations = relations(gatewaySessionMappings, ({ one }) => ({
	narrator: one(narrators, {
		fields: [gatewaySessionMappings.narratorId],
		references: [narrators.id],
	}),
	appUser: one(users, {
		fields: [gatewaySessionMappings.appUserId],
		references: [users.id],
	}),
	project: one(projects, {
		fields: [gatewaySessionMappings.projectId],
		references: [projects.id],
	}),
	chapter: one(chapters, {
		fields: [gatewaySessionMappings.chapterId],
		references: [chapters.id],
	}),
}));

// === Benchmark relations ===

export const benchmarkSuitesRelations = relations(benchmarkSuites, ({ many }) => ({
	runs: many(benchmarkRuns),
}));

export const benchmarkRunsRelations = relations(benchmarkRuns, ({ one, many }) => ({
	suite: one(benchmarkSuites, {
		fields: [benchmarkRuns.suiteId],
		references: [benchmarkSuites.id],
	}),
	taskResults: many(benchmarkTaskResults),
}));

export const benchmarkTaskResultsRelations = relations(benchmarkTaskResults, ({ one }) => ({
	run: one(benchmarkRuns, {
		fields: [benchmarkTaskResults.runId],
		references: [benchmarkRuns.id],
	}),
	narrator: one(narrators, {
		fields: [benchmarkTaskResults.narratorId],
		references: [narrators.id],
	}),
}));

// === Background tasks ===

export const backgroundTasksRelations = relations(backgroundTasks, ({ one }) => ({
	parentNarrator: one(narrators, {
		fields: [backgroundTasks.parentNarratorId],
		references: [narrators.id],
		relationName: "bgTaskParent",
	}),
	subagentNarrator: one(narrators, {
		fields: [backgroundTasks.subagentNarratorId],
		references: [narrators.id],
		relationName: "bgTaskSubagent",
	}),
}));

// === Integration kernel + OAuth provider relations ===

export const integrationAuthoritiesRelations = relations(
	integrationAuthorities,
	({ one, many }) => ({
		owner: one(users, {
			fields: [integrationAuthorities.ownerUserId],
			references: [users.id],
		}),
		grants: many(integrationCapabilityGrants),
	}),
);

export const integrationCapabilityGrantsRelations = relations(
	integrationCapabilityGrants,
	({ one }) => ({
		authority: one(integrationAuthorities, {
			fields: [integrationCapabilityGrants.authorityId],
			references: [integrationAuthorities.id],
		}),
	}),
);

export const oauthClientsRelations = relations(oauthClients, ({ one, many }) => ({
	creator: one(users, {
		fields: [oauthClients.createdBy],
		references: [users.id],
		relationName: "oauthClientCreator",
	}),
	revokedByUser: one(users, {
		fields: [oauthClients.revokedByUserId],
		references: [users.id],
		relationName: "oauthClientRevoker",
	}),
	grants: many(oauthGrants),
	grantEvents: many(oauthGrantEvents),
	authorizationCodes: many(oauthAuthorizationCodes),
	accessTokens: many(oauthAccessTokens),
}));

export const oauthGrantsRelations = relations(oauthGrants, ({ one, many }) => ({
	authority: one(integrationAuthorities, {
		fields: [oauthGrants.id],
		references: [integrationAuthorities.id],
	}),
	client: one(oauthClients, {
		fields: [oauthGrants.oauthClientId],
		references: [oauthClients.id],
	}),
	user: one(users, {
		fields: [oauthGrants.userId],
		references: [users.id],
		relationName: "oauthGrantUser",
	}),
	revokedByUser: one(users, {
		fields: [oauthGrants.revokedByUserId],
		references: [users.id],
		relationName: "oauthGrantRevoker",
	}),
	projects: many(oauthGrantProjects),
	events: many(oauthGrantEvents),
	authorizationCodes: many(oauthAuthorizationCodes),
	accessTokens: many(oauthAccessTokens),
	narrators: many(narrators, { relationName: "oauthGrantNarrators" }),
	devices: many(remoteDevices, { relationName: "oauthGrantDevices" }),
}));

export const oauthGrantProjectsRelations = relations(oauthGrantProjects, ({ one }) => ({
	grant: one(oauthGrants, {
		fields: [oauthGrantProjects.grantId],
		references: [oauthGrants.id],
	}),
	project: one(projects, {
		fields: [oauthGrantProjects.projectId],
		references: [projects.id],
	}),
}));

export const oauthGrantEventsRelations = relations(oauthGrantEvents, ({ one }) => ({
	grant: one(oauthGrants, {
		fields: [oauthGrantEvents.grantId],
		references: [oauthGrants.id],
	}),
	client: one(oauthClients, {
		fields: [oauthGrantEvents.oauthClientId],
		references: [oauthClients.id],
	}),
	user: one(users, {
		fields: [oauthGrantEvents.userId],
		references: [users.id],
		relationName: "oauthGrantEventUser",
	}),
	actorUser: one(users, {
		fields: [oauthGrantEvents.actorUserId],
		references: [users.id],
		relationName: "oauthGrantEventActor",
	}),
}));

export const oauthAuthorizationCodesRelations = relations(oauthAuthorizationCodes, ({ one }) => ({
	client: one(oauthClients, {
		fields: [oauthAuthorizationCodes.oauthClientId],
		references: [oauthClients.id],
	}),
	grant: one(oauthGrants, {
		fields: [oauthAuthorizationCodes.grantId],
		references: [oauthGrants.id],
	}),
	user: one(users, {
		fields: [oauthAuthorizationCodes.userId],
		references: [users.id],
	}),
}));

export const oauthAccessTokensRelations = relations(oauthAccessTokens, ({ one }) => ({
	client: one(oauthClients, {
		fields: [oauthAccessTokens.oauthClientId],
		references: [oauthClients.id],
	}),
	grant: one(oauthGrants, {
		fields: [oauthAccessTokens.grantId],
		references: [oauthGrants.id],
	}),
	user: one(users, {
		fields: [oauthAccessTokens.userId],
		references: [users.id],
		relationName: "oauthAccessTokenUser",
	}),
	revokedByUser: one(users, {
		fields: [oauthAccessTokens.revokedByUserId],
		references: [users.id],
		relationName: "oauthAccessTokenRevoker",
	}),
}));
