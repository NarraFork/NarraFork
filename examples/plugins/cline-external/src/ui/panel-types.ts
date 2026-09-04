/**
 * Shapes the panel reads, plus the command bridge.
 *
 * These mirror what `src/commands.ts` returns rather than importing it: the panel is browser
 * code and the command module pulls in the plugin's auth and model layers, so a shared import
 * would drag the whole backend into the iframe bundle.
 *
 * Every field here is metadata. No credential value is representable in these types, which is
 * the property that makes it safe for command output to reach a document at all.
 *
 * Field names are a contract with the backend: there is no shared type across the iframe
 * boundary — the payload is JSON and both sides see `unknown` — so a rename on one side is
 * invisible to the compiler and shows up only as a control that never appears. The UI contract
 * test pins the riskiest names (`browserAuth` and its three values) against both artifacts.
 */

export interface PluginUiSdk {
	request(method: string, params?: unknown): Promise<unknown>;
	notify(event: string, payload?: unknown): void;
}

/** Mirrors the `status` command's output. */
export interface StatusOutput {
	authenticated: boolean;
	credentialError?: string;
	email?: string;
	displayName?: string;
	expiresAt?: number;
	expired?: boolean;
	hasUserId?: boolean;
	enabledModelCount: number;
	enabledModels: string[];
	poolModelCount: number;
	browserAuth: "available" | "port_busy" | "unsupported";
	signInPending: boolean;
	/** Present only while a browser sign-in is pending, so a remount can show it again. */
	authorizeUrl?: string;
	chatBaseUrl?: string;
}

export interface PoolModel {
	id: string;
	name?: string;
	contextLength?: number;
	promptPrice?: string;
	completionPrice?: string;
}

export interface RecommendedModel {
	id: string;
	name: string;
	description?: string;
	tags: string[];
}

/** Mirrors the `recommended-models` command's output. */
export interface RecommendedOutput {
	recommended?: RecommendedModel[];
	free?: RecommendedModel[];
}

/** Mirrors the `models.search` command's output. */
export interface SearchOutput {
	models: PoolModel[];
	total: number;
	poolSize?: number;
}

/** Mirrors the `balance` command's output. Micro-dollars (1/1,000,000 USD). */
export interface BalanceOutput {
	balance?: number;
	userId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run a backend command.
 *
 * The host wraps a successful result as `{ status, output }`; unwrapping here keeps that
 * envelope out of every call site.
 */
export async function runCommand(
	sdk: PluginUiSdk,
	commandId: string,
	input?: Record<string, unknown>,
): Promise<unknown> {
	const raw = await sdk.request("commands.execute", {
		commandId,
		...(input === undefined ? {} : { input }),
	});
	if (isRecord(raw) && "output" in raw) return raw.output;
	return raw;
}

/** Readable message from a rejected command, whose errors carry a `code` and `message`. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.message === "string") return error.message;
	return String(error);
}
