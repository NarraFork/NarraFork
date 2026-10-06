import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { extractUpdateFailureDiagnostic, useUpdateCheck } from "./useUpdateCheck";

describe("extractUpdateFailureDiagnostic", () => {
	test("prefers reason, then message, error, code, and fallback", () => {
		expect(
			extractUpdateFailureDiagnostic({
				code: "DOWNLOAD_FAILED",
				reason: "Download failed from upstream",
				message: "Download failed",
				error: "generic",
			}),
		).toEqual({
			error: "Download failed from upstream",
			code: "DOWNLOAD_FAILED",
			reason: "Download failed from upstream",
			message: "Download failed",
		});

		expect(extractUpdateFailureDiagnostic({ message: "Message first" })).toEqual({
			error: "Message first",
			code: undefined,
			reason: undefined,
			message: "Message first",
		});

		expect(extractUpdateFailureDiagnostic({ error: "Error first" })).toEqual({
			error: "Error first",
			code: undefined,
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({ code: "CODE_ONLY" })).toEqual({
			error: "CODE_ONLY",
			code: "CODE_ONLY",
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({}, "Fallback message")).toEqual({
			error: "Fallback message",
			code: undefined,
			reason: undefined,
			message: undefined,
		});
	});
});

/**
 * The admin gate on the update check.
 *
 * `GET /api/update/check` is admin-only, and `UpdateBadge` mounts for EVERY signed-in user through
 * the app shell. Without the gate inside `useUpdateCheck`, each non-admin session issued a
 * guaranteed 403 per refetch interval (plus the query default's retry) while the badge stayed
 * hidden anyway. Eyeballing the `enabled` expression is not enough here: the failure mode is a
 * request that should never leave, so these tests count actual `queryFn` invocations.
 */
const DOM_GLOBAL_KEYS = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

function installDom(): () => void {
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of DOM_GLOBAL_KEYS) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	}
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const store = new Map<string, string>();
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		// `useCurrentUser` reads the token through `getToken()` during render, which touches
		// localStorage directly.
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	for (const key of DOM_GLOBAL_KEYS) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: previous.get(key)?.enumerable ?? true,
			writable: true,
			value: values[key],
		});
	}
	return () => {
		// Restore in full so this file cannot leak DOM globals into sibling test files.
		for (const key of [...DOM_GLOBAL_KEYS].reverse()) {
			const descriptor = previous.get(key);
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
}

async function settle() {
	for (let turn = 0; turn < 4; turn++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

type CheckUpdateResult = Awaited<ReturnType<typeof api.checkUpdate>>;
type UpdateCheckResult = ReturnType<typeof useUpdateCheck>;

let restoreDom: (() => void) | null = null;
let queryClient: QueryClient | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renders: UpdateCheckResult[] = [];
let checkUpdateCalls = 0;
const originalCheckUpdate = api.checkUpdate;

function Harness() {
	renders.push(useUpdateCheck());
	return null;
}

/** Seed `["auth", "me"]` so `useCurrentUser` resolves from cache without a request. */
async function mountAs(role: "admin" | "user") {
	if (!queryClient || !root) throw new Error("harness is not initialized");
	queryClient.setQueryData(["auth", "me"], { id: "u1", username: "tester", role });
	root.render(
		createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, {})),
	);
	await settle();
}

function latest(): UpdateCheckResult {
	const last = renders.at(-1);
	if (!last) throw new Error("hook never rendered");
	return last;
}

beforeEach(() => {
	restoreDom = installDom();
	renders = [];
	checkUpdateCalls = 0;
	api.checkUpdate = async () => {
		checkUpdateCalls++;
		return {
			updateAvailable: true,
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
		} as CheckUpdateResult;
	};
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = null;
	queryClient?.clear();
	queryClient = null;
	await settle();
	container?.remove();
	container = null;
	// Restore the patched API method and the DOM globals even if an expectation threw.
	api.checkUpdate = originalCheckUpdate;
	restoreDom?.();
	restoreDom = null;
});

describe("useUpdateCheck admin gate", () => {
	test("a non-admin never calls the admin-only check endpoint", async () => {
		await mountAs("user");

		expect(checkUpdateCalls).toBe(0);
		const state = queryClient?.getQueryState(["update-check"]);
		expect(state?.fetchStatus).toBe("idle");
		expect(state?.status).toBe("pending");
		expect(latest().updateAvailable).toBe(false);
		// A disabled v5 query is `pending` but not `fetching`, so `isLoading` is false: a caller
		// gating a skeleton on it will not spin forever for regular users.
		expect(latest().isLoading).toBe(false);
	});

	test("a non-admin's manual refetch stays blocked by the gate", async () => {
		await mountAs("user");
		await latest().refetch();
		await settle();

		expect(checkUpdateCalls).toBe(0);
		expect(latest().updateAvailable).toBe(false);
	});

	test("an admin still performs the check", async () => {
		await mountAs("admin");

		expect(checkUpdateCalls).toBe(1);
		expect(latest().updateAvailable).toBe(true);
		expect(latest().latestVersion).toBe("1.1.0");
		expect(latest().isLoading).toBe(false);
	});
});
