import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const globalKeys = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = globalKeys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	localStorage: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, String(value)),
		removeItem: (key: string) => storage.delete(key),
		clear: () => storage.clear(),
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

// The language loader requires Vite's import.meta.glob; authentication and all
// preference hooks/store/token observers below remain the real production modules.
mock.module("../lib/i18n", () => ({
	changeAppLanguage: async () => {},
	getNamespacesForPath: () => [],
}));
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const { clearToken, getToken, setToken } = await import("../lib/api/client");
const { appearanceStore } = await import("../lib/appearance-preference-store");
const { applySession } = await import("./useAuth");
const { useAppearanceSync } = await import("./useAppearanceSync");
const { useLocalPref } = await import("./useLocalPref");
const { useUpdateUserPreferences, useUserPreferences } = await import("./useUserPreferences");

type Preferences = Awaited<ReturnType<typeof api.getUserPreferences>>;
type Patch = Parameters<typeof api.updateUserPreferences>[0];
type PatchResponse = Awaited<ReturnType<typeof api.updateUserPreferences>>;
type Write = { token: string | null; patch: Patch; signal?: AbortSignal };

function preferences(overrides: Partial<Preferences> = {}): Preferences {
	return {
		wordWrapCode: true,
		wordWrapMarkdown: true,
		terminalFontSize: 14,
		appearancePreferences: {},
		language: "en",
		notifyOnDone: true,
		...overrides,
	} as Preferences;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let accounts: Map<string, Preferences>;
let writes: Write[];
let getPreferences: (token: string) => Promise<Preferences>;
let respondToWrite: (write: Write) => Promise<PatchResponse>;
let view: {
	preferences: ReturnType<typeof useUserPreferences>;
	update: ReturnType<typeof useUpdateUserPreferences>;
	sync: ReturnType<typeof useAppearanceSync>;
	oled: ReturnType<typeof useLocalPref>;
};

function account(token: string | null): Preferences {
	const value = token ? accounts.get(token) : undefined;
	if (!value) throw new Error(`Unknown test account: ${token}`);
	return value;
}
function requireToken(): string {
	const token = getToken();
	if (!token) throw new Error("Missing test session token");
	return token;
}

function Probe() {
	const preferences = useUserPreferences();
	const update = useUpdateUserPreferences();
	const sync = useAppearanceSync();
	const oled = useLocalPref("narrafork_oled");
	view = { preferences, update, sync, oled };
	return (
		<output data-ready={sync.ready} data-custom={sync.customEnabled}>
			{String(preferences.data?.wordWrapCode)}:{String(oled[0])}
		</output>
	);
}
function Consumer() {
	const preferences = useUserPreferences();
	const [oled] = useLocalPref("narrafork_oled");
	return (
		<output data-consumer>
			{String(preferences.data?.wordWrapCode)}:{String(oled)}
		</output>
	);
}
async function settle() {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}
async function mount() {
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<Probe />
				<Consumer />
			</QueryClientProvider>,
		);
	});
	await settle();
}
async function change(action: () => unknown) {
	await act(async () => {
		action();
	});
	await settle();
}
async function login(userId: "a" | "b", token = `token-${userId}`) {
	await act(async () => {
		await applySession(client, { token, user: { id: userId }, language: "en" });
	});
	await settle();
}
function dispatchStorage(key: string | null) {
	const event = new window.Event("storage");
	Object.defineProperty(event, "key", { value: key });
	window.dispatchEvent(event);
}

