export interface ResizePermissionForm {
	prediction: unknown;
	height?: number;
}

export type ResizePermissionResolver = (
	toolUseId: string,
	width: number,
) => ResizePermissionForm | undefined;

/**
 * Re-key only live permission reserves, never walk arbitrary tool input/output.
 * A tool card, a grouped card array and a trace's `items[].card` are the only
 * structural containers. Missing runtime context still discards a stale reading.
 */
export function reflowPermissionForms(
	data: unknown,
	width: number,
	resolve: ResizePermissionResolver | undefined,
	depth = 0,
): unknown {
	if (depth > 3 || data == null || typeof data !== "object") return data;
	if (Array.isArray(data)) {
		let next: unknown[] | undefined;
		for (let i = 0; i < data.length; i++) {
			const value = reflowPermissionForms(data[i], width, resolve, depth + 1);
			if (value !== data[i]) {
				next ??= data.slice();
				next[i] = value;
			}
		}
		return next ?? data;
	}
	const record = data as Record<string, unknown>;
	let next: Record<string, unknown> | undefined;
	if (record.permissionForm && typeof record.toolUseId === "string") {
		const old = record.permissionForm as ResizePermissionForm;
		const form = resolve?.(record.toolUseId, width) ?? { prediction: old.prediction };
		if (form.prediction !== old.prediction || form.height !== old.height)
			next = { ...record, permissionForm: form };
	}
	for (const key of ["items", "card", "toolCalls"]) {
		if (record[key] == null) continue;
		const value = reflowPermissionForms(record[key], width, resolve, depth + 1);
		if (value !== record[key]) {
			next ??= { ...record };
			next[key] = value;
		}
	}
	return next ?? data;
}
