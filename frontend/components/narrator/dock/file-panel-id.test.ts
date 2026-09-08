import { describe, expect, it, mock } from "bun:test";
import type { FileSelection } from "@shared/file-reference";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createDetachedPanelDockValue } from "../../graph/dock/detached-panel-context";
import { stripIdentityFromLayout, stripNavigationFromLayout } from "../panels/layout-envelope";
import {
	type FilePanelParams,
	filePanelResourceId,
	filePanelResourceParams,
} from "../panels/panel-kind";
import { WorkspaceDockStore, workspaceFilePanelId } from "../workspace/workspace-dock";
import { fileDockPanelId, hashFilePath } from "./dock-panel-types";
import {
	type NarratorDockContextValue,
	NarratorDockProvider,
	useNarratorDockContext,
} from "./NarratorDockContext";
import { bindFilePanelExitGuard } from "./panels";

/**
 * A file panel's dockview id is derived from a HASH of its path, never from the
 * path itself: paths carry separators, spaces and non-ASCII and can be long, all
 * of which are unsafe / unbounded in an id. These tests pin the properties the
 * two surfaces rely on — stability (re-opening focuses instead of duplicating),
 * uniqueness, and id safety.
 */
describe("hashFilePath", () => {
	it("is deterministic", () => {
		const path = "/home/user/projects/app/src/index.ts";
		expect(hashFilePath(path)).toBe(hashFilePath(path));
	});

	it("produces id-safe output (no separators, spaces or non-ASCII)", () => {
		const paths = [
			"/home/user/a b/c.json",
			"C:\\Users\\me\\Documents\\说明.md",
			"/tmp/файл.toml",
			"/tmp/emoji-🎉.txt",
			`${"/very/deep/".repeat(40)}leaf.ini`,
		];
		for (const path of paths) {
			expect(hashFilePath(path)).toMatch(/^[0-9a-z]+$/);
		}
	});

	it("distinguishes paths that differ only in one segment", () => {
		const ids = new Set(
			[
				"/a/b/c.ts",
				"/a/b/d.ts",
				"/a/c/c.ts",
				"/a/b/c.tsx",
				"/a/b/c.ts ",
				"a/b/c.ts",
				"/A/b/c.ts",
			].map(hashFilePath),
		);
		expect(ids.size).toBe(7);
	});
});

describe("fileDockPanelId", () => {
	it("is stable for the same path and distinct across paths", () => {
		const a = fileDockPanelId("/repo/README.md");
		expect(a).toBe(fileDockPanelId("/repo/README.md"));
		expect(a).not.toBe(fileDockPanelId("/repo/CHANGELOG.md"));
	});

	it("namespaces the focus dock and never embeds the raw path", () => {
		const id = fileDockPanelId("/repo/src/a b/index.ts");
		expect(id.startsWith("ndock-file-")).toBe(true);
		expect(id).not.toContain("/");
		expect(id).not.toContain(" ");
	});

	it("does not collide with the singleton tool panel ids", () => {
		// Singleton panels use `ndock-<kind>`; a file panel must never produce one.
		for (const kind of ["chat", "terminal", "details", "filemod", "spec", "git"]) {
			expect(fileDockPanelId(`/x/${kind}`)).not.toBe(`ndock-${kind}`);
		}
	});
});

