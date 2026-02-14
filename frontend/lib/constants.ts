export const CHAPTER_STATUS_COLORS: Record<string, string> = {
	active: "green",
	dormant: "yellow",
	merged: "blue",
	abandoned: "gray",
};

export const NARRATOR_STATUS_COLORS: Record<string, string> = {
	idle: "gray",
	thinking: "blue",
	waiting: "yellow",
	done: "green",
	archived: "dark",
	error: "red",
};

export const CONTAINER_STATUS_COLORS: Record<string, string> = {
	created: "gray",
	running: "green",
	paused: "yellow",
	stopped: "red",
	removed: "gray",
};

export const BUILTIN_MODELS = [
	{ value: "claude-haiku", label: "Haiku" },
	{ value: "claude-sonnet", label: "Sonnet" },
	{ value: "claude-opus", label: "Opus" },
];
