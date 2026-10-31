import type { TokenDanceCatalogModel, TokenDanceRecoveryAction } from "@shared/tokendance";

/** Dependency-free runtime bridge: service binds it without importing settings into providers. */
export interface TokenDanceRuntime {
	getTokenDanceRuntimeConfig(
		prefix?: string,
	): { apiKey: string; generation: number; disabled: boolean } | undefined;
	assertTokenDanceConnection(generation: number, prefix?: string): void;
	registerTokenDanceRequest(
		controller: AbortController,
		generation: number,
		prefix?: string,
	): () => void;
	getTokenDanceCatalogModels(prefix?: string): TokenDanceCatalogModel[];
	setTokenDanceRecoveryAction?(
		action: TokenDanceRecoveryAction | undefined,
		generation: number,
	): void;
}
let runtime: TokenDanceRuntime | undefined;
export function registerTokenDanceRuntime(value: TokenDanceRuntime): () => void {
	runtime = value;
	return () => {
		if (runtime === value) runtime = undefined;
	};
}
export function getTokenDanceRuntimeConfig(prefix?: string) {
	return runtime?.getTokenDanceRuntimeConfig(prefix);
}
export function getTokenDanceCatalogModels(prefix?: string): TokenDanceCatalogModel[] {
	return runtime?.getTokenDanceCatalogModels(prefix) ?? [];
}
export function setTokenDanceRecoveryAction(
	action: TokenDanceRecoveryAction | undefined,
	generation: number,
): void {
	runtime?.setTokenDanceRecoveryAction?.(action, generation);
}
export function assertTokenDanceConnection(generation: number, prefix?: string): void {
	if (!runtime) throw new Error("TokenDance connection is not configured.");
	runtime.assertTokenDanceConnection(generation, prefix);
}
export function registerTokenDanceRequest(
	controller: AbortController,
	generation: number,
	prefix?: string,
): () => void {
	assertTokenDanceConnection(generation, prefix);
	if (!runtime) throw new Error("TokenDance connection is not configured.");
	return runtime.registerTokenDanceRequest(controller, generation, prefix);
}