describe("focus file panel editing ownership", () => {
	it("stamps the owning narrator on new and already-open file panels", async () => {
		const source = await Bun.file(new URL("./NarratorDockContext.tsx", import.meta.url)).text();
		const start = source.indexOf("const openFilePanel");
		const end = source.indexOf("const openKnowledgePanel", start);
		const body = source.slice(start, end);

		expect(body).toContain("hostNarratorId: narratorId");
		expect(body).toContain("existing.api.updateParameters({");
		expect(body).toContain("...current,");
		expect(body).toContain("...navigation,");
	});

	it("hydrates restored focus panels from the live dock context", async () => {
		const source = await Bun.file(new URL("./panels.tsx", import.meta.url)).text();
		const start = source.indexOf("export function FileDockPanel");
		const end = source.indexOf("// ── File tree", start);
		const body = source.slice(start, end);

		expect(body).toContain("dock?.narratorId ?? props.params.hostNarratorId");
		expect(body).toContain("props.api.updateParameters({ ...props.params, hostNarratorId })");
		expect(body).toContain('getFilePreviewType(filePath ?? "") === "text"');
		expect(body).toContain(") : isText ? (");
		expect(body).toContain("narratorId={hostNarratorId}");
		expect(body).toContain("referenceOrigin={referenceOrigin}");
		expect(body).toContain("navigationRequestId={highlightRequestId}");
		expect(body).toContain("beforeDrag={canExit}");
		expect(body).toContain("onDirtyChange={onDirtyChange}");
		expect(body).toContain("title={displayTitle}");
		expect(body).not.toContain("toggleEditing");
		expect(body).not.toContain("setEditing");
		expect(body).not.toContain("IconPencil");
	});
});

describe("file panel unsaved exit guard", () => {
	function setup() {
		let dirty = false;
		const close = mock(() => {});
		const notify = mock(() => {});
		const { document, Event: DomEvent } = parseHTML(`<html><body>
			<div id="group"><div class="dv-tabs-and-actions-container">
				<div class="dv-tab" id="file"><span id="file-label"></span></div>
				<div class="dv-tab" id="other"></div><div id="group-drag"></div>
			</div></div>
			<div id="other-group"><div class="dv-tabs-and-actions-container">
				<div class="dv-tab" id="foreign-file"></div><div id="foreign-group-drag"></div>
			</div></div>
		</body></html>`);
		const element = (id: string) => document.getElementById(id) as HTMLElement;
		let panelDrag: (event: { panel: { id: string }; nativeEvent: Event }) => void = () => {};
		let groupDrag: (event: { group: { id: string }; nativeEvent: Event }) => void = () => {};
		const disposePanel = mock(() => {});
		const disposeGroup = mock(() => {});
		const api = {
			id: "file",
			group: { id: "group", element: element("group") },
			close,
			getWindow: () => ({ document }),
		};
		const containerApi = {
			id: "surface",
			getPanel: () => ({ view: { tab: { element: element("file-label") } } }),
			onWillDragPanel: (listener: typeof panelDrag) => {
				panelDrag = listener;
				return { dispose: disposePanel };
			},
			onWillDragGroup: (listener: typeof groupDrag) => {
				groupDrag = listener;
				return { dispose: disposeGroup };
			},
		};
		const release = bindFilePanelExitGuard(
			{ api, containerApi } as unknown as Parameters<typeof bindFilePanelExitGuard>[0],
			() => {
				if (!dirty) return true;
				notify();
				return false;
			},
		);
		return {
			api,
			close,
			notify,
			release,
			disposePanel,
			disposeGroup,
			setDirty: (value: boolean) => {
				dirty = value;
			},
			panelDrag: (id: string) => {
				const nativeEvent = new Event("dragstart", { cancelable: true });
				panelDrag({ panel: { id }, nativeEvent });
				return nativeEvent;
			},
			groupDrag: (id: string) => {
				const nativeEvent = new Event("dragstart", { cancelable: true });
				groupDrag({ group: { id }, nativeEvent });
				return nativeEvent;
			},
			nativeDrag: (id: string) => {
				const event = new DomEvent("dragstart", { cancelable: true, bubbles: true });
				element(id).dispatchEvent(event);
				return event;
			},
		};
	}

	it("blocks every api.close caller while dirty, then permits close after save/discard", () => {
		const guard = setup();
		try {
			guard.setDirty(true);
			guard.api.close();
			expect(guard.close).not.toHaveBeenCalled();
			expect(guard.notify).toHaveBeenCalledTimes(1);
			guard.setDirty(false);
			guard.api.close();
			expect(guard.close).toHaveBeenCalledTimes(1);
		} finally {
			guard.release();
		}
		expect(guard.api.close).toBe(guard.close);
		expect(guard.disposePanel).toHaveBeenCalledTimes(1);
		expect(guard.disposeGroup).toHaveBeenCalledTimes(1);
	});

	it("cancels only this panel or its whole group's Dockview drag", () => {
		const guard = setup();
		try {
			guard.setDirty(true);
			expect(guard.panelDrag("file").defaultPrevented).toBe(true);
			expect(guard.groupDrag("group").defaultPrevented).toBe(true);
			expect(guard.panelDrag("other").defaultPrevented).toBe(false);
			expect(guard.groupDrag("other").defaultPrevented).toBe(false);
			guard.setDirty(false);
			expect(guard.panelDrag("file").defaultPrevented).toBe(false);
		} finally {
			guard.release();
		}
	});

	it("also blocks native tab/group detach without advanced DnD and cleans up", () => {
		const guard = setup();
		try {
			guard.setDirty(true);
			expect(guard.nativeDrag("file").defaultPrevented).toBe(true);
			expect(guard.nativeDrag("file-label").defaultPrevented).toBe(true);
			expect(guard.nativeDrag("group-drag").defaultPrevented).toBe(true);
			expect(guard.nativeDrag("other").defaultPrevented).toBe(false);
			expect(guard.nativeDrag("foreign-group-drag").defaultPrevented).toBe(false);
			expect(guard.nativeDrag("foreign-file").defaultPrevented).toBe(false);
			guard.setDirty(false);
			expect(guard.nativeDrag("file").defaultPrevented).toBe(false);
		} finally {
			guard.release();
		}
		guard.setDirty(true);
		expect(guard.nativeDrag("file").defaultPrevented).toBe(false);
	});
});

