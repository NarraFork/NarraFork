import type { TokenDanceCatalogModel, TokenDanceRecoveryAction } from "@shared/tokendance";

/** Dependency-free runtime bridge: service binds it without importing settings into providers. */
export interface TokenDanceRuntime {
	getTokenDanceRuntimeConfig():
		| { apiKey: string; generation: number; disabled: boolean }
		| undefined;
	assertTokenDanceConnection(generation: number): void;
	registerTokenDanceRequest(controller: AbortController, generation: number): () => void;
	getTokenDanceCatalogModels(): TokenDanceCatalogModel[];
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
export function getTokenDanceRuntimeConfig() {
	return runtime?.getTokenDanceRuntimeConfig();
}
export function getTokenDanceCatalogModels(): TokenDanceCatalogModel[] {
	return runtime?.getTokenDanceCatalogModels() ?? [];
}
export function setTokenDanceRecoveryAction(
	action: TokenDanceRecoveryAction | undefined,
	generation: number,
): void {
	runtime?.setTokenDanceRecoveryAction?.(action, generation);
}
export function assertTokenDanceConnection(generation: number): void {
	if (!runtime) throw new Error("TokenDance connection is not configured.");
	runtime.assertTokenDanceConnection(generation);
}
export function registerTokenDanceRequest(
	controller: AbortController,
	generation: number,
): () => void {
	assertTokenDanceConnection(generation);
	if (!runtime) throw new Error("TokenDance connection is not configured.");
	return runtime.registerTokenDanceRequest(controller, generation);
}
