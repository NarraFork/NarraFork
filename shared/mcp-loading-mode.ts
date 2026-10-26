/** MCP server loading policy; unrelated to per-tool permission enablement. */
export type McpLoadingMode = "disabled" | "auto" | "resident";

export interface McpLoadingInput {
	mode?: unknown;
	enabled?: unknown;
}

export function resolveMcpLoadingMode(config: McpLoadingInput): McpLoadingMode {
	if (config.mode === "disabled" || config.mode === "auto" || config.mode === "resident") {
		return config.mode;
	}
	return config.enabled === false ? "disabled" : config.enabled === true ? "resident" : "auto";
}

/** Persisted settings are repaired using mode as the authoritative value. */
export function normalizeMcpLoadingConfig<T extends McpLoadingInput>(
	config: T,
): T & { mode: McpLoadingMode; enabled: boolean } {
	const mode = resolveMcpLoadingMode(config);
	return { ...config, mode, enabled: mode !== "disabled" };
}

/** Validate explicit writes, while persisted settings remain repairable on load. */
function validateMcpLoadingInput(input: McpLoadingInput): void {
	if (
		input.mode !== undefined &&
		input.mode !== "disabled" &&
		input.mode !== "auto" &&
		input.mode !== "resident"
	) {
		throw new Error("Invalid MCP mode: expected disabled, auto or resident");
	}
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
		throw new Error("Invalid MCP enabled: expected boolean");
	}
	if (hasMcpLoadingConflict(input)) throw new Error("MCP mode conflicts with enabled");
}

/** API writes must not express two contradictory connection intents. */
export function hasMcpLoadingConflict(input: McpLoadingInput): boolean {
	return (
		input.mode !== undefined &&
		typeof input.enabled === "boolean" &&
		input.enabled !== (input.mode !== "disabled")
	);
}

export function applyMcpLoadingPatch(
	current: McpLoadingInput,
	patch: McpLoadingInput,
): { mode: McpLoadingMode; enabled: boolean } {
	validateMcpLoadingInput(patch);
	let mode = resolveMcpLoadingMode(current);
	if (patch.mode !== undefined) mode = resolveMcpLoadingMode(patch);
	else if (patch.enabled === false) mode = "disabled";
	else if (patch.enabled === true && mode === "disabled") mode = "resident";
	return { mode, enabled: mode !== "disabled" };
}
