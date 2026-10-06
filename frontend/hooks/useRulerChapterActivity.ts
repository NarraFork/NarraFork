/**
 * Tracks narrator activity for collapsed chapters in Ruler Flow.
 *
 * Subscribes to all active chapters' narrators via the shared WS manager
 * and accumulates activity info (text snippets, tool names, counts).
 * When a chapter's panel is open, its activity is automatically cleared.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ListenerHandle,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";

export interface ActivityInfo {
	/** Number of unread activity events since the panel was last open */
	count: number;
	/** Most recent text snippet (truncated to ~80 chars) */
	lastText: string;
	/** Most recent tool call name, if any */
	lastToolName: string | null;
	/** Timestamp (ms) of the last activity */
	timestamp: number;
}

interface ChapterNarrator {
	chapterId: string;
	narratorId: string;
}

const MAX_TEXT_LEN = 80;
const MAX_STREAM_BUF_LEN = 1000;

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

function appendStreamTail(current: string, delta: string, maxChars: number): string {
	if (delta.length >= maxChars) return delta.slice(-maxChars);
	const keepFromCurrent = maxChars - delta.length;
	return `${current.slice(-keepFromCurrent)}${delta}`;
}

function textSnippetPreview(text: string, maxChars: number): string {
	let result = "";
	let seenText = false;
	for (let i = 0; i < text.length && result.length < maxChars; i++) {
		const char = text[i] === "\n" ? " " : text[i];
		if (!seenText && /\s/.test(char)) continue;
		seenText = true;
		result += char;
	}
	return truncate(result.trimEnd(), maxChars);
}

/**
 * Hook that monitors narrator WS events for a set of active chapters
 * and returns a map of chapter activity info for badge/tooltip rendering.
 */
