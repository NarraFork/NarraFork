import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMobileTerminalDrawerOpen } from "./useMobileTerminalDrawerOpen";

let root: Root;
let host: HTMLElement;
let opener: () => void;
let bodyRenders: number;
const originals = new Map<string, PropertyDescriptor | undefined>();
const calls: string[] = [];
const mutate = (data: { name: string }) => {
	calls.push(`create:${data.name}`);
};
const openDrawer = () => {
	calls.push("open");
};

const Body = memo(({ onOpen }: { onOpen: () => void }) => {
	bodyRenders++;
	return (
		<button type="button" onClick={onOpen}>
			terminal
		</button>
	);
});
function RouteProbe({
	result,
	supported = true,
	running = false,
	open = openDrawer,
}: {
	result: { mutate: typeof mutate; isPending?: boolean; data?: unknown };
	supported?: boolean;
	running?: boolean;
	open?: () => void;
}) {
	opener = useMobileTerminalDrawerOpen({
		terminalSupported: supported,
		hasRunningTerminal: running,
		createTerminal: result.mutate,
		openDrawer: open,
	});
	return <Body onOpen={opener} />;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	calls.length = 0;
	bodyRenders = 0;
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
async function render(props: Parameters<typeof RouteProbe>[0]) {
	await act(async () => root.render(<RouteProbe {...props} />));
}

test("changing mutation result/loading data does not replace the opener or render its body", async () => {
	await render({ result: { mutate, isPending: false } });
	const initial = opener;
	const button = host.querySelector("button");
	await render({ result: { mutate, isPending: true } });
	await render({ result: { mutate, isPending: false, data: { id: "created" } } });
	expect(opener).toBe(initial);
	expect(bodyRenders).toBe(1);
	expect(host.querySelector("button")).toBe(button);
	expect(calls).toEqual([]);
	await act(async () => button?.click());
	expect(calls).toEqual(["create:Terminal 1", "open"]);
});

test("real supported/running changes remain live and never create a terminal unnecessarily", async () => {
	await render({ result: { mutate } });
	const before = opener;
	await render({ result: { mutate }, running: true });
	expect(opener).not.toBe(before);
	opener();
	expect(calls).toEqual(["open"]);
	await render({ result: { mutate }, supported: false });
	opener();
	expect(calls).toEqual(["open", "open"]);
	await render({ result: { mutate }, supported: true, running: false });
	opener();
	expect(calls).toEqual(["open", "open", "create:Terminal 1", "open"]);
});

test("replacing the actual actions uses the latest narrator/action rather than a stale closure", async () => {
	await render({ result: { mutate } });
	const initial = opener;
	const nextMutate = (data: { name: string }) => {
		calls.push(`other-narrator:${data.name}`);
	};
	const nextOpen = () => {
		calls.push("other-drawer");
	};
	await render({ result: { mutate: nextMutate }, open: nextOpen });
	expect(opener).not.toBe(initial);
	opener();
	expect(calls).toEqual(["other-narrator:Terminal 1", "other-drawer"]);
});

test("production route extracts the stable mutate action and uses this tested hook", async () => {
	const route = await Bun.file(
		new URL("../routes/narrators/$narratorId.tsx", import.meta.url),
	).text();
	expect(route).toContain(
		"const { mutate: createTerminal } = useCreateNarratorTerminal(narratorId)",
	);
	expect(route).toContain("const openDrawerWithTerminal = useMobileTerminalDrawerOpen({");
	expect(route).not.toContain("createTerminal.mutate(");
});

test("real mutation keeps its action identity while requests follow the latest narrator", async () => {
	const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
	const { api } = await import("../lib/api");
	const { useCreateNarratorTerminal } = await import("./useTerminals");
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const request = spyOn(api, "createTerminal").mockResolvedValue({ id: "test-terminal" });
	let action: ReturnType<typeof useCreateNarratorTerminal>["mutate"] | undefined;
	function RealRoute({ narratorId }: { narratorId: string }) {
		const mutation = useCreateNarratorTerminal(narratorId);
		action = mutation.mutate;
		opener = useMobileTerminalDrawerOpen({
			terminalSupported: true,
			hasRunningTerminal: false,
			createTerminal: mutation.mutate,
			openDrawer,
		});
		return null;
	}
	const renderNarrator = async (narratorId: string) =>
		act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<RealRoute narratorId={narratorId} />
				</QueryClientProvider>,
			),
		);
	try {
		await renderNarrator("first-narrator");
		const firstAction = action;
		const firstOpener = opener;
		await renderNarrator("second-narrator");
		expect(action).toBe(firstAction);
		expect(opener).toBe(firstOpener);
		await act(async () => {
			opener();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith({ narratorId: "second-narrator", name: "Terminal 1" });
		expect(calls).toEqual(["open"]);
	} finally {
		request.mockRestore();
		client.clear();
	}
});
