export interface FilteredMcpImportTransports {
	json: unknown;
	skippedUnsupportedTransport: number;
	allRecognizedServersSkipped: boolean;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSingleMcpServerImportConfig(value: Record<string, unknown>): boolean {
	return (
		typeof value.url === "string" ||
		typeof value.command === "string" ||
		(typeof value.type === "string" && ["stdio", "sse", "streamable-http"].includes(value.type))
	);
}

function isUnsupportedMcpImportTransport(value: unknown): boolean {
	if (!isObjectRecord(value)) return false;
	const rawTransport = typeof value.transport === "string" ? value.transport : value.type;
	const transport = typeof rawTransport === "string" ? rawTransport.trim().toLowerCase() : "";
	if (transport && transport !== "stdio") return true;
	return !transport && typeof value.url === "string" && typeof value.command !== "string";
}

function filterMcpImportServerMap(serverMap: Record<string, unknown>): {
	serverMap: Record<string, unknown>;
	skippedUnsupportedTransport: number;
} {
	const filtered: Record<string, unknown> = {};
	let skippedUnsupportedTransport = 0;
	for (const [name, config] of Object.entries(serverMap)) {
		if (isUnsupportedMcpImportTransport(config)) {
			skippedUnsupportedTransport++;
			continue;
		}
		filtered[name] = config;
	}
	return { serverMap: filtered, skippedUnsupportedTransport };
}

export function filterUnsupportedMcpImportTransports(json: unknown): FilteredMcpImportTransports {
	if (!isObjectRecord(json)) {
		return { json, skippedUnsupportedTransport: 0, allRecognizedServersSkipped: false };
	}

	if (isObjectRecord(json.mcpServers)) {
		const result = filterMcpImportServerMap(json.mcpServers);
		return {
			json: { ...json, mcpServers: result.serverMap },
			skippedUnsupportedTransport: result.skippedUnsupportedTransport,
			allRecognizedServersSkipped:
				result.skippedUnsupportedTransport > 0 && Object.keys(result.serverMap).length === 0,
		};
	}

	if (isObjectRecord(json.servers)) {
		const result = filterMcpImportServerMap(json.servers);
		return {
			json: { ...json, servers: result.serverMap },
			skippedUnsupportedTransport: result.skippedUnsupportedTransport,
			allRecognizedServersSkipped:
				result.skippedUnsupportedTransport > 0 && Object.keys(result.serverMap).length === 0,
		};
	}

	if (isSingleMcpServerImportConfig(json)) {
		const unsupported = isUnsupportedMcpImportTransport(json);
		return {
			json: unsupported ? { mcpServers: {} } : json,
			skippedUnsupportedTransport: unsupported ? 1 : 0,
			allRecognizedServersSkipped: unsupported,
		};
	}

	const keys = Object.keys(json);
	const looksLikeServerMap = keys.length > 0 && keys.every((key) => isObjectRecord(json[key]));
	if (!looksLikeServerMap) {
		return { json, skippedUnsupportedTransport: 0, allRecognizedServersSkipped: false };
	}
	const result = filterMcpImportServerMap(json);
	return {
		json: result.serverMap,
		skippedUnsupportedTransport: result.skippedUnsupportedTransport,
		allRecognizedServersSkipped:
			result.skippedUnsupportedTransport > 0 && Object.keys(result.serverMap).length === 0,
	};
}
