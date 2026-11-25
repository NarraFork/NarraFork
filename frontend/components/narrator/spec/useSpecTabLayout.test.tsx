import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const keys = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = keys.map(
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
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { api } = await import("../../../lib/api");
const { setToken, clearToken } = await import("../../../lib/api/client");
const { useSpecTabLayout } = await import("./useSpecTabLayout");

let client: InstanceType<typeof QueryClient>;
let root: Root;
let view: ReturnType<typeof useSpecTabLayout>;
let narratorId: string;
function Probe() {
	view = useSpecTabLayout(narratorId);
	return <output>{view.layout.order.join(",")}</output>;
}
async function settle() {
	for (let i = 0; i < 5; i++)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
}
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		),
	);
	await settle();
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
beforeEach(() => {
	setToken("spec-user-a");
	narratorId = "n-a";
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { id: "user-a" });
	root = createRoot(document.createElement("div"));
	spyOn(api, "getUserPreferences").mockRejectedValue(new Error("No full preferences"));
	spyOn(api, "getUIPreferences").mockRejectedValue(new Error("No UI preferences for layout"));
	spyOn(api, "getSpecTabLayout").mockImplementation(async (id) => ({
		order: [`${id}.md`],
		pinned: [],
	}));
	spyOn(api, "saveSpecTabLayout").mockResolvedValue({ ok: true });
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	clearToken();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("reads only the current narrator and reuses its fresh point cache", async () => {
	await render();
	expect(view.layout.order).toEqual(["n-a.md"]);
	expect(api.getSpecTabLayout).toHaveBeenCalledTimes(1);
	narratorId = "n-b";
	await render();
	expect(view.layout.order).toEqual(["n-b.md"]);
	narratorId = "n-a";
	await render();
	expect(api.getSpecTabLayout).toHaveBeenCalledTimes(2);
	expect(api.getUserPreferences).not.toHaveBeenCalled();
	expect(api.getUIPreferences).not.toHaveBeenCalled();
});

test("does not let an event GET overwrite a newer local gesture", async () => {
	await render();
	const saving = deferred<{ ok: boolean }>();
	spyOn(api, "saveSpecTabLayout").mockReturnValue(saving.promise);
	await act(async () => view.save(() => ({ order: ["local.md"], pinned: [] })));
	await act(async () => {
		await client.invalidateQueries({ queryKey: ["user-preferences"] });
	});
	await settle();
	expect(view.layout.order).toEqual(["local.md"]);
	saving.resolve({ ok: true });
	await settle();
	expect(view.layout.order).toEqual(["local.md"]);
});

test("isolates current layout after an account token changes", async () => {
	await render();
	const next = deferred<{ order: string[]; pinned: string[] }>();
	spyOn(api, "getSpecTabLayout").mockReturnValue(next.promise);
	await act(async () => {
		setToken("spec-user-b");
		client.setQueryData(["auth", "me"], { id: "user-b" });
	});
	await render();
	expect(view.layout.order).toEqual([]);
	next.resolve({ order: ["user-b.md"], pinned: [] });
	await settle();
	expect(view.layout.order).toEqual(["user-b.md"]);
});
