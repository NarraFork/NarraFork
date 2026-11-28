import type { TokenDanceCatalogModel, TokenDanceRecoveryAction } from "@shared/tokendance";
import type { ToolResultImagesMode } from "@shared/tool-result-images";

export interface TokenDanceRuntimeConfig {
	apiKey: string;
	generation: number;
	disabled: boolean;
	toolResultImages?: ToolResultImagesMode;
}

/** Dependency-free runtime bridge: service binds it without importing settings into providers. */
export interface TokenDanceRuntime {
	getTokenDanceRuntimeConfig(): TokenDanceRuntimeConfig | undefined;
	assertTokenDanceConnection(generation: number, apiKey?: string): void;
	registerTokenDanceRequest(
		controller: AbortController,
		generation: number,
		apiKey?: string,
	): () => void;
	getTokenDanceCatalogModels(): TokenDanceCatalogModel[];
	setTokenDanceRecoveryAction?(
		action: TokenDanceRecoveryAction | undefined,
		generation: number,
		apiKey?: string,
	): boolean;
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
	apiKey?: string,
): boolean {
	// Without an affirmative login-identity check, a portal action could charge another user.
	return runtime?.setTokenDanceRecoveryAction?.(action, generation, apiKey) === true;
}
export function assertTokenDanceConnection(generation: number, apiKey?: string): void {
	// Explicit credentials can be used without the optional service bridge (e.g. a worker).
	if (!runtime) {
		if (apiKey) return;
		throw new Error("TokenDance connection is not configured.");
	}
	runtime.assertTokenDanceConnection(generation, apiKey);
}
export function registerTokenDanceRequest(
	controller: AbortController,
	generation: number,
	apiKey?: string,
): () => void {
	assertTokenDanceConnection(generation, apiKey);
	return runtime?.registerTokenDanceRequest(controller, generation, apiKey) ?? (() => {});
}
