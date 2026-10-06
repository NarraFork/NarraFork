import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	NarratorDockContext,
	type NarratorDockContextValue,
	useNarratorDockContext,
} from "../dock/NarratorDockContext";
import { useToolEditNavigation } from "../useToolEditNavigation";
import {
	FilePanelNavigationProvider,
	type FilePanelOpener,
	useFilePanelNavigation,
	useFilePanelSourceOpener,
} from "./file-panel-navigation";

function probeIsolatedChild(hostOpen: FilePanelOpener | undefined) {
	const observations: {
		dock: NarratorDockContextValue | null;
		open: FilePanelOpener | undefined;
		edit: ReturnType<typeof useToolEditNavigation>;
	}[] = [];
	function Probe() {
		observations.push({
			dock: useNarratorDockContext(),
			open: useFilePanelNavigation(),
			edit: useToolEditNavigation({
				toolName: "Edit",
				narratorId: "child",
				toolUseId: "sdk",
				filePath: "/work/a.ts",
				toolDetailRef: { toolCallId: "pk", messageId: "message", executionAttempt: 2 },
			}),
		});
		return null;
	}
	function Child() {
		const open = useFilePanelSourceOpener(hostOpen, "child-panel", "child");
		return (
			<NarratorDockContext.Provider value={null}>
				<FilePanelNavigationProvider value={open}>
					<Probe />
				</FilePanelNavigationProvider>
			</NarratorDockContext.Provider>
		);
	}
	renderToStaticMarkup(
		<NarratorDockContext.Provider
			value={
				{ narratorId: "parent", openFilePanel: hostOpen } as unknown as NarratorDockContextValue
			}
		>
			<Child />
		</NarratorDockContext.Provider>,
	);
	const result = observations[0];
	if (!result) throw new Error("Missing child observation");
	return result;
}

describe("isolated child file navigation", () => {
	test("retains parent state isolation while opening the exact device/path/range in its dock", () => {
		const host = mock((..._args: Parameters<FilePanelOpener>) => {});
		const child = probeIsolatedChild(host);
		expect(child.dock).toBeNull();
		const selection = { startLineNumber: 10, startColumn: 3, endLineNumber: 14, endColumn: 1 };
		const options = {
			deviceId: "RemoteCase",
			referenceOrigin: true,
			selection,
			highlightRequestId: "again",
			sourcePanelId: "stale-parent",
		};
		child.open?.("/work/中文.ts", "中文.ts", options);
		expect(host).toHaveBeenCalledWith("/work/中文.ts", "中文.ts", {
			...options,
			fileNarratorId: "child",
			sourcePanelId: "child-panel",
		});
		expect(host.mock.calls[0]?.[2]?.selection).toBe(selection);
		expect(options.sourcePanelId).toBe("stale-parent");
	});

	test("Edit history also uses the host dock without rebinding the child tool identity", () => {
		const host = mock((..._args: Parameters<FilePanelOpener>) => {});
		const child = probeIsolatedChild(host);
		child.edit.open?.();
		expect(host).toHaveBeenCalledWith("/work/a.ts", undefined, {
			fileNarratorId: "child",
			sourcePanelId: "child-panel",
			toolEdit: {
				narratorId: "child",
				toolUseId: "sdk",
				toolCallId: "pk",
				messageId: "message",
				executionAttempt: 2,
			},
		});
		expect(child.edit.modal).toBeNull();
	});

	test("keeps the off-dock fallback when no host can open a file", () => {
		const child = probeIsolatedChild(undefined);
		expect(child.dock).toBeNull();
		expect(child.open).toBeUndefined();
	});

	test("ordinary root sessions still use their own dock callback", () => {
		const host = mock((..._args: Parameters<FilePanelOpener>) => {});
		const found: (FilePanelOpener | undefined)[] = [];
		function Probe() {
			found.push(useFilePanelNavigation());
			return null;
		}
		renderToStaticMarkup(
			<NarratorDockContext.Provider
				value={{ openFilePanel: host } as unknown as NarratorDockContextValue}
			>
				<Probe />
			</NarratorDockContext.Provider>,
		);
		expect(found[0]).toBe(host);
	});

	test("focus and workspace adapters forward only the file capability across the isolation boundary", async () => {
		const focus = await Bun.file(new URL("../dock/panels.tsx", import.meta.url)).text();
		const workspace = await Bun.file(new URL("../workspace/panels.tsx", import.meta.url)).text();
		const panel = await Bun.file(
			new URL("../interaction/use-internal-file-viewer.ts", import.meta.url),
		).text();
		expect(focus).toMatch(
			/useFilePanelSourceOpener\(\s*hostDock\?\.openFilePanel,\s*props.api.id,\s*props.params.subagentNarratorId,/,
		);
		expect(workspace).toMatch(
			/useFilePanelSourceOpener\(\s*dockValue\?\.openFilePanel,\s*props.api.id,\s*subagentNarratorId,/,
		);
		for (const source of [focus, workspace])
			expect(source).toContain("onOpenFilePanel={openFilePanel}");
		expect(focus).toMatch(
			/<NarratorDockContext.Provider value=\{null\}>\s*<FilePanelNavigationProvider value=\{onOpenFilePanel\}>/,
		);
		expect(panel).toContain("const dockOpenFilePanel = useFilePanelNavigation();");
		expect(panel).toContain("const useInternalViewer = !dockOpenFilePanel && !isWorkspacePreview;");
		expect(panel).toContain("fileReferenceApi.resolve(narratorId, [target], controller.signal)");
	});
});
