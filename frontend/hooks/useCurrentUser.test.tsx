import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { authApi, CURRENT_USER_TIMEOUT_MS } from "../lib/api/auth";
import { getAuthSnapshot, getToken, setToken } from "../lib/api/client";
import { readCurrentUserCache, writeCurrentUserCache } from "../lib/current-user-cache";
import { useAuthenticatedSession } from "./useAuthenticatedSession";

const user = { id: "u1", username: "alice", role: "user" };
let originals: Map<string, PropertyDescriptor | undefined>;
let client: QueryClient;
let root: Root;
let container: HTMLElement;
let state: ReturnType<typeof useAuthenticatedSession>;
let answer: (response: Response) => void;
let requestSignal: AbortSignal | null | undefined;
let ignoreAbort: boolean;
let calls: number;
let restoreTimeout: (() => void) | undefined;

function Harness() {
	state = useAuthenticatedSession();
	return (
		<div>{state.sessionLost || !state.hasToken ? "login" : state.data ? "shell" : "spinner"}</div>
	);
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Harness />
			</QueryClientProvider>,
		),
	);
	await flush();
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = new Map<string, string>();
	calls = 0;
	ignoreAbort = false;
	requestSignal = undefined;
	const replacements = {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		},
		fetch: (_input: unknown, init?: RequestInit) => {
			calls++;
			requestSignal = init?.signal;
			return new Promise<Response>((resolve, reject) => {
				answer = resolve;
				if (ignoreAbort) return;
				if (init?.signal?.aborted) reject(init.signal.reason);
				else
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
			});
		},
	};
	originals = new Map();
	for (const [key, value] of Object.entries(replacements)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	setToken("test-session");
	client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	restoreTimeout?.();
	restoreTimeout = undefined;
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("cached identity renders shell immediately, then expired session clears cache and redirects", async () => {
	writeCurrentUserCache(user);
	await render();
	expect(container.textContent).toBe("shell");
	expect(getAuthSnapshot().userId).toBeNull();
	expect(calls).toBe(1);
	expect(state.isFetching).toBe(true);
	answer(Response.json({ code: "TOKEN_EXPIRED" }, { status: 401 }));
	await flush();
	expect(readCurrentUserCache()).toBeUndefined();
	expect(getToken()).toBeNull();
	expect(container.textContent).toBe("login");
	expect(calls).toBe(1);
});
test("successful revalidation updates persisted profile", async () => {
	writeCurrentUserCache(user);
	await render();
	answer(Response.json({ ...user, username: "updated", token: "must-not-persist" }));
	await flush();
	expect(readCurrentUserCache()).toEqual({ ...user, username: "updated" });
	expect(getAuthSnapshot().userId).toBe(user.id);
});

test("fresh public me cache is not evidence for the current credential", async () => {
	client.setQueryData(["auth", "me"], user);
	await render();
	expect(calls).toBe(1);
	expect(getAuthSnapshot().userId).toBeNull();
	const other = { id: "u2", username: "bob", role: "user" };
	answer(Response.json(other));
	await flush();
	expect(getAuthSnapshot().userId).toBe(other.id);
	expect(client.getQueryData(["auth", "me"])).toEqual(other);
});

test("without preferences, a same-account credential rotation resets and refetches me", async () => {
	await render();
	answer(Response.json(user));
	await flush();
	const previous = getAuthSnapshot();
	expect(previous.userId).toBe(user.id);
	await act(async () => {
		setToken("renewed-session");
	});
	await flush();
	const replacement = getAuthSnapshot();
	expect(replacement.generation).toBeGreaterThan(previous.generation);
	expect(replacement.userId).toBeNull();
	expect(client.getQueryData(["auth", "me"])).toBeUndefined();
	expect(container.textContent).toBe("spinner");
	expect(calls).toBe(2);
	answer(Response.json(user));
	await flush();
	expect(getAuthSnapshot()).toEqual({ ...replacement, userId: user.id });
	expect(container.textContent).toBe("shell");
});

test("without preferences, A to B to A cancels both old me requests and ignores their results", async () => {
	ignoreAbort = true;
	await render();
	const firstA = getAuthSnapshot().generation;
	const answerOldA = answer;
	const signalA = requestSignal;
	await act(async () => {
		setToken("other-session");
	});
	const answerB = answer;
	const signalB = requestSignal;
	await act(async () => {
		setToken("test-session");
	});
	const currentA = getAuthSnapshot().generation;
	expect(currentA).toBeGreaterThan(firstA);
	expect(signalA?.aborted).toBe(true);
	expect(signalB?.aborted).toBe(true);
	expect(calls).toBe(3);
	answerOldA(Response.json({ ...user, username: "outdated" }));
	answerB(Response.json({ ...user, id: "u2" }));
	await flush();
	expect(getAuthSnapshot().userId).toBeNull();
	expect(client.getQueryData(["auth", "me"])).toBeUndefined();
	expect(readCurrentUserCache()).toBeUndefined();
	answer(Response.json(user));
	await flush();
	expect(getAuthSnapshot()).toEqual({ generation: currentA, hasToken: true, userId: user.id });
	expect(client.getQueryData(["auth", "me"])).toEqual(user);
});

test("an uncancelled me request from a previous lifetime cannot bind the reused credential", async () => {
	const oldMe = authApi.me();
	const answerOldMe = answer;
	const oldSignal = requestSignal;
	setToken("other-session");
	const generation = setToken("test-session");
	answerOldMe(Response.json(user));
	await expect(oldMe).rejects.toThrow("Session changed");
	expect(oldSignal?.aborted).toBe(false);
	expect(getAuthSnapshot()).toEqual({ generation, hasToken: true, userId: null });
	expect(readCurrentUserCache()).toBeUndefined();
});
test("missing token discards cached identity without a request", async () => {
	localStorage.removeItem("narrafork_token");
	writeCurrentUserCache(user);
	await render();
	expect(readCurrentUserCache()).toBeUndefined();
	expect(calls).toBe(0);
	expect(container.textContent).toBe("login");
});
test("unmount forwards React Query cancellation to fetch", async () => {
	await render();
	expect(requestSignal?.aborted).toBe(false);
	await act(async () => root.render(null));
	expect(requestSignal?.aborted).toBe(true);
});
test("current-user fetch has a ten-second abort deadline", async () => {
	const timeout = new AbortController();
	const spy = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
	restoreTimeout = () => spy.mockRestore();
	const pending = authApi.me();
	expect(spy).toHaveBeenCalledWith(CURRENT_USER_TIMEOUT_MS);
	expect(CURRENT_USER_TIMEOUT_MS).toBe(10_000);
	timeout.abort(new DOMException("Timed out", "TimeoutError"));
	await expect(pending).rejects.toThrow("Timed out");
});
