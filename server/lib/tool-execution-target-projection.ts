/**
 * Project the stored execution-target columns of a tool call into the API shape.
 *
 * A tool call records its target twice: as the structured `executionTargetsJson`
 * plan, and as the flat `executionDeviceId`/`executionCwd`/… columns that predate
 * it. Readers must not care which one a given row has, so this is the single
 * place that reconciles them — extracted from `narrator-messages` so the global
 * execution log projects targets identically to the per-narrator views instead of
 * growing a second, drifting copy.
 */
export type ApiExecutionTarget = {
	deviceId: string;
	backendKind: "local" | "remote";
	cwd: string;
	pathFlavor?: "posix" | "windows" | "spec";
	lexicalPath?: string;
	canonicalPath?: string;
	runtimeGeneration?: number;
	resolvedFilePath?: string;
	selectionSource: "explicit" | "session_default" | "local_default";
};

export function isApiExecutionTarget(value: unknown): value is ApiExecutionTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const target = value as Partial<ApiExecutionTarget>;
	return (
		typeof target.deviceId === "string" &&
		(target.backendKind === "local" || target.backendKind === "remote") &&
		typeof target.cwd === "string" &&
		(target.selectionSource === "explicit" ||
			target.selectionSource === "session_default" ||
			target.selectionSource === "local_default")
	);
}

export function toolCallWithExecutionTargets<T extends Record<string, unknown>>(
	toolCall: T,
): T & {
	executionTarget: ApiExecutionTarget | null;
	executionTargets: ApiExecutionTarget[];
	executionPlan: Record<string, unknown> | null;
} {
	const rawPlan =
		toolCall.executionTargetsJson &&
		typeof toolCall.executionTargetsJson === "object" &&
		!Array.isArray(toolCall.executionTargetsJson) &&
		Array.isArray((toolCall.executionTargetsJson as { endpoints?: unknown }).endpoints)
			? (toolCall.executionTargetsJson as {
					kind?: unknown;
					primaryKey?: unknown;
					endpoints: Array<{ target?: unknown }>;
				})
			: null;
	const rawTargets = Array.isArray(toolCall.executionTargetsJson)
		? toolCall.executionTargetsJson
		: rawPlan
			? rawPlan.endpoints.map((endpoint) => endpoint.target)
			: isApiExecutionTarget(toolCall.executionTargetsJson)
				? [toolCall.executionTargetsJson]
				: [];
	const executionTargets = rawTargets.filter(isApiExecutionTarget).map((target) => {
		const lexicalPath = target.lexicalPath ?? target.resolvedFilePath;
		return {
			...target,
			...(lexicalPath !== undefined && { lexicalPath, resolvedFilePath: lexicalPath }),
		};
	});
	if (
		executionTargets.length === 0 &&
		typeof toolCall.executionDeviceId === "string" &&
		typeof toolCall.executionCwd === "string" &&
		(toolCall.deviceSelectionSource === "explicit" ||
			toolCall.deviceSelectionSource === "session_default" ||
			toolCall.deviceSelectionSource === "local_default")
	) {
		const lexicalPath =
			typeof toolCall.resolvedFilePath === "string" ? toolCall.resolvedFilePath : undefined;
		executionTargets.push({
			deviceId: toolCall.executionDeviceId,
			backendKind: toolCall.executionDeviceId === "local" ? "local" : "remote",
			cwd: toolCall.executionCwd,
			...(toolCall.executionPathFlavor === "posix" ||
			toolCall.executionPathFlavor === "windows" ||
			toolCall.executionPathFlavor === "spec"
				? { pathFlavor: toolCall.executionPathFlavor }
				: {}),
			...(lexicalPath && { lexicalPath, resolvedFilePath: lexicalPath }),
			...(typeof toolCall.canonicalFilePath === "string"
				? { canonicalPath: toolCall.canonicalFilePath }
				: {}),
			...(typeof toolCall.runtimeGeneration === "number"
				? { runtimeGeneration: toolCall.runtimeGeneration }
				: {}),
			selectionSource: toolCall.deviceSelectionSource,
		});
	}
	return {
		...toolCall,
		executionTarget: executionTargets[0] ?? null,
		executionTargets,
		executionPlan: rawPlan ? (rawPlan as Record<string, unknown>) : null,
	};
}
