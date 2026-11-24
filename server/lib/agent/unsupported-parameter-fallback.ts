import { logger } from "../logger";

/** Optional field rejections (for example prompt_cache_key) are learned per model,
 * in memory only. Never learn to discard an output budget: that turns a bounded
 * request into an unbounded retry, and can affect unrelated later requests. */
const outputBudgetFields = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"]);
const unsupportedParametersByModel = new Map<string, Set<string>>();

/**
 * Bound the learned map. Keys are caller-supplied model ids, so an unbounded
 * map is a slow leak in a long-lived process.
 */
const MAX_REMEMBERED_MODELS = 200;

/** Observed shapes: `Unsupported parameter: foo`, `Unsupported parameter: "foo"`. */
const UNSUPPORTED_PARAMETER_PATTERN =
	/unsupported parameter:?\s*["'`]?([A-Za-z0-9_.-]{1,64})["'`]?/i;

/** Extract the rejected parameter name from provider/gateway error text. */
export function parseUnsupportedParameter(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const match = UNSUPPORTED_PARAMETER_PATTERN.exec(text);
	return match?.[1];
}

/** Test seam: forget everything learned so far. */
export function resetUnsupportedParameterMemory(): void {
	unsupportedParametersByModel.clear();
}

/** Whether this model already rejected the given request field. */
export function modelRejectsParameter(model: string, parameter: string): boolean {
	return unsupportedParametersByModel.get(model)?.has(parameter) ?? false;
}

function rememberUnsupportedParameter(model: string, parameter: string): void {
	let set = unsupportedParametersByModel.get(model);
	if (!set) {
		if (unsupportedParametersByModel.size >= MAX_REMEMBERED_MODELS) {
			// Drop the oldest insertion (Map preserves order) rather than clearing
			// everything, so the busiest models keep their learned state.
			const oldest = unsupportedParametersByModel.keys().next();
			if (!oldest.done) unsupportedParametersByModel.delete(oldest.value);
		}
		set = new Set();
		unsupportedParametersByModel.set(model, set);
	}
	set.add(parameter);
}

/**
 * Strip the field this error rejected and remember it for `model`.
 * Returns true when a field was actually removed (callers may then retry).
 */
export function stripUnsupportedParameter(
	body: Record<string, unknown>,
	model: string,
	err: unknown,
): boolean {
	const parameter = unsupportedParameterFromError(err);
	if (!parameter || outputBudgetFields.has(parameter) || !Object.hasOwn(body, parameter))
		return false;
	delete body[parameter];
	rememberUnsupportedParameter(model, parameter);
	logger.warn("Endpoint rejected a request parameter; stripping it for retry", {
		model,
		parameter,
		error: err instanceof Error ? err.message : String(err),
	});
	return true;
}

/**
 * Drop every field this model is known to reject. Applied before every send so
 * a later request never re-pays the doomed first attempt.
 */
export function omitUnsupportedParameters(body: Record<string, unknown>, model: string): void {
	const set = unsupportedParametersByModel.get(model);
	if (!set) return;
	for (const parameter of set) {
		if (!outputBudgetFields.has(parameter)) delete body[parameter];
	}
}

/** Collect human-readable provider text from an error graph (bounded depth). */
function errorTextCandidates(err: unknown): string[] {
	if (err == null) return [];
	if (typeof err !== "object") return [String(err)];
	const obj = err as Record<string, unknown>;
	const nested =
		obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : undefined;
	const cause =
		obj.cause && typeof obj.cause === "object" ? (obj.cause as Record<string, unknown>) : undefined;
	const diagnostics =
		obj.diagnostics && typeof obj.diagnostics === "object"
			? (obj.diagnostics as Record<string, unknown>)
			: undefined;
	return [
		obj.message,
		typeof obj.error === "string" ? obj.error : undefined,
		nested?.message,
		cause?.message,
		diagnostics?.message,
		diagnostics?.responseSnippet,
		typeof diagnostics?.reason === "string" ? diagnostics.reason : undefined,
	].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** The parameter this error rejected, if any. */
export function unsupportedParameterFromError(err: unknown): string | undefined {
	// A model can quote a parameter error in its refusal. Neither retry this
	// request nor teach later requests to omit the quoted field.
	if (err && typeof err === "object" && "reason" in err && err.reason === "refusal") {
		return undefined;
	}
	for (const text of errorTextCandidates(err)) {
		const parameter = parseUnsupportedParameter(text);
		if (parameter) return parameter;
	}
	return undefined;
}

export function isUnsupportedParameterError(err: unknown): boolean {
	return unsupportedParameterFromError(err) !== undefined;
}

/**
 * Retry once only when the pre-dispatch fallback can safely omit the rejected
 * field. Preserve the original upstream error when the field is a token ceiling.
 */
export async function withUnsupportedParameterFallback<T>(
	model: string,
	body: Record<string, unknown>,
	run: (body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
	omitUnsupportedParameters(body, model);
	try {
		return await run(body);
	} catch (err) {
		if (!stripUnsupportedParameter(body, model, err)) throw err;
		return run(body);
	}
}