beforeEach(() => {
	appearanceStore.activate(null, true);
	storage.clear();
	accounts = new Map([
		["token-a", preferences()],
		["token-b", preferences({ wordWrapCode: false })],
	]);
	writes = [];
	getPreferences = async (token) => structuredClone(account(token));
	respondToWrite = async () => ({ id: "preferences" });
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	setToken("token-a");
	spyOn(api, "me").mockImplementation(async () => ({
		id: getToken() === "token-b" ? "b" : "a",
	}));
	spyOn(api, "getUserPreferences").mockImplementation(() => getPreferences(requireToken()));
	spyOn(api, "updateUserPreferences").mockImplementation(async (patch, options) => {
		const write = { token: getToken(), patch: structuredClone(patch), signal: options?.signal };
		writes.push(write);
		const response = await respondToWrite(write);
		if (!write.token) throw new Error("Missing test write token");
		const previous = account(write.token);
		accounts.set(write.token, {
			...previous,
			...patch,
			appearancePreferences: { ...previous.appearancePreferences, ...patch.appearancePreferences },
		});
		return response;
	});
	spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected real network request in appearance hook integration test"),
	);
});
afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	appearanceStore.activate(null, true);
	await appearanceStore.flush();
	client.clear();
	clearToken();
	storage.clear();
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("defaults retain account fields and legacy local OLED without uploading hydration", async () => {
	localStorage.setItem("narrafork_oled", "true");
	accounts.set("token-a", preferences({ appearancePreferences: { narrafork_oled: false } }));
	await mount();
	expect(view.sync.ready).toBe(true);
	expect(view.sync.customEnabled).toBe(false);
	expect(view.sync.isSynced("wordWrapCode")).toBe(true);
	expect(view.sync.isSynced("narrafork_oled")).toBe(false);
	expect(view.preferences.data?.wordWrapCode).toBe(true);
	expect(view.oled[0]).toBe(true);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("true:true");
	expect(writes).toEqual([]);
});

test("account-to-local mutations change real consumers, not raw cache, and custom choice survives defaults", async () => {
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("wordWrapCode", false);
	});
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false });
	});
	await settle();
	expect(writes).toEqual([]);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("false:false");
	expect(client.getQueryData<Preferences>(["user-preferences"])?.wordWrapCode).toBe(true);

	await change(() => view.sync.setCustomEnabled(false));
	expect(view.preferences.data?.wordWrapCode).toBe(true);
	expect(view.sync.isSynced("wordWrapCode")).toBe(true);
	await change(() => view.sync.setCustomEnabled(true));
	expect(view.sync.isSynced("wordWrapCode")).toBe(false);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(writes).toEqual([]);
});

test("mixed mutation routes only unrelated fields to PATCH while account appearance is local", async () => {
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("wordWrapCode", false);
	});
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false, notifyOnDone: false });
	});
	await settle();
	expect(writes.map(({ patch }) => patch)).toEqual([{ notifyOnDone: false }]);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(view.preferences.data?.notifyOnDone).toBe(false);
	expect(accounts.get("token-a")?.wordWrapCode).toBe(true);
});

test("OLED opt-in seeds only the absent account key and both local hook consumers update before PATCH resolves", async () => {
	localStorage.setItem("narrafork_oled", "true");
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("narrafork_oled", true);
	});
	expect(writes.map(({ patch }) => patch)).toEqual([
		{ appearancePreferences: { narrafork_oled: true } },
	]);
	const response = deferred<PatchResponse>();
	respondToWrite = () => response.promise;
	await change(() => view.oled[1](false));
	expect(view.oled[0]).toBe(false);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("true:false");
	expect(writes.at(-1)?.patch).toEqual({ appearancePreferences: { narrafork_oled: false } });
	await act(async () => {
		response.resolve({ id: "preferences" });
		await appearanceStore.flush();
	});
	await settle();
	expect(accounts.get("token-a")?.appearancePreferences.narrafork_oled).toBe(false);
	expect(view.oled[0]).toBe(false);
});

test("OLED opt-in reads an existing account value without uploading the preceding local value", async () => {
	localStorage.setItem("narrafork_oled", "true");
	accounts.set("token-a", preferences({ appearancePreferences: { narrafork_oled: false } }));
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("narrafork_oled", true);
	});
	expect(view.oled[0]).toBe(false);
	expect(writes).toEqual([]);
	await change(() => view.sync.setCustomEnabled(false));
	expect(view.oled[0]).toBe(true);
	await change(() => view.sync.setCustomEnabled(true));
	expect(view.sync.isSynced("narrafork_oled")).toBe(true);
	expect(view.oled[0]).toBe(false);
	expect(writes).toEqual([]);
});