describe("device-scoped navigation", () => {
	it("keeps local ids compatible and isolates case-sensitive remote devices", () => {
		const path = "/repo/a.ts";
		expect(fileDockPanelId(path)).toBe(fileDockPanelId(path, "local"));
		expect(
			new Set(["local", "DeviceA", "devicea"].map((device) => fileDockPanelId(path, device))).size,
		).toBe(3);
		expect(workspaceFilePanelId("n", path, "DeviceA")).not.toBe(workspaceFilePanelId("n", path));
		expect(filePanelResourceId(path)).toBe(path);
		expect(filePanelResourceParams(path)).toEqual({ deviceId: "local", filePath: path });
		expect(filePanelResourceParams(filePanelResourceId(path, "DeviceA"))).toEqual({
			deviceId: "DeviceA",
			filePath: path,
		});
	});

	it("reuses legacy panels and refreshes every navigation request", () => {
		const path = "/repo/a.ts";
		const id = workspaceFilePanelId("n", path);
		const selection: FileSelection = {
			startLineNumber: 2,
			startColumn: 1,
			endLineNumber: 3,
			endColumn: 1,
		};
		const panels = new Map<
			string,
			{
				id: string;
				params: FilePanelParams;
				api: { setActive: () => void; updateParameters: (params: FilePanelParams) => void };
			}
		>();
		const add = (id: string, params: FilePanelParams) => {
			const panel = {
				id,
				params,
				api: {
					setActive: () => {},
					updateParameters: (next: FilePanelParams) => {
						panel.params = next;
					},
				},
			};
			panels.set(id, panel);
		};
		add(id, { panelType: "file", filePath: path });
		const api = {
			getPanel: (id: string) => panels.get(id),
			get panels() {
				return [...panels.values()];
			},
			addPanel: (panel: { id: string; params: FilePanelParams }) => add(panel.id, panel.params),
		} as unknown as DockviewApi;
		const store = new WorkspaceDockStore({ current: api });
		store.openFilePanel("n", path, undefined, { selection });
		const first = panels.get(id)?.params;
		expect(first).toMatchObject({ hostNarratorId: "n", deviceId: "local", selection });
		store.openFilePanel("n", path, undefined, { selection });
		expect(panels.get(id)?.params.highlightRequestId).not.toBe(first?.highlightRequestId);
		expect(panels.size).toBe(1);
		store.openFilePanel("n", path, undefined, { deviceId: "remote" });
		expect(panels.size).toBe(2);
		store.openFilePanel("n", path, undefined, { referenceOrigin: true });
		store.openFilePanel("n", path);
		expect(panels.get(id)?.params.selection).toBeUndefined();
		expect(panels.get(id)?.params.referenceOrigin).toBe(true);
	});

	it("workspace navigation stripping retains narrator membership", () => {
		const layout = {
			panels: {
				chat: { params: { panelType: "narrator", narratorId: "n" } },
				file: {
					params: {
						panelType: "file",
						hostNarratorId: "n",
						deviceId: "Remote",
						filePath: "/a",
						selection: {},
						highlightRequestId: "h1",
					},
				},
			},
		} as unknown as SerializedDockview;
		const saved = stripNavigationFromLayout(layout);
		expect(saved.panels.chat.params?.narratorId).toBe("n");
		expect(saved.panels.file.params).toEqual({
			panelType: "file",
			hostNarratorId: "n",
			deviceId: "Remote",
			filePath: "/a",
		});
	});

	it("detached panels do not pretend to have a file opener without a source dock", () => {
		const input = { narratorId: "n", chapterId: "c", apiRef: { current: null } };
		expect(
			createDetachedPanelDockValue({ ...input, sourceDock: undefined }).openFilePanel,
		).toBeUndefined();
		const openFilePanel = () => {};
		const addFileReference = () => {};
		const sourceDock = { openFilePanel, addFileReference } as unknown as NarratorDockContextValue;
		const detached = createDetachedPanelDockValue({ ...input, sourceDock });
		expect(detached.openFilePanel).toBe(openFilePanel);
		expect(detached.addFileReference).toBe(addFileReference);
	});

	it("file bridges are scoped per narrator and stale unregister cannot remove the replacement", () => {
		const store = new WorkspaceDockStore({ current: null });
		const calls: string[] = [];
		const old = store.registerAddFileReference("n", () => calls.push("old"));
		store.registerAddFileReference("n", () => calls.push("new"));
		store.registerAddFileReference("other", () => calls.push("other"));
		old();
		store.addFileReference("n", { id: "ref", deviceId: "local", path: "/a", label: "a" });
		expect(calls).toEqual(["new"]);
		const selection = {
			target: { deviceId: "local", path: "/a" },
			label: "a",
			expectedHash: "hash",
			dirty: true,
		};
		store.setFileReferenceSelection("n", selection);
		expect(store.getSnapshot("n").fileReferenceSelection).toBe(selection);
		expect(store.getSnapshot("other").fileReferenceSelection).toBeNull();
	});

	it("persists path/device but never a one-shot selection", () => {
		const params = {
			panelType: "file",
			filePath: "/a.ts",
			deviceId: "DeviceA",
			referenceOrigin: true,
			selection: { startLineNumber: 1 },
			highlightRequestId: "h1",
			hostNarratorId: "n",
		};
		const layout = { panels: { file: { params } } } as unknown as SerializedDockview;
		const saved = stripIdentityFromLayout(layout);
		expect(saved.panels.file.params).toEqual({
			panelType: "file",
			filePath: "/a.ts",
			deviceId: "DeviceA",
			referenceOrigin: true,
			hostNarratorId: "n",
		});
		expect(params.selection).toBeDefined();
	});
});

