import type { TextDocumentSource } from "@shared/pretext-layout/text-document";

const pending = new Set<string>();
function keys(source: TextDocumentSource): string[] {
	const prefix = [source.narratorId, source.toolUseId];
	const values = [];
	if (source.toolCallId) values.push(JSON.stringify([...prefix, "call", source.toolCallId]));
	if (source.messageId)
		values.push(
			JSON.stringify([...prefix, "message", source.messageId, source.executionAttempt ?? null]),
		);
	if (!values.length)
		values.push(JSON.stringify([...prefix, "attempt", source.executionAttempt ?? null]));
	return values;
}
export function queueDocumentFind(source: TextDocumentSource): void {
	for (const key of keys(source)) pending.add(key);
	if (pending.size > 64) pending.delete(pending.keys().next().value as string);
}
export function takeDocumentFind(source?: TextDocumentSource): boolean {
	if (!source) return false;
	const values = keys(source);
	const found = values.some((key) => pending.has(key));
	if (found) for (const key of values) pending.delete(key);
	return found;
}