test("pending hydration does not enable sync controls or upload local changes", async () => {
	const response = deferred<Preferences>();
	getPreferences = () => response.promise;
	await mount();
	expect(view.sync.ready).toBe(false);
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("narrafork_oled", true);
		view.oled[1](true);
	});
	expect(view.sync.customEnabled).toBe(false);
	expect(view.oled[0]).toBe(true);
	expect(writes).toEqual([]);
	await act(async () => response.resolve(preferences()));
	await settle();
	expect(view.sync.ready).toBe(true);
	expect(view.oled[0]).toBe(true);
	expect(writes).toEqual([]);
});

test("a local hook edit while the identified user's preference GET is pending survives hydration", async () => {
	await mount();
	expect(view.oled[0]).toBe(false);
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	appearanceStore.activate(null);
	const response = deferred<Preferences>();
	getPreferences = () => response.promise;
	await mount();
	expect(appearanceStore.getUserId()).toBe("a");
	expect(view.sync.ready).toBe(false);
	await change(() => view.oled[1](true));
	expect(view.oled[0]).toBe(true);
	expect(writes).toEqual([]);
	await act(async () => response.resolve(preferences()));
	await settle();
	expect(view.sync.ready).toBe(true);
	expect(view.oled[0]).toBe(true);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("true:true");
	expect(writes).toEqual([]);
});

test("an explicit local hook edit before user identity resolves survives restoring that user's existing local values", async () => {
	await mount();
	expect(view.oled[0]).toBe(false);
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	appearanceStore.activate(null);
	const user = deferred<Awaited<ReturnType<typeof api.me>>>();
	spyOn(api, "me").mockImplementation(() => user.promise);
	const response = deferred<Preferences>();
	getPreferences = () => response.promise;
	await mount();
	expect(appearanceStore.getUserId()).toBe(null);
	await change(() => view.oled[1](true));
	expect(view.oled[0]).toBe(true);
	expect(writes).toEqual([]);
	await act(async () => user.resolve({ id: "a" }));
	await settle();
	expect(appearanceStore.getUserId()).toBe("a");
	expect(view.oled[0]).toBe(true);
	await act(async () => response.resolve(preferences()));
	await settle();
	expect(view.oled[0]).toBe(true);
	expect(writes).toEqual([]);
});

test.each([
	false,
	true,
])("an anonymous local edit does not cross token changes (legacy owner already known: %s)", async (ownerKnown) => {
	if (ownerKnown) {
		await mount();
		await act(async () => root?.unmount());
		root = undefined;
		client.clear();
		appearanceStore.activate(null);
	}
	const oldUser = deferred<Awaited<ReturnType<typeof api.me>>>();
	spyOn(api, "me").mockImplementation(async () =>
		getToken() === "token-a" ? oldUser.promise : { id: "b" },
	);
	await mount();
	expect(appearanceStore.getUserId()).toBe(null);
	await change(() => view.oled[1](true));
	expect(view.oled[0]).toBe(true);
	await change(() => setToken("token-b"));
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.oled[0]).toBe(false);
	await act(async () => oldUser.resolve({ id: "a" }));
	await settle();
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.oled[0]).toBe(false);
	expect(writes).toEqual([]);
});

