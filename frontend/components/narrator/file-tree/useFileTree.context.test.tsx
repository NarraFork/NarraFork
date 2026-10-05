import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { UseFileTreeResult } from "./useFileTree";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../../../lib/api");
const { useFileTree } = await import("./useFileTree");
const { TREE_ROOT_KEY } = await import("./tree-patch");
let root: Root;
let container: HTMLElement;
let latest: UseFileTreeResult;
let frames: Array<{ contextKey: string; rows: string[]; loading: string[]; errors: string[] }> = [];
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
function Probe({ path, contextKey = path }: { path: string; contextKey?: string }) {
	const tree = useFileTree(path, false, contextKey);
	latest = tree;
	frames.push({
		contextKey,
		rows: [...tree.state.values()].flatMap((directory) =>
			directory.entries.map((entry) => entry.name),
		),
		loading: [...tree.loading],
		errors: [...tree.errors.keys()],
	});
	useEffect(() => {
		void tree.load(TREE_ROOT_KEY);
	}, [tree.load]);
	return (
		<output>
			{tree.state
				.get(TREE_ROOT_KEY)
				?.entries.map((entry) => entry.name)
				.join(",") ?? "empty"}
		</output>
	);
}
beforeEach(() => {
	frames = [];
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
function reply(path: string, names: string[], directories: string[] = []) {
	return {
		path,
		parent: null,
		sep: "/",
		entries: names.map((name) => ({
			name,
			path: `${path}/${name}`,
			isDirectory: directories.includes(name),
		})),
	};
}
test("A mutations, loading and refresh cannot leak into B or be reused by B mutations", async () => {
	let releaseA: (() => void) | undefined;
	let releaseB: (() => void) | undefined;
	const gateA = new Promise<void>((resolve) => {
		releaseA = resolve;
	});
	const gateB = new Promise<void>((resolve) => {
		releaseB = resolve;
	});
	let aRootReads = 0;
	let bFolderReads = 0;
	const reads = spyOn(api, "fsBrowse").mockImplementation(async (path) => {
		if (path === "/A") {
			if (++aRootReads > 1) await gateA;
			return reply(path, ["a-only.txt", "folder", "bad"], ["folder", "bad"]);
		}
		if (path === "/A/bad") throw new Error("A-only error");
		if (path === "/A/folder") return reply(path, ["a-child"]);
		if (path === "/B") {
			await gateB;
			return reply(path, ["b-only.txt", "folder"], ["folder"]);
		}
		return reply(path ?? "", [`b-child-${++bFolderReads}`]);
	});
	await act(async () => {
		root.render(<Probe path="/A" contextKey="A:1" />);
		await flush();
	});
	await act(async () => {
		await latest.load("folder");
		await latest.load("bad");
		await flush();
	});
	const old = latest;
	expect(old.errors.has("bad")).toBe(true);
	await act(async () => {
		old.ingest([{ path: "folder", kind: "deleted" }], false);
		old.reloadAll();
		await flush();
	});
	expect(latest.loading.has(TREE_ROOT_KEY)).toBe(true);
	await act(async () => {
		root.render(<Probe path="/B" contextKey="B:2" />);
		await flush();
	});
	const firstB = frames.find((frame) => frame.contextKey === "B:2");
	expect(firstB?.rows).toEqual([]);
	expect(firstB?.errors).toEqual([]);
	expect(firstB?.loading).toEqual([]);
	await act(async () => {
		latest.ingest([{ path: "folder", kind: "deleted" }], false);
		old.ingest([{ path: "folder", kind: "deleted" }], false);
		await old.reload("folder");
		old.reloadAll();
		releaseA?.();
		await flush();
	});
	expect(latest.state.size).toBe(0);
	expect(latest.errors.size).toBe(0);
	expect(latest.loading.has(TREE_ROOT_KEY)).toBe(true);
	expect(reads.mock.calls.filter(([path]) => path?.startsWith("/A")).length).toBe(4);
	await act(async () => {
		releaseB?.();
		await flush();
		await latest.load("folder");
		await flush();
	});
	expect(latest.state.get("folder")?.entries[0]?.name).toBe("b-child-1");
	await act(async () => {
		old.ingest([{ path: "folder", kind: "deleted" }], false);
		await old.load("bad");
		await flush();
	});
	expect(latest.state.has("folder")).toBe(true);
	await act(async () => {
		latest.ingest([{ path: "folder/file", kind: "updated" }], false);
		await flush();
	});
	expect(latest.state.get("folder")?.entries[0]?.name).toBe("b-child-2");
	expect(
		frames
			.filter((frame) => frame.contextKey === "B:2")
			.every((frame) => frame.rows.every((row) => !row.startsWith("a-"))),
	).toBe(true);
});
test("A→B→A does not revive A's first pending response", async () => {
	let release: (() => void) | undefined;
	const oldRead = new Promise<void>((resolve) => {
		release = resolve;
	});
	let aReads = 0;
	spyOn(api, "fsBrowse").mockImplementation(async (path) => {
		if (path === "/A" && ++aReads === 1) {
			await oldRead;
			return reply(path, ["a-obsolete"]);
		}
		return reply(path ?? "", [path === "/A" ? "a-current" : "b-current"]);
	});
	await act(async () => {
		root.render(<Probe path="/A" />);
		await flush();
	});
	await act(async () => {
		root.render(<Probe path="/B" />);
		await flush();
	});
	await act(async () => {
		root.render(<Probe path="/A" />);
		await flush();
	});
	expect(container.textContent).toBe("a-current");
	await act(async () => {
		release?.();
		await flush();
	});
	expect(container.textContent).toBe("a-current");
});
test("same physical path with a new context revision clears all tree state before render", async () => {
	let count = 0;
	spyOn(api, "fsBrowse").mockImplementation(async (path) =>
		reply(path ?? "", [++count === 1 ? "revision-1" : "revision-2"]),
	);
	await act(async () => {
		root.render(<Probe path="/repo" contextKey="local:1" />);
		await flush();
	});
	const old = latest;
	await act(async () => {
		root.render(<Probe path="/repo" contextKey="local:2" />);
		await flush();
	});
	expect(frames.find((frame) => frame.contextKey === "local:2")?.rows).toEqual([]);
	await act(async () => {
		old.ingest([{ path: "revision-2", kind: "deleted" }], false);
		old.reloadAll();
		await flush();
	});
	expect(container.textContent).toBe("revision-2");
	expect(count).toBe(2);
});

test("a late directory response from the previous root cannot populate the new root", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	spyOn(api, "fsBrowse").mockImplementation(async (path) => {
		if (path === "/old") await gate;
		return {
			path: path ?? "",
			parent: null,
			sep: "/",
			entries: [
				{
					name: path === "/old" ? "old.txt" : "new.txt",
					path: `${path}/file.txt`,
					isDirectory: false,
					isSymlink: false,
				},
			],
		};
	});
	await act(async () => {
		root.render(<Probe path="/old" />);
		await flush();
	});
	expect(container.textContent).toBe("empty");
	await act(async () => {
		root.render(<Probe path="/new" />);
		await flush();
	});
	expect(container.textContent).toBe("new.txt");
	await act(async () => {
		release?.();
		await flush();
	});
	expect(container.textContent).toBe("new.txt");
});
