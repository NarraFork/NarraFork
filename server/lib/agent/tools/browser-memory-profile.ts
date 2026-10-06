import { PROFILE_LIMITS } from "../../browser/memory-profile-constants";
import type { MemoryProfileMode, MemoryProfileView } from "../../browser/memory-profile-types";
import {
	cancelMemoryProfile,
	startMemoryProfile,
	statusMemoryProfile,
	stopMemoryProfile,
} from "../../browser/memory-profiler";
import type { BrowserSession } from "../../browser/session";
import { sliceToUtf8Budget, utf8Bytes } from "../../utf8-budget";
import type { ToolResult } from "../types";

const dependencies = {
	startMemoryProfile,
	stopMemoryProfile,
	statusMemoryProfile,
	cancelMemoryProfile,
};
export type MemoryProfileAction =
	| "memory_profile_start"
	| "memory_profile_stop"
	| "memory_profile_status"
	| "memory_profile_cancel";

export async function handleBrowserMemoryProfile(
	session: BrowserSession,
	action: MemoryProfileAction,
	opts: {
		profileId?: string;
		mode?: MemoryProfileMode;
		durationMs?: number;
		samplingIntervalBytes?: number;
		signal?: AbortSignal;
	},
	deps = dependencies,
): Promise<ToolResult> {
	if ((action === "memory_profile_stop" || action === "memory_profile_cancel") && !opts.profileId) {
		return { output: "profile_id is required for memory_profile_stop/cancel", isError: true };
	}
	let view: MemoryProfileView;
	switch (action) {
		case "memory_profile_start":
			view = await deps.startMemoryProfile(session, opts);
			break;
		case "memory_profile_stop":
			view = await deps.stopMemoryProfile(session, opts.profileId as string, opts.signal);
			break;
		case "memory_profile_cancel":
			view = await deps.cancelMemoryProfile(session, opts.profileId as string);
			break;
		case "memory_profile_status":
			view = deps.statusMemoryProfile(session, opts.profileId);
			break;
	}
	const text = JSON.stringify(view, null, 2);
	const footer =
		"\nSampling sizes are estimates; GC spans are not CPU percentage or exact collection cycles. Artifact links may expose script URLs/paths to their holders for 24h.";
	const notice = "\n[Output clipped; download summary for full details]";
	const max = PROFILE_LIMITS.summaryBytes - utf8Bytes(footer);
	const clipped =
		utf8Bytes(text) > max ? sliceToUtf8Budget(text, max - utf8Bytes(notice)) + notice : text;
	return {
		output: clipped + footer,
		isError: view.state === "failed",
		metadata: { sessionId: session.id, memoryProfile: view },
	};
}