test("real token observer aborts an old write and applySession isolates new account and restores original choices", async () => {
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("wordWrapCode", false);
	});
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false });
	});
	await settle();
	const response = deferred<PatchResponse>();
	respondToWrite = () => response.promise;
	await change(() => view.sync.setSynced("narrafork_oled", true));
	expect(writes).toHaveLength(1);
	const oldWrite = writes[0];
	if (!oldWrite) throw new Error("Expected pending test write");
	expect(oldWrite.token).toBe("token-a");
	await login("b");
	expect(oldWrite.signal?.aborted).toBe(true);
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.sync.customEnabled).toBe(false);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(view.oled[0]).toBe(false);
	await act(async () => {
		response.resolve({ id: "late-a-response" });
		await appearanceStore.flush();
	});
	await settle();
	expect(writes.every(({ token }) => token === "token-a")).toBe(true);
	expect(accounts.get("token-b")?.appearancePreferences).toEqual({});
	expect(view.sync.customEnabled).toBe(false);
	respondToWrite = async () => ({ id: "preferences" });
	await login("a");
	expect(appearanceStore.getUserId()).toBe("a");
	expect(view.sync.customEnabled).toBe(true);
	expect(view.sync.isSynced("wordWrapCode")).toBe(false);
	expect(view.sync.isSynced("narrafork_oled")).toBe(true);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
});

test("rapid account mutations serialize PATCHes and both hooks retain the latest effective value", async () => {
	await mount();
	const firstResponse = deferred<PatchResponse>();
	respondToWrite = () => firstResponse.promise;
	let first!: Promise<unknown>;
	let second!: Promise<unknown>;
	await change(() => {
		first = view.update.mutateAsync({ wordWrapCode: false });
	});
	expect(writes.map(({ patch }) => patch)).toEqual([{ wordWrapCode: false }]);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	await change(() => {
		second = view.update.mutateAsync({ wordWrapCode: true });
	});
	expect(writes).toHaveLength(1);
	expect(view.preferences.data?.wordWrapCode).toBe(true);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("true:false");
	respondToWrite = async () => ({ id: "preferences" });
	await act(async () => {
		firstResponse.resolve({ id: "first-response" });
		await Promise.all([first, second]);
	});
	await settle();
	expect(writes.map(({ patch }) => patch)).toEqual([
		{ wordWrapCode: false },
		{ wordWrapCode: true },
	]);
	expect(accounts.get("token-a")?.wordWrapCode).toBe(true);
	expect(view.preferences.data?.wordWrapCode).toBe(true);
});

test("a GET begun before an account edit cannot roll back the completed mutation", async () => {
	await mount();
	const staleGet = deferred<Preferences>();
	let first = true;
	getPreferences = async (token) => {
		if (first) {
			first = false;
			return staleGet.promise;
		}
		return structuredClone(account(token));
	};
	let refetch!: ReturnType<typeof view.preferences.refetch>;
	await change(() => {
		refetch = view.preferences.refetch();
	});
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false });
	});
	await settle();
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	await act(async () => {
		staleGet.resolve(preferences({ wordWrapCode: true }));
		await refetch;
	});
	await settle();
	expect(writes.map(({ patch }) => patch)).toEqual([{ wordWrapCode: false }]);
	expect(client.getQueryData<Preferences>(["user-preferences"])?.wordWrapCode).toBe(false);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(container.querySelector("[data-consumer]")?.textContent).toBe("false:false");
});

test("an unknown identity cannot upload appearance through the updater before hydration", async () => {
	const response = deferred<Preferences>();
	getPreferences = () => response.promise;
	await mount();
	expect(view.sync.ready).toBe(false);
	await act(async () => {
		await expect(view.update.mutateAsync({ wordWrapCode: false })).rejects.toThrow();
	});
	expect(writes).toEqual([]);
	await act(async () => response.resolve(preferences()));
	await settle();
	expect(view.preferences.data?.wordWrapCode).toBe(true);
	expect(writes).toEqual([]);
});

