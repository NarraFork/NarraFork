import type { AgentSideCar } from "./types";

export interface StoredSideCar extends AgentSideCar {
	id?: string;
	messageId?: string | null;
	createdAt?: string;
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function sortSideCars<T extends Pick<AgentSideCar, "orderIndex">>(sideCars: T[]): T[] {
	return [...sideCars].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
}

export function outputToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const maybeText = (value as { _text?: unknown })._text;
		if (typeof maybeText === "string") return maybeText;
	}
	return value == null ? "" : JSON.stringify(value);
}

export function formatSideCarForApi(sideCar: AgentSideCar): string {
	const source = escapeAttr(sideCar.source || "sidecar");
	return `<side_car source="${source}">\n${sideCar.content}\n</side_car>`;
}

export function formatSideCarsForApi(sideCars: AgentSideCar[]): string {
	return sortSideCars(sideCars)
		.filter((sideCar) => sideCar.content.trim())
		.map(formatSideCarForApi)
		.join("\n\n");
}

export function appendSideCarsForApi(baseText: string, sideCars: AgentSideCar[]): string {
	const sideCarText = formatSideCarsForApi(sideCars);
	if (!sideCarText) return baseText;
	return baseText ? `${baseText}\n\n${sideCarText}` : sideCarText;
}

export function sideCarsForToolResult(
	sideCars: AgentSideCar[] | undefined,
	toolUseId: string,
): AgentSideCar[] {
	return sortSideCars(
		(sideCars ?? []).filter(
			(sideCar) =>
				sideCar.target === "tool_result" &&
				(sideCar.toolUseId === toolUseId || sideCar.toolUseId == null),
		),
	);
}

export function sideCarsForUserMessage(sideCars: AgentSideCar[] | undefined): AgentSideCar[] {
	return sortSideCars((sideCars ?? []).filter((sideCar) => sideCar.target === "user_message"));
}
