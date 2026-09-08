import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { normalizeWorkspacePath } from "./git-workspace";
import { subagentFileIdentityKey } from "./subagent-file-changes";

// === Team file-change tracking ===

export interface TeamFileChange {
	deviceId: string | null;
	workspacePath: string | null;
	filePath: string;
	attributionScope: "legacy_unscoped";
}

// parent → child → collision-safe (device, workspace, file) key → observation.
let _teamFileChanges: Map<string, Map<string, Map<string, TeamFileChange>>> | undefined;
function getTeamFileChangesMap() {
	if (!_teamFileChanges) _teamFileChanges = new Map();
	return _teamFileChanges;
}

/** Record an observation. Old callers remain readable, with UNKNOWN location. */
export function recordTeamFileChange(
	parentNarratorId: string,
	subagentId: string,
	filePath: string,
	location?: { deviceId: string | null; workspacePath: string | null },
): void {
	// parentNarratorId also records ordinary primary forks. Validate real identity
	// with one small indexed read rather than treating provenance as team membership.
	try {
		const child = db
			.select({
				type: narrators.type,
				variant: narrators.variant,
				parentId: narrators.parentNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, subagentId))
			.get();
		if (
			!child ||
			child.parentId !== parentNarratorId ||
			(child.type !== "subagent" && !child.variant.startsWith("subagent:"))
		)
			return;
	} catch {
		// Tracking must not fail a successful tool operation.
		return;
	}
	const team = getTeamFileChangesMap();
	let members = team.get(parentNarratorId);
	if (!members) {
		members = new Map();
		team.set(parentNarratorId, members);
	}
	let files = members.get(subagentId);
	if (!files) {
		files = new Map();
		members.set(subagentId, files);
	}
	const entry: TeamFileChange = {
		deviceId: location?.deviceId || null,
		workspacePath:
			location?.deviceId === "local" && location.workspacePath
				? normalizeWorkspacePath(location.workspacePath)
				: location?.workspacePath || null,
		filePath,
		attributionScope: "legacy_unscoped",
	};
	files.set(subagentFileIdentityKey(entry), entry);
}

/** Structured identity projection for callers that do not need display strings. */
export function getTeamFileChangeEntries(parentNarratorId: string): Map<string, TeamFileChange[]> {
	return new Map(
		[...(getTeamFileChangesMap().get(parentNarratorId) ?? [])].map(([id, files]) => [
			id,
			[...files.values()],
		]),
	);
}

/** Keep the TeamStatus Map/Set API, but each displayed key retains its full identity. */
export function getTeamFileChanges(parentNarratorId: string): Map<string, Set<string>> {
	return new Map(
		[...getTeamFileChangeEntries(parentNarratorId)].map(([id, files]) => [
			id,
			new Set(
				files.map(
					(file) =>
						`${subagentFileIdentityKey(file)} (device, workspace, file; legacy/unscoped${file.deviceId === null || file.workspacePath === null ? "; location unknown" : ""})`,
				),
			),
		]),
	);
}

/** Clear file change tracking for a team. */
export function clearTeamFileChanges(parentNarratorId: string): void {
	getTeamFileChangesMap().delete(parentNarratorId);
}

// === Team messaging ===

export interface TeamMessage {
	fromId: string;
	fromTitle: string | null;
	/**
	 * Readable alias of the sender, used to name it when it has no title. Without
	 * this the fallback was the sender's raw nanoid, injected verbatim into the
	 * recipient's prompt.
	 */
	fromLabel?: string | null;
	fromType: string;
	/**
	 * Where the sender was in its OWN session when it sent this — the recipient's
	 * navigation target (see `SideCarInboundMessage.fromMessageId`).
	 *
	 * Reader-only: it never reaches the model-facing text.
	 */
	fromMessageId?: string | null;
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