test("a restored local scope cannot PATCH through the updater before preference hydration", async () => {
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("wordWrapCode", false);
	});
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	appearanceStore.activate(null);
	const response = deferred<Preferences>();
	getPreferences = () => response.promise;
	await login("a");
	await mount();
	expect(view.sync.ready).toBe(false);
	expect(view.sync.isSynced("wordWrapCode")).toBe(false);
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false });
	});
	const prematureWrites = structuredClone(writes.map(({ patch }) => patch));
	await act(async () => response.resolve(preferences()));
	await settle();
	expect(prematureWrites).toEqual([]);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
});

test("token changes alone cannot rehydrate the preceding cached user with the new account's preferences", async () => {
	await mount();
	await change(() => setToken("token-b"));
	expect(appearanceStore.getUserId()).not.toBe("a");
	expect(view.sync.ready && appearanceStore.getUserId() === "b").toBe(true);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(writes).toEqual([]);
});

test("a cross-tab token storage event switches identity without reusing old scopes or local values", async () => {
	accounts.set("token-b", preferences({ wordWrapCode: true }));
	await mount();
	await change(() => {
		view.sync.setCustomEnabled(true);
		view.sync.setSynced("wordWrapCode", false);
		view.oled[1](true);
	});
	await act(async () => {
		await view.update.mutateAsync({ wordWrapCode: false });
	});
	await settle();
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(view.oled[0]).toBe(true);
	await change(() => {
		// A write in another tab does not call this tab's setToken observers.
		localStorage.setItem("narrafork_token", "token-b");
		dispatchStorage("narrafork_token");
	});
	expect(getToken()).toBe("token-b");
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.sync.ready).toBe(true);
	expect(view.sync.customEnabled).toBe(false);
	expect(view.sync.isSynced("wordWrapCode")).toBe(true);
	expect(view.preferences.data?.wordWrapCode).toBe(true);
	expect(view.oled[0]).toBe(false);
	expect(writes).toEqual([]);
});

test("a cross-tab storage clear invalidates both identity and preference caches without uploading", async () => {
	await mount();
	await change(() => {
		localStorage.clear();
		dispatchStorage(null);
	});
	expect(getToken()).toBe(null);
	expect(appearanceStore.getUserId()).toBe(null);
	expect(view.sync.ready).toBe(false);
	expect(view.preferences.data).toBeUndefined();
	expect(client.getQueryData(["auth", "me"])).toBeUndefined();
	expect(client.getQueryData(["user-preferences"])).toBeUndefined();
	expect(writes).toEqual([]);
});

test("a token replacement during initial identity loading still starts the new account's queries", async () => {
	const oldMe = deferred<Awaited<ReturnType<typeof api.me>>>();
	const oldPreferences = deferred<Preferences>();
	spyOn(api, "me").mockImplementation(async () =>
		getToken() === "token-a" ? oldMe.promise : { id: "b" },
	);
	getPreferences = async (token) =>
		token === "token-a" ? oldPreferences.promise : structuredClone(account(token));
	await mount();
	expect(appearanceStore.getUserId()).toBe(null);
	expect(view.sync.ready).toBe(false);
	await change(() => setToken("token-b"));
	await act(async () => {
		oldMe.resolve({ id: "a" });
		oldPreferences.resolve(preferences());
	});
	await settle();
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.sync.ready).toBe(true);
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(writes).toEqual([]);
});

test("an old preference GET resolving after account switch cannot hydrate the new account", async () => {
	const oldGet = deferred<Preferences>();
	getPreferences = async (token) =>
		token === "token-a" ? oldGet.promise : structuredClone(account(token));
	await mount();
	expect(view.sync.ready).toBe(false);
	await login("b");
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	await act(async () => {
		oldGet.resolve(
			preferences({ wordWrapCode: true, appearancePreferences: { narrafork_oled: true } }),
		);
	});
	await settle();
	expect(appearanceStore.getUserId()).toBe("b");
	expect(view.preferences.data?.wordWrapCode).toBe(false);
	expect(view.oled[0]).toBe(false);
	expect(client.getQueryData<Preferences>(["user-preferences"])?.wordWrapCode).toBe(false);
	expect(writes).toEqual([]);
});
