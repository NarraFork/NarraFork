import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { FileTarget } from "@shared/file-reference";
import type { IDockviewPanelProps } from "dockview-react";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { NarratorBoundPanelParams } from "../panels/panel-kind";

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
const remote: FileTarget = {
	deviceId: "remote-windows",
	path: "\\\\machine\\share\\selected repo\\file.ts",
	selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 4 },
};
let chosen: FileTarget | undefined = remote;
const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Button = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
	<button type="button" onClick={onClick}>
		{children}
	</button>
);
const mantine = await import("@mantine/core");
mock.module("@mantine/core", () => ({
	...mantine,
	Box: Wrapper,
	Center: Wrapper,
	Group: Wrapper,
	Loader: Wrapper,
	Text: Wrapper,
	Tooltip: Wrapper,
	ActionIcon: Button,
	Drawer: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
}));
const reactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
	...reactI18next,
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../../../hooks/useMobileDrawerHistory", () => ({ useMobileDrawerHistory: () => {} }));
mock.module("./FileTreePanel", () => ({
	FileTreePanel: ({
		onOpenFile,
	}: {
		onOpenFile: (path: string, name: string, target?: FileTarget) => void;
	}) => (
		<button type="button" onClick={() => onOpenFile("/host-lure/file.ts", "file.ts", chosen)}>
			pick file
		</button>
	),
}));
const dockModule = await import("../dock/NarratorDockContext");
const openDock = mock((_path: string, _name?: string, _options?: unknown) => {});
let inDock = false;
mock.module("../dock/NarratorDockContext", () => ({
	...dockModule,
	useNarratorDockContext: () => (inDock ? { narratorId: "n", openFilePanel: openDock } : null),
}));
const navigation = await import("../file-panel/file-panel-navigation");
mock.module("../file-panel/file-panel-navigation", () => ({
	...navigation,
	useFilePanelNavigation: () => undefined,
}));
const { fileReferenceApi } = await import("../../../lib/api/file-references");
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MobileToolPanelHost } = await import("../MobileToolPanelHost");
const { FileTreeDockPanel } = await import("../dock/panels");
const { useInternalFileViewer } = await import("../interaction/use-internal-file-viewer");
let root: Root, host: HTMLElement;
let resolveSpy: ReturnType<typeof spyOn<typeof fileReferenceApi, "resolve">>;
const close = mock(() => {});
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	chosen = remote;
	inDock = false;
	openDock.mockClear();
	close.mockClear();
	resolveSpy = spyOn(fileReferenceApi, "resolve").mockImplementation(async (_id, targets) => ({
		targets,
	}));
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	resolveSpy.mockRestore();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
function MobileViewer() {
	const viewer = useInternalFileViewer({
		narratorId: "n",
		isWorkspacePreview: false,
		t: (key) => key,
	});
	const [opened, setOpened] = useState(true);
	return (
		<>
			<MobileToolPanelHost
				kind={opened ? "filetree" : null}
				narratorId="n"
				onClose={() => {
					close();
					setOpened(false);
				}}
				onOpenFile={(path, _name, target) => {
					if (target) void viewer.handleOpenReferencedFile(target);
					else viewer.handleOpenFilePanel?.(path);
				}}
			/>
			<output data-viewer>
				{viewer.internalFileViewerTarget?.deviceId}:{viewer.internalFileViewerPath}
			</output>
		</>
	);
}
async function mount(element: ReactNode) {
	await act(async () => root.render(element));
	await act(async () => {
		await flush();
	});
}
async function pick() {
	await act(async () => {
		[...host.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "pick file")
			?.click();
		await flush();
	});
}
test("mobile tree closes then resolves its full remote target into the actual internal viewer", async () => {
	await mount(<MobileViewer />);
	await pick();
	expect(close).toHaveBeenCalledTimes(1);
	expect(resolveSpy.mock.calls[0]?.[0]).toBe("n");
	expect(resolveSpy.mock.calls[0]?.[1]).toEqual([remote]);
	expect(host.querySelector("output")?.textContent).toBe(`${remote.deviceId}:${remote.path}`);
	expect(host.textContent).not.toContain("/host-lure");
});
test("mobile tree without a frozen identity cannot invoke the legacy host-path viewer", async () => {
	chosen = undefined;
	await mount(<MobileViewer />);
	await pick();
	expect(close).not.toHaveBeenCalled();
	expect(resolveSpy).not.toHaveBeenCalled();
	expect(host.textContent).not.toContain("/host-lure");
});
test("mobile tree forwards target unchanged to its host and does not close without a viewer", async () => {
	const open = mock((_path: string, _name: string, _target?: FileTarget) => {});
	await mount(
		<MobileToolPanelHost kind="filetree" narratorId="n" onClose={close} onOpenFile={open} />,
	);
	await pick();
	expect(open).toHaveBeenCalledWith("/host-lure/file.ts", "file.ts", remote);
	await mount(<MobileToolPanelHost kind="filetree" narratorId="n" onClose={close} />);
	close.mockClear();
	await pick();
	expect(close).not.toHaveBeenCalled();
});
function dockProps() {
	return {
		params: { panelType: "filetree", narratorId: "wrong-fallback" },
		api: {
			id: "tree-panel",
			title: "fileTree.title",
			setTitle: () => {},
			close: () => {},
			group: { id: "g" },
		},
	} as unknown as IDockviewPanelProps<NarratorBoundPanelParams>;
}
test("desktop dock tree uses frozen target device/path/selection and the live narrator", async () => {
	inDock = true;
	await mount(<FileTreeDockPanel {...dockProps()} />);
	await pick();
	expect(openDock).toHaveBeenCalledWith(remote.path, "file.ts", {
		sourcePanelId: "tree-panel",
		fileNarratorId: "n",
		deviceId: remote.deviceId,
		selection: remote.selection,
		referenceOrigin: true,
	});
});
test("desktop tree without an explicit target cannot fall back to host IO", async () => {
	inDock = true;
	chosen = undefined;
	await mount(<FileTreeDockPanel {...dockProps()} />);
	await pick();
	expect(openDock).not.toHaveBeenCalled();
});
test("production MainPanel uses target-aware reference opening, not the plain-path handler", async () => {
	const main = await Bun.file(new URL("../NarratorPanel.tsx", import.meta.url)).text();
	const start = main.indexOf("<MobileToolPanelHost");
	const body = main.slice(start, main.indexOf("<BackgroundTasksDrawerHost", start));
	expect(body).toContain("handleOpenReferencedFile(target)");
	expect(body).not.toContain("onOpenFile={handleOpenFilePanel}");
});
