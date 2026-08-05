import { getEffectiveNarratorDisplay, type StatusAccent } from "../../lib/status-registry";

const STATUS_BAR_SUBSTATUS_PRIORITY = [
	"error",
	// Without this the label falls back to the base status ("Waiting"), which
	// reads as "waiting for you" instead of "waiting for the model".
	"model_unavailable",
	"interrupted",
	"suspended",
	"manual_override",
	"unread",
] as const;

const LEGACY_TERMINAL_STATUS_TO_SUBSTATUS: Record<string, string> = {
	done: "unread",
	error: "error",
	interrupted: "interrupted",
};

export type NarratorStatusBarSource = {
	id?: unknown;
	status?: unknown;
	substatus?: unknown;
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function getNarratorStatusBarDisplay(options: {
	panelNarratorId: string;
	narrator: NarratorStatusBarSource;
	liveSubstatus: string[];
}): StatusAccent & { labelKey: string } {
	const ownsNarrator =
		typeof options.narrator.id !== "string" || options.narrator.id === options.panelNarratorId;
	let status =
		ownsNarrator && typeof options.narrator.status === "string" ? options.narrator.status : "idle";
	let displaySubstatus = ownsNarrator
		? options.liveSubstatus.length > 0
			? options.liveSubstatus
			: stringArray(options.narrator.substatus)
		: [];
	const legacySubstatus = LEGACY_TERMINAL_STATUS_TO_SUBSTATUS[status];
	if (legacySubstatus) {
		status = "idle";
		if (!displaySubstatus.includes(legacySubstatus)) {
			displaySubstatus = [...displaySubstatus, legacySubstatus];
		}
	}
	const activeSubstatus = STATUS_BAR_SUBSTATUS_PRIORITY.find((tag) =>
		displaySubstatus.includes(tag),
	);
	const effective = getEffectiveNarratorDisplay(status, displaySubstatus);
	return {
		color: effective.color || "gray",
		accentShade: effective.accentShade,
		labelKey: activeSubstatus ? `status_${activeSubstatus}` : `status_${status}`,
	};
}