describe("historical file panels", () => {
	const path = "/repo/a.ts";
	const toolEdit = {
		narratorId: "origin",
		toolUseId: "sdk-reused",
		toolCallId: "call-1",
		messageId: "message-1",
		executionAttempt: 1,
	};

	it("isolates live files and every historical execution while retaining legacy ids", () => {
		const refs = [
			undefined,
			toolEdit,
			{ ...toolEdit, narratorId: "other" },
			{ ...toolEdit, toolUseId: "another-tool" },
			{ ...toolEdit, toolCallId: "call-2" },
			{ ...toolEdit, messageId: "message-2" },
			{ ...toolEdit, executionAttempt: 2 },
		];
		expect(new Set(refs.map((ref) => fileDockPanelId(path, "local", ref))).size).toBe(refs.length);
		expect(new Set(refs.map((ref) => workspaceFilePanelId("host", path, "local", ref))).size).toBe(
			refs.length,
		);
		expect(fileDockPanelId(path)).toBe(`ndock-file-${hashFilePath(path)}`);
		const reordered = {
			executionAttempt: 1,
			messageId: "message-1",
			toolCallId: "call-1",
			toolUseId: "sdk-reused",
			narratorId: "origin",
		};
		expect(fileDockPanelId(path, "local", reordered)).toBe(
			fileDockPanelId(path, "local", toolEdit),
		);
		expect(fileDockPanelId(path, "remote", toolEdit)).not.toBe(
			fileDockPanelId(path, "local", toolEdit),
		);
	});

	it("round-trips validated historical resource identities without changing legacy formats", () => {
		for (const deviceId of ["local", "Remote"]) {
			for (const referenceOrigin of [false, true]) {
				const resourceId = filePanelResourceId(path, deviceId, referenceOrigin, toolEdit);
				expect(JSON.parse(resourceId)).toEqual([deviceId, path, referenceOrigin, toolEdit]);
				expect(filePanelResourceParams(resourceId)).toEqual({
					filePath: path,
					deviceId,
					...(referenceOrigin ? { referenceOrigin: true } : {}),
					toolEdit,
				});
			}
		}
		expect(filePanelResourceId(path, "local", true)).toBe(JSON.stringify(["local", path, true]));
		for (const invalid of [
			null,
			{},
			{ ...toolEdit, executionAttempt: -1 },
			{ ...toolEdit, narratorId: "" },
		]) {
			const encoded = JSON.stringify(["local", path, false, invalid]);
			expect(filePanelResourceParams(encoded)).toEqual({ filePath: encoded, deviceId: "local" });
		}
	});

	for (const surface of ["focus", "workspace"] as const) {
		it(`${surface} opens history separately without touching a live editor and refreshes repeat navigation`, () => {
			const panels = new Map<
				string,
				{
					id: string;
					params: FilePanelParams;
					api: {
						setActive: ReturnType<typeof mock>;
						updateParameters: (params: FilePanelParams) => void;
					};
				}
			>();
			const api = {
				getPanel: (id: string) => panels.get(id),
				get panels() {
					return [...panels.values()];
				},
				addPanel: ({ id, params }: { id: string; params: FilePanelParams }) => {
					const panel = {
						id,
						params,
						api: {
							setActive: mock(() => {}),
							updateParameters: (next: FilePanelParams) => {
								panel.params = next;
							},
						},
					};
					panels.set(id, panel);
				},
			} as unknown as DockviewApi;
			const store = new WorkspaceDockStore({ current: api });
			let open: NonNullable<NarratorDockContextValue["openFilePanel"]> = (
				filePath,
				fileName,
				options,
			) => store.openFilePanel("host", filePath, fileName, options);
			if (surface === "focus") {
				const captured: { current: NarratorDockContextValue | null } = { current: null };
				function Capture() {
					captured.current = useNarratorDockContext();
					return null;
				}
				renderToString(
					createElement(NarratorDockProvider, {
						narratorId: "host",
						// biome-ignore lint/correctness/noChildrenProp: required by the provider's createElement overload.
						children: createElement(Capture),
					}),
				);
				if (!captured.current?.openFilePanel) throw new Error("missing focus file opener");
				captured.current.apiRef.current = api;
				open = captured.current.openFilePanel;
			}
			const idFor = (ref?: typeof toolEdit) =>
				surface === "focus"
					? fileDockPanelId(path, "local", ref)
					: workspaceFilePanelId("host", path, "local", ref);
			open(path);
			const live = panels.get(idFor());
			const liveParams = live?.params;
			open(path, "a.ts", { toolEdit });
			const historical = panels.get(idFor(toolEdit));
			expect(historical?.params).toMatchObject({
				filePath: path,
				toolEdit,
				hostNarratorId: "host",
			});
			const firstRequest = historical?.params.highlightRequestId;
			open(path, "a.ts", { toolEdit: { ...toolEdit } });
			expect(historical?.params.highlightRequestId).not.toBe(firstRequest);
			expect(historical?.api.setActive).toHaveBeenCalledTimes(1);
			open(path, "a.ts", { toolEdit: { ...toolEdit, executionAttempt: 2 } });
			expect(panels.size).toBe(3);
			expect(live?.params).toBe(liveParams);
			expect(live?.api.setActive).not.toHaveBeenCalled();
		});
	}

	it("preserves historical resource identity through both layout stripping paths", () => {
		const params = {
			panelType: "file",
			filePath: path,
			hostNarratorId: "host",
			narratorId: "host",
			toolEdit,
			highlightRequestId: "jump",
			selection: {},
		};
		const layout = { panels: { file: { params } } } as unknown as SerializedDockview;
		for (const strip of [stripIdentityFromLayout, stripNavigationFromLayout]) {
			const restored = JSON.parse(JSON.stringify(strip(layout)));
			expect(restored.panels.file.params.toolEdit).toEqual(toolEdit);
			expect(restored.panels.file.params.highlightRequestId).toBeUndefined();
			expect(restored.panels.file.params.selection).toBeUndefined();
		}
		expect(params.highlightRequestId).toBe("jump");
	});

	it("renders the lazy historical viewer before either live disk component", async () => {
		const source = await Bun.file(new URL("./panels.tsx", import.meta.url)).text();
		const body = source.slice(
			source.indexOf("export function FileDockPanel"),
			source.indexOf("// ── File tree"),
		);
		expect(source).toContain('import("../ToolEditFileViewer")');
		expect(body).toContain("{toolEdit ? (");
		expect(body).toContain("reference={toolEdit}");
		expect(body).toContain("key={toolEditReferenceKey(toolEdit)}");
		expect(body).toMatch(/toolEdit \? `.* · Edit`/);
		expect(body.indexOf("<ToolEditFileViewer")).toBeLessThan(body.indexOf("<FileEditorContent"));
		expect(body).toContain(") : isText ? (");
		expect(body).toContain("filePanelResourceId(filePath, deviceId, referenceOrigin, toolEdit)");
	});
});

describe("workspaceFilePanelId", () => {
	it("scopes the id to the host narrator", () => {
		const path = "/repo/package.json";
		expect(workspaceFilePanelId("nA", path)).not.toBe(workspaceFilePanelId("nB", path));
	});

	it("reuses the focus dock's hash so both surfaces agree on identity", () => {
		const path = "/repo/package.json";
		expect(workspaceFilePanelId("nA", path)).toBe(`wfile_nA_${hashFilePath(path)}`);
	});

	it("is stable for the same host + path and distinct across paths", () => {
		expect(workspaceFilePanelId("nA", "/x/a.json")).toBe(workspaceFilePanelId("nA", "/x/a.json"));
		expect(workspaceFilePanelId("nA", "/x/a.json")).not.toBe(
			workspaceFilePanelId("nA", "/x/b.json"),
		);
	});
});
