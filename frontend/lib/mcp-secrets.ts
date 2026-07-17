export interface McpSecretDraftEntry {
	key: string;
	value: string;
	preserved?: boolean;
	dirty?: boolean;
}

export interface McpSecretPatch {
	set?: Record<string, string>;
	delete?: string[];
}

export function createPreservedMcpSecretEntries(
	keys: ReadonlyArray<string>,
): McpSecretDraftEntry[] {
	return keys.map((key) => ({ key, value: "", preserved: true }));
}

export function secretEntriesToRecord(
	entries: ReadonlyArray<McpSecretDraftEntry>,
): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const entry of entries) {
		const key = entry.key.trim();
		if (!key) continue;
		result[key] = entry.value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function buildMcpSecretPatch(
	entries: ReadonlyArray<McpSecretDraftEntry>,
	originalKeys: ReadonlyArray<string>,
): McpSecretPatch | undefined {
	const set: Record<string, string> = {};
	const activeKeys = new Set<string>();
	for (const entry of entries) {
		const key = entry.key.trim();
		if (!key) continue;
		activeKeys.add(key);
		if (entry.dirty || !entry.preserved) set[key] = entry.value;
	}

	const deleted = originalKeys.filter((key) => !activeKeys.has(key));
	if (Object.keys(set).length === 0 && deleted.length === 0) return undefined;
	return {
		...(Object.keys(set).length > 0 ? { set } : {}),
		...(deleted.length > 0 ? { delete: deleted } : {}),
	};
}
