import { eventBus } from "../lib/event-bus";
import { broadcastToNarrator } from "../websocket/narrator-ws";

// === Team file-change tracking ===
// parentNarratorId → Map<subagentId, Set<filePath>>

let _teamFileChanges: Map<string, Map<string, Set<string>>> | undefined;
function getTeamFileChangesMap() {
	if (!_teamFileChanges) _teamFileChanges = new Map();
	return _teamFileChanges;
}

/** Record a file change made by a subagent (called from Write/Edit tools). */
export function recordTeamFileChange(
	parentNarratorId: string,
	subagentId: string,
	filePath: string,
): void {
	const team = getTeamFileChangesMap();
	let members = team.get(parentNarratorId);
	if (!members) {
		members = new Map();
		team.set(parentNarratorId, members);
	}
	let files = members.get(subagentId);
	if (!files) {
		files = new Set();
		members.set(subagentId, files);
	}
	files.add(filePath);
}

/** Get all file changes for a team (all subagents under a parent narrator). */
export function getTeamFileChanges(parentNarratorId: string): Map<string, Set<string>> {
	return getTeamFileChangesMap().get(parentNarratorId) ?? new Map();
}

/** Clear file change tracking for a team. */
export function clearTeamFileChanges(parentNarratorId: string): void {
	getTeamFileChangesMap().delete(parentNarratorId);
}

// === Team messaging ===

export interface TeamMessage {
	fromId: string;
	fromTitle: string | null;
	fromType: string;
	text: string;
	timestamp: string;
	isBroadcast: boolean;
}

// In-memory only — intentionally not persisted. Subagent lifetimes are short
// (bounded by the parent narrator session) so messages don't need to survive
// server restarts. This avoids DB overhead for ephemeral coordination data.
let _teamInbox: Map<string, TeamMessage[]> | undefined;
function getTeamInboxMap() {
	if (!_teamInbox) _teamInbox = new Map();
	return _teamInbox;
}

/** Deliver a message to a subagent's team inbox, emit event, and broadcast to WebSocket. */
export function deliverTeamMessage(
	targetId: string,
	message: TeamMessage,
	parentNarratorId?: string,
): void {
	const inbox = getTeamInboxMap();
	if (!inbox.has(targetId)) inbox.set(targetId, []);
	inbox.get(targetId)?.push(message);
	if (parentNarratorId) {
		eventBus.emit({
			type: "narrator:team_message",
			narratorId: targetId,
			fromId: message.fromId,
			parentNarratorId,
			text: message.text,
			isBroadcast: message.isBroadcast,
		});
		broadcastToNarrator(targetId, {
			type: "team_message",
			narratorId: targetId,
			fromId: message.fromId,
			fromTitle: message.fromTitle,
			fromType: message.fromType,
			text: message.text,
			isBroadcast: message.isBroadcast,
		});
	}
}

/** Drain all pending team messages for a subagent. */
export function drainTeamInbox(subagentId: string): TeamMessage[] {
	const inbox = getTeamInboxMap();
	const messages = inbox.get(subagentId);
	if (!messages?.length) return [];
	inbox.delete(subagentId);
	return messages;
}

/** Check if a subagent has pending team messages (non-destructive). */
export function hasTeamMessages(subagentId: string): boolean {
	const messages = getTeamInboxMap().get(subagentId);
	return !!messages?.length;
}

/** Clear team inbox for a subagent. */
export function clearTeamInbox(subagentId: string): void {
	getTeamInboxMap().delete(subagentId);
}
