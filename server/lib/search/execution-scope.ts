import { AsyncLocalStorage } from "node:async_hooks";

export interface SearchExecutionScope {
	readonly provider: string;
	readonly model: string;
	readonly maxTurns: number;
	remainingTurns: number;
}

const scopes = new AsyncLocalStorage<SearchExecutionScope>();

/** A separate budget per invocation; nested/concurrent searches never share state. */
export function withSearchExecutionScope<T>(
	options: { provider: string; model: string; maxTurns: number },
	fn: () => T,
): T {
	if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
		throw new Error("Search maxTurns must be a positive safe integer");
	}
	return scopes.run({ ...options, remainingTurns: options.maxTurns }, fn);
}

export function getSearchExecutionScope(): SearchExecutionScope | undefined {
	return scopes.getStore();
}

export function matchesSearchExecutionScope(provider: string, model: string): boolean {
	const scope = getSearchExecutionScope();
	const bareModel = (value: string) =>
		value.startsWith(`${provider}:`) ? value.slice(provider.length + 1) : value;
	return !!scope && scope.provider === provider && bareModel(scope.model) === bareModel(model);
}

export class SearchExecutionBudgetExceededError extends Error {
	constructor() {
		super("Search execution turn budget exhausted");
		this.name = "SearchExecutionBudgetExceededError";
	}
}

/** Called immediately before every provider request, including retries/reflections. */
export function consumeSearchExecutionTurn(): void {
	const scope = getSearchExecutionScope();
	if (!scope) return;
	if (scope.remainingTurns <= 0) throw new SearchExecutionBudgetExceededError();
	scope.remainingTurns--;
}