export function useRulerChapterActivity(
	chapters: ChapterNarrator[],
	openPanelChapterIds: Set<string>,
): Map<string, ActivityInfo> {
	const [activityMap, setActivityMap] = useState<Map<string, ActivityInfo>>(() => new Map());
	const activityRef = useRef<Map<string, ActivityInfo>>(new Map());

	// Build narratorId → chapterId lookup
	const narratorToChapterRef = useRef<Map<string, string>>(new Map());
	// Streaming text accumulator per narrator (reset on message completion)
	const streamBufRef = useRef<Map<string, string>>(new Map());
	// Ref for openPanelChapterIds to avoid re-subscribing on every panel toggle
	const openPanelIdsRef = useRef(openPanelChapterIds);
	openPanelIdsRef.current = openPanelChapterIds;

	const subHandleRef = useRef<SubscriptionHandle | null>(null);
	const listenerRef = useRef<ListenerHandle | null>(null);
	// Debounce timer for batching state updates
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const scheduleFlush = useCallback(() => {
		if (flushTimerRef.current) return;
		flushTimerRef.current = setTimeout(() => {
			flushTimerRef.current = null;
			setActivityMap(new Map(activityRef.current));
		}, 300);
	}, []);

	// Update narrator→chapter mapping when chapters change and prune stale activity state.
	useEffect(() => {
		const map = new Map<string, string>();
		const validChapterIds = new Set<string>();
		const validNarratorIds = new Set<string>();
		for (const ch of chapters) {
			validChapterIds.add(ch.chapterId);
			if (ch.narratorId) {
				map.set(ch.narratorId, ch.chapterId);
				validNarratorIds.add(ch.narratorId);
			}
		}
		narratorToChapterRef.current = map;

		let activityChanged = false;
		for (const chapterId of activityRef.current.keys()) {
			if (!validChapterIds.has(chapterId)) {
				activityRef.current.delete(chapterId);
				activityChanged = true;
			}
		}
		for (const narratorId of streamBufRef.current.keys()) {
			if (!validNarratorIds.has(narratorId)) streamBufRef.current.delete(narratorId);
		}
		if (activityChanged) setActivityMap(new Map(activityRef.current));
	}, [chapters]);

	// Clear activity for chapters whose panels are open
	useEffect(() => {
		if (openPanelChapterIds.size === 0) return;
		let changed = false;
		for (const chId of openPanelChapterIds) {
			if (activityRef.current.has(chId)) {
				activityRef.current.delete(chId);
				changed = true;
			}
		}
		// Also clear streaming buffers for open panels
		for (const [nId, chId] of narratorToChapterRef.current) {
			if (openPanelChapterIds.has(chId)) {
				streamBufRef.current.delete(nId);
			}
		}
		if (changed) {
			setActivityMap(new Map(activityRef.current));
		}
	}, [openPanelChapterIds]);

	// Subscribe to narrators and listen for events
	useEffect(() => {
		const narratorIds = chapters.filter((ch) => ch.narratorId).map((ch) => ch.narratorId);
		if (narratorIds.length === 0) return;

		// Subscribe (or update existing subscription)
		if (subHandleRef.current) {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		} else {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds);
		}

		// Remove old listener and add new one
		if (listenerRef.current) {
			narratorWSManager.removeListener(listenerRef.current);
		}

		listenerRef.current = narratorWSManager.addListener(
			{
				narratorIds,
				types: ["stream_event", "tool_started", "message"],
			},
			(data: Record<string, unknown>) => {
				const narratorId = data.narratorId as string | undefined;
				if (!narratorId) return;
				const chapterId = narratorToChapterRef.current.get(narratorId);
				if (!chapterId) return;
				// Skip if panel is open
				if (openPanelIdsRef.current.has(chapterId)) return;

				const msgType = data.type as string;

				if (msgType === "stream_event") {
					// biome-ignore lint/suspicious/noExplicitAny: dynamic WS JSON
					const ev = data.event as Record<string, any> | undefined;
					if (
						ev?.type === "content_block_delta" &&
						ev.delta?.type === "text_delta" &&
						ev.delta?.text &&
						!ev.subagentToolUseId
					) {
						const buf = appendStreamTail(
							streamBufRef.current.get(narratorId) ?? "",
							ev.delta.text,
							MAX_STREAM_BUF_LEN,
						);
						streamBufRef.current.set(narratorId, buf);
						// Update activity with accumulated text
						const prev = activityRef.current.get(chapterId);
						activityRef.current.set(chapterId, {
							count: prev?.count ?? 0,
							lastText: textSnippetPreview(buf, MAX_TEXT_LEN),
							lastToolName: prev?.lastToolName ?? null,
							timestamp: Date.now(),
						});
						scheduleFlush();
					}
					return;
				}

				if (msgType === "tool_started") {
					const toolName = data.toolName as string | undefined;
					if (!toolName) return;
					streamBufRef.current.delete(narratorId);
					const prev = activityRef.current.get(chapterId);
					activityRef.current.set(chapterId, {
						count: (prev?.count ?? 0) + 1,
						lastText: prev?.lastText ?? "",
						lastToolName: toolName,
						timestamp: Date.now(),
					});
					scheduleFlush();
					return;
				}

				if (msgType === "message") {
					// Complete message arrived — extract text summary
					streamBufRef.current.delete(narratorId);
					// biome-ignore lint/suspicious/noExplicitAny: dynamic WS JSON
					const msg = data.message as Record<string, any> | undefined;
					const blocks = Array.isArray(msg?.contentJson) ? msg.contentJson : [];
					let text = "";
					for (const block of blocks) {
						if (block.type === "text" && typeof block.text === "string") {
							text = block.text;
							break;
						}
					}
					if (text) {
						const prev = activityRef.current.get(chapterId);
						activityRef.current.set(chapterId, {
							count: (prev?.count ?? 0) + 1,
							lastText: textSnippetPreview(text, MAX_TEXT_LEN),
							lastToolName: null,
							timestamp: Date.now(),
						});
						scheduleFlush();
					}
				}
			},
		);

		return () => {
			if (listenerRef.current) {
				narratorWSManager.removeListener(listenerRef.current);
				listenerRef.current = null;
			}
			if (subHandleRef.current) {
				narratorWSManager.unsubscribe(subHandleRef.current);
				subHandleRef.current = null;
			}
			if (flushTimerRef.current) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			// Free accumulated data on unmount
			activityRef.current.clear();
			streamBufRef.current.clear();
		};
	}, [chapters, scheduleFlush]);

	return activityMap;
}
