import { authorizedFetch } from "@frontend/lib/api/client";
import { assetUrl } from "@frontend/lib/base-path";
import {
	PLUGIN_UI_RUNTIME_CSS_URL,
	PLUGIN_UI_RUNTIME_JS_URL,
} from "@frontend/plugin-runtime/paths";
import {
	type IntelligentUiKitBundle,
	type IntelligentUiKitRequest,
	type IntelligentUiKitStatus,
	INTELLIGENT_UI_KIT_LIMITS as LIMITS,
} from "@shared/intelligent-ui-kit";

export interface KitOverview {
	status: IntelligentUiKitStatus;
	request: IntelligentUiKitRequest | null;
}

/** What a preview frame loads before any UI: a project kit, or the built-in runtime. */
export interface UiRuntime {
	runtimeJs: string;
	runtimeCss: string;
	/** True when this is the project's own component kit. */
	kit: boolean;
	/** Identity of the runtime; a frame is rebuilt only when it changes. */
	id: string;
}

/** Bound network reads before collecting text, including static runtime assets. */
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await response.body?.cancel();
		throw new Error("Preview response exceeds its size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty preview response");
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Preview response exceeds its size limit");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function runtimeAsset(path: string): Promise<string> {
	const response = await fetch(assetUrl(path), {
		signal: AbortSignal.timeout(30_000),
		credentials: "omit",
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Shared UI runtime unavailable (${response.status})`);
	}
	return boundedText(response, 8 * 1024 * 1024);
}

/** Resolves with `work`, or rejects as soon as the caller stops waiting for it. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

// The built-in runtime is the same megabyte for every card on the page and only changes
// with a host upgrade (a page load). One fetch is shared; a failure is not remembered.
let builtin: Promise<UiRuntime> | undefined;

export function loadBuiltinRuntime(signal: AbortSignal): Promise<UiRuntime> {
	if (!builtin) {
		const pending = Promise.all([
			runtimeAsset(PLUGIN_UI_RUNTIME_JS_URL),
			runtimeAsset(PLUGIN_UI_RUNTIME_CSS_URL),
		]).then(
			([runtimeJs, runtimeCss]): UiRuntime => ({
				runtimeJs,
				runtimeCss,
				kit: false,
				id: "builtin",
			}),
		);
		builtin = pending;
		pending.catch(() => {
			if (builtin === pending) builtin = undefined;
		});
	}
	return unlessAborted(builtin, signal);
}

const base = (narratorId: string) =>
	`/api/narrators/${encodeURIComponent(narratorId)}/intelligent-ui/kit`;

async function json<T>(response: Response, maxBytes: number): Promise<T> {
	const text = await boundedText(response, maxBytes);
	if (!response.ok) {
		let message = `Component kit request failed (${response.status})`;
		try {
			const data = JSON.parse(text);
			if (typeof data.error === "string") message = data.error.slice(0, 600);
		} catch {
			// Do not display arbitrary HTML returned by an upstream proxy.
		}
		throw new Error(message);
	}
	return JSON.parse(text) as T;
}

// Every card in a conversation asks the same question at the same moment (a reload, a
// scroll through history). They share one answer for a few seconds; kit state changes
// on the scale of builds, not frames.
const OVERVIEW_TTL_MS = 3000;
const overviews = new Map<string, { at: number; value: Promise<KitOverview> }>();

/** The workspace's kit state and any build awaiting the user's confirmation. */
export function loadKitOverview(narratorId: string, signal: AbortSignal): Promise<KitOverview> {
	const cached = overviews.get(narratorId);
	if (cached && Date.now() - cached.at < OVERVIEW_TTL_MS)
		return unlessAborted(cached.value, signal);
	const value = authorizedFetch(base(narratorId), {
		signal: AbortSignal.timeout(20_000),
		cache: "no-store",
		redirect: "error",
	}).then((response) => json<KitOverview>(response, 256 * 1024));
	overviews.delete(narratorId);
	overviews.set(narratorId, { at: Date.now(), value });
	if (overviews.size > 8) overviews.delete(overviews.keys().next().value as string);
	value.catch(() => {
		if (overviews.get(narratorId)?.value === value) overviews.delete(narratorId);
	});
	return unlessAborted(value, signal);
}

/** Call after anything that changes kit or request state, so the next read is fresh. */
export function forgetKitOverview(narratorId: string): void {
	overviews.delete(narratorId);
}

// A kit is megabytes and every inline card needs it. Kept only for the kits on screen:
// two entries cover "this conversation" plus the one being switched away from.
const kits = new Map<string, Promise<UiRuntime>>();

async function loadKitBundle(narratorId: string, hash: string): Promise<UiRuntime> {
	const response = await authorizedFetch(`${base(narratorId)}/bundle`, {
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	});
	// JSON-escaped source can approach twice its byte size.
	const bundle = await json<IntelligentUiKitBundle>(
		response,
		(LIMITS.bundleJsBytes + LIMITS.bundleCssBytes) * 2 + 64 * 1024,
	);
	if (typeof bundle.js !== "string" || typeof bundle.css !== "string")
		throw new Error("Invalid component kit bundle");
	return {
		runtimeJs: bundle.js,
		runtimeCss: bundle.css,
		kit: true,
		id: `kit:${bundle.hash || hash}`,
	};
}

/**
 * The runtime UI should render with.
 *
 * `prefer` is what a FINISHED call recorded: UI drawn with the built-in components keeps
 * using them after the workspace gains a project kit (and would be a row of unknown tags
 * otherwise). Without it, the workspace's current state decides: the project kit when one
 * is built, the built-in components when there is none.
 *
 * A reader who cannot see kit state at all (no write access) gets the built-in runtime.
 * A kit that exists but fails to load is an error, not a silent switch to components the
 * markup was never written for.
 */
export async function loadUiRuntime(
	narratorId: string,
	signal: AbortSignal,
	prefer?: "builtin" | "project",
): Promise<UiRuntime> {
	if (prefer === "builtin") return loadBuiltinRuntime(signal);
	let overview: KitOverview;
	try {
		overview = await loadKitOverview(narratorId, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		return loadBuiltinRuntime(signal);
	}
	const hash = overview.status.hash;
	if (!hash) return loadBuiltinRuntime(signal);
	const key = `${narratorId}:${hash}`;
	let pending = kits.get(key);
	if (!pending) {
		pending = loadKitBundle(narratorId, hash);
		kits.set(key, pending);
		const created = pending;
		created.catch(() => {
			if (kits.get(key) === created) kits.delete(key);
		});
		if (kits.size > 2) kits.delete(kits.keys().next().value as string);
	}
	return unlessAborted(pending, signal);
}

async function post(narratorId: string, action: "approve" | "dismiss", requestId: string) {
	forgetKitOverview(narratorId);
	return authorizedFetch(`${base(narratorId)}/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requestId }),
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
	});
}

/** The user's confirmation that the agent may build or update the kit. */
export async function approveKitRequest(
	narratorId: string,
	requestId: string,
): Promise<KitOverview> {
	return json<KitOverview>(await post(narratorId, "approve", requestId), 256 * 1024);
}

export async function dismissKitRequest(narratorId: string, requestId: string): Promise<void> {
	await json<unknown>(await post(narratorId, "dismiss", requestId), 16 * 1024);
}

/** Test seam: module caches must not leak between cases. */
export function resetUiRuntimeCachesForTest(): void {
	builtin = undefined;
	overviews.clear();
	kits.clear();
}
