export interface QuestionModelReceipt {
	id: string;
	text: string;
}

/** Inspect only actual provider input, never the DB snapshot or tool audit output. */
export function modelInputContainsText(value: unknown, text: string): boolean {
	if (!text) return false;
	if (typeof value === "string") return value.includes(text);
	if (Array.isArray(value)) return value.some((entry) => modelInputContainsText(entry, text));
	if (value && typeof value === "object") {
		const row = value as Record<string, unknown>;
		if (
			["assistant", "model", "system", "developer", "tool"].includes(String(row.role)) ||
			row.type === "tool_result" ||
			row.type === "function_call_output" ||
			row.type === "function_result" ||
			row.functionResponse ||
			row.toolUseId
		)
			return false;
		return Object.values(row).some((entry) => modelInputContainsText(entry, text));
	}
	return false;
}

/** Detached, protocol-independent projection at the final provider supply boundary. */
export function projectQuestionModelInput(
	history: unknown[],
	content: string,
	toolResults: unknown[],
	receipts: readonly QuestionModelReceipt[],
): { history: unknown[]; toolResults: unknown[]; answerEventIds: Set<string> } {
	const answerEventIds = new Set<string>();
	for (const receipt of receipts) {
		if (modelInputContainsText(history, receipt.text) || content.includes(receipt.text))
			answerEventIds.add(receipt.id);
	}
	// User receipts win regardless of tool-result ordering. Otherwise retain the
	// first full fallback in the supplied history, then in the current results.
	const seen = new Set(answerEventIds);
	const project = (value: unknown, inToolResult = false): unknown => {
		if (typeof value === "string") {
			if (!inToolResult) return value;
			const match = /^<question_answer_fallback event="([A-Za-z0-9_-]{1,100})">\n/.exec(value);
			if (!match) return value;
			const id = match[1];
			answerEventIds.add(id);
			if (!seen.has(id)) {
				seen.add(id);
				return value;
			}
			return `The user answered. Answer event: ${id}. The complete receipt is already supplied in this model input; use Question action=get and Question action=resolve for handling.`;
		}
		if (Array.isArray(value)) {
			const entries = value.map((entry) => project(entry, inToolResult));
			return entries.some((entry, index) => entry !== value[index]) ? entries : value;
		}
		if (value && typeof value === "object") {
			const row = value as Record<string, unknown>;
			const result =
				inToolResult ||
				row.role === "tool" ||
				["tool_result", "function_call_output", "function_result"].includes(String(row.type));
			const original = Object.entries(row);
			const entries = original.map(
				([key, entry]) => [key, project(entry, result || key === "functionResponse")] as const,
			);
			return entries.some(([, entry], index) => entry !== original[index][1])
				? Object.fromEntries(entries)
				: value;
		}
		return value;
	};
	return {
		history: project(history) as unknown[],
		toolResults: project(toolResults, true) as unknown[],
		answerEventIds,
	};
}
