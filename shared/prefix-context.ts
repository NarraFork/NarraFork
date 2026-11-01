/** Model-facing context is an immutable baseline followed by named replacements. */
export interface PromptPart {
	key: string;
	text: string;
}

export interface ContextChange {
	key: string;
	value: string | null;
}

export interface ContextUpdate {
	type: "context_update";
	epochId: string;
	changes: ContextChange[];
	/** Stored updates can keep large replacement bodies out of their message envelope. */
	snapshotRef?: string;
}

/** Only content references live in an epoch marker; large bodies are shared snapshots. */
export interface PrefixSnapshot {
	contract: string;
	parts: Array<{ key: string; hash: string }>;
	tools: string;
}

export function contextChanges(
	previous: ReadonlyMap<string, string>,
	current: readonly PromptPart[],
): ContextChange[] {
	const next = new Map(current.map((part) => [part.key, part.text]));
	const changes: ContextChange[] = [];
	for (const [key, value] of next) {
		if (previous.get(key) !== value) changes.push({ key, value });
	}
	for (const key of previous.keys()) {
		if (!next.has(key)) changes.push({ key, value: null });
	}
	return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function applyContextChanges(
	state: Map<string, string>,
	changes: readonly ContextChange[],
): void {
	for (const change of changes) {
		if (change.value === null) state.delete(change.key);
		else state.set(change.key, change.value);
	}
}

export function contextUpdateOf(block: unknown): ContextUpdate | undefined {
	if (!block || typeof block !== "object") return;
	const value = block as Partial<ContextUpdate>;
	if (
		value.type !== "context_update" ||
		typeof value.epochId !== "string" ||
		!Array.isArray(value.changes)
	)
		return;
	if (
		!value.changes.every(
			(part) =>
				part &&
				typeof part.key === "string" &&
				(part.value === null || typeof part.value === "string"),
		)
	)
		return;
	return value as ContextUpdate;
}

/** Generated once when a change is persisted, never re-rendered during history replay. */
export function renderContextUpdate(changes: readonly ContextChange[]): string {
	return [
		"<context_update>",
		"The host has updated the following named context sections. Replace their previous values; sections not listed remain unchanged. This does not change execution permissions or fixed safety rules.",
		...changes.map(
			({ key, value }) =>
				`\n[${key}]\n${value === null ? "This section has been removed." : value}`,
		),
		"</context_update>",
	].join("\n");
}

export function renderPrefixPrompt(contract: string, parts: readonly PromptPart[]): string {
	return [contract, ...parts.map(({ key, text }) => `## Context: ${key}\n\n${text}`)]
		.filter(Boolean)
		.join("\n\n");
}
