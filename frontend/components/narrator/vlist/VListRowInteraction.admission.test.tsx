import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NarratorDockContext, type NarratorDockContextValue } from "../dock/NarratorDockContext";
import type { VListRowInteractionProps } from "./VListRowInteraction";
import { createVListInteractionAdmission } from "./vlist-interaction-admission";
import { VListInteractionAdmissionContext } from "./vlist-interaction-admission-context";

// Real admission, media-query and swipe hooks exercise the first native gesture.
const realHooks = { ...(await import("@mantine/hooks")) };
const realI18n = { ...(await import("react-i18next")) };
const realPlatform = { ...(await import("@frontend/hooks/usePlatform")) };
const realSelection = { ...(await import("../message/MessageSelectionCtx")) };
const realInspector = { ...(await import("../content/ContentInspector")) };
const translations = mock((_namespace: string) => ({ t: (key: string) => key }));
const platformHook = mock(() => platform);
const clipboardCopy = mock((_value: string) => {});
const clipboardHook = mock(() => ({ copied: false, copy: clipboardCopy, reset: () => {} }));
const toggleBlock = mock((_id: string) => {});
const rangeSelectTo = mock((_id: string) => {});
const deselectBlock = mock((_id: string) => {});
const selectedBlockIds = new Set<string>();
let platform: "windows" | "linux" = "linux";
let mobile = false;
let bodyMounts = 0;
let bodyUnmounts = 0;
const selection = {
	selectionMode: false,
	selectedBlockIds,
	toggleBlock,
	rangeSelectTo,
	deselectBlock,
};

mock.module("@mantine/hooks", () => realHooks);
mock.module("@frontend/hooks/useClipboard", () => ({ useClipboard: clipboardHook }));
mock.module("react-i18next", () => ({ ...realI18n, useTranslation: translations }));
mock.module("@frontend/hooks/usePlatform", () => ({ ...realPlatform, usePlatform: platformHook }));
mock.module("../message/MessageSelectionCtx", () => ({
	...realSelection,
	useMessageSelection: () => selection,
}));
mock.module("../content/ContentInspector", () => ({
	ContentInspector: ({ content, onClose }: { content: string; onClose: () => void }) => (
		<div data-inspector>
			{content}
			<button type="button" onClick={onClose}>
				close inspector
			</button>
		</div>
	),
}));
const { VListRowInteraction } = await import("./VListRowInteraction");

function createClock() {
	let time = 0;
	let nextId = 0;
	const timers = new Map<number, () => void>();
	const frames = new Map<number, () => void>();
	return {
		runtime: {
			now: () => time,
			setTimeout(callback: () => void, _delay: number) {
				const id = ++nextId;
				timers.set(id, callback);
				return id;
			},
			clearTimeout: (id: number) => {
				timers.delete(id);
			},
			requestAnimationFrame(callback: () => void) {
				const id = ++nextId;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame: (id: number) => {
				frames.delete(id);
			},
		},
		quiet() {
			time += 120;
			for (const [id, callback] of [...timers]) {
				timers.delete(id);
				callback();
			}
		},
		frame() {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback();
			}
		},
	};
}

let clock: ReturnType<typeof createClock>;
let admission: ReturnType<typeof createVListInteractionAdmission>;
let root: Root;
let container: HTMLDivElement;
const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: query === MOBILE_VIEWPORT_MEDIA_QUERY && mobile,
		media: query,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.defineProperties(window, {
		innerWidth: { configurable: true, value: 1024 },
		innerHeight: { configurable: true, value: 768 },
		getSelection: { configurable: true, value: () => null },
		matchMedia: { configurable: true, value: matchMedia },
		requestAnimationFrame: { configurable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, value: cancelAnimationFrame },
	});
	class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver,
		MutationObserver: ResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: () => ({
			overflowX: "visible",
			overflowY: "visible",
			getPropertyValue: () => "",
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		globalDescriptors.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
		} else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function Body() {
	useEffect(() => {
		bodyMounts++;
		return () => {
			bodyUnmounts++;
		};
	}, []);
	return <div data-body>row body</div>;
}

type RowOverrides = Partial<Omit<VListRowInteractionProps, "children">>;
async function renderRows(
	rows: RowOverrides[] = [{}],
	dock: NarratorDockContextValue | null = null,
	scoped = true,
) {
	await act(async () => {
		root.render(
			<MantineProvider>
				<NarratorDockContext.Provider value={dock}>
					<VListInteractionAdmissionContext.Provider value={scoped ? admission : null}>
						{rows.map((props, index) => (
							<VListRowInteraction
								key={props.blockId ?? index}
								blockId={`msg-${index}`}
								messageId={`message-${index}`}
								blockIndex={2}
								blockIndices={[2, 3]}
								copyText="copy body"
								actions={{ messageId: `message-${index}` }}
								{...props}
							>
								<Body />
							</VListRowInteraction>
						))}
					</VListInteractionAdmissionContext.Provider>
				</NarratorDockContext.Provider>
			</MantineProvider>,
		);
	});
}

function boxes() {
	return [...container.querySelectorAll<HTMLElement>("[data-content-block]")];
}
function dispatch(node: HTMLElement, type: string, fields: Record<string, unknown> = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, fields);
	node.dispatchEvent(event);
	return event;
}
async function rightClick(node: HTMLElement) {
	await act(async () => {
		dispatch(node, "contextmenu", { clientX: 200, clientY: 160 });
	});
}
function menuItem(label: string) {
	const item = [...document.querySelectorAll<HTMLElement>(".mantine-Menu-item")].find(
		(node) => node.textContent?.trim() === label,
	);
	if (!item) throw new Error(`Missing menu item: ${label}`);
	return item;
}

beforeEach(() => {
	mobile = false;
	platform = "linux";
	bodyMounts = 0;
	bodyUnmounts = 0;
	selectedBlockIds.clear();
	for (const spy of [
		translations,
		platformHook,
		clipboardHook,
		clipboardCopy,
		toggleBlock,
		rangeSelectTo,
		deselectBlock,
	])
		spy.mockClear();
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	clock = createClock();
	admission = createVListInteractionAdmission({ runtime: clock.runtime });
	admission.markHistoryIntent();
});
afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	admission.suspend();
	container.remove();
	expect(admission.getDebugSnapshot().active).toBe(0);
	for (const [key, descriptor] of globalDescriptors) {
		if (!descriptor) Reflect.deleteProperty(globalThis, key);
		else if (!descriptor.configurable && "writable" in descriptor && descriptor.writable)
			Reflect.set(globalThis, key, descriptor.value);
		else Object.defineProperty(globalThis, key, descriptor);
	}
	globalDescriptors.clear();
});
afterAll(() => {
	mock.module("@mantine/hooks", () => realHooks);
	mock.module("react-i18next", () => realI18n);
	mock.module("@frontend/hooks/usePlatform", () => realPlatform);
	mock.module("../message/MessageSelectionCtx", () => realSelection);
	mock.module("../content/ContentInspector", () => realInspector);
	mock.restore();
});

describe("VList row controller admission — actual DOM", () => {
	test("cold history retains DOM and first selection gestures without controller hooks", async () => {
		await renderRows();
		const box = boxes()[0];
		expect(box.textContent).toContain("row body");
		expect(box.getAttribute("data-block-id")).toBe("msg-0");
		expect(box.getAttribute("data-message-id")).toBe("message-0");
		expect(box.getAttribute("data-block-index")).toBe("2");
		expect(box.getAttribute("data-block-indices")).toBe("2,3");
		expect(translations).not.toHaveBeenCalled();
		expect(platformHook).not.toHaveBeenCalled();
		expect(clipboardHook).not.toHaveBeenCalled();
		await act(async () => {
			dispatch(box, "click", { ctrlKey: true });
			dispatch(box, "click", { shiftKey: true });
		});
		expect(toggleBlock).toHaveBeenCalledWith("msg-0");
		expect(rangeSelectTo).toHaveBeenCalledWith("msg-0");
		expect(platformHook).not.toHaveBeenCalled();
	});

	test("idle batches admit two rows per frame without replacing the Box/body; warm rows survive scrolling", async () => {
		await renderRows([{}, {}, {}]);
		const originalBoxes = boxes();
		const bodies = originalBoxes.map((box) => box.firstElementChild);
		expect(admission.getDebugSnapshot().pending).toBe(3);
		await act(async () => {
			clock.quiet();
		});
		expect(platformHook).not.toHaveBeenCalled();
		await act(async () => {
			clock.frame();
		});
		expect(platformHook).toHaveBeenCalledTimes(2);
		expect(admission.getDebugSnapshot().pending).toBe(1);
		await act(async () => {
			clock.frame();
		});
		expect(platformHook).toHaveBeenCalledTimes(3);
		await act(async () => {
			admission.observeScroll({ scrollTop: 80, viewportHeight: 300, atBottom: false });
		});
		for (const [index, box] of boxes().entries()) {
			expect(box).toBe(originalBoxes[index]);
			expect(box.firstElementChild).toBe(bodies[index]);
		}
		expect(platformHook).toHaveBeenCalledTimes(3);
		expect(bodyMounts).toBe(3);
		expect(bodyUnmounts).toBe(0);
		expect(admission.getDebugSnapshot().pending).toBe(0);
	});

	test("the first right-click admits only its row and uses newest callbacks", async () => {
		const oldEdit = mock(() => {});
		const latestEdit = mock(() => {});
		await renderRows([{ actions: { messageId: "message-0", onEditMessage: oldEdit } }, {}]);
		await renderRows([{ actions: { messageId: "message-0", onEditMessage: latestEdit } }, {}]);
		const box = boxes()[0];
		const body = box.firstElementChild;
		await rightClick(box);
		expect(menuItem("contextMenu_edit")).toBeTruthy();
		expect(platformHook).toHaveBeenCalledTimes(1);
		expect(admission.getPhase()).toBe("history-scrolling");
		expect(admission.getDebugSnapshot().pending).toBe(1);
		await act(async () => {
			menuItem("contextMenu_edit").click();
		});
		expect(latestEdit).toHaveBeenCalledTimes(1);
		expect(oldEdit).not.toHaveBeenCalled();
		expect(boxes()[0]).toBe(box);
		expect(box.firstElementChild).toBe(body);
		expect(bodyUnmounts).toBe(0);
	});

	test("first native touch swipe force-admits the menu and preserves closing items", async () => {
		mobile = true;
		await renderRows();
		const box = boxes()[0];
		expect(platformHook).not.toHaveBeenCalled();
		await act(async () => {
			dispatch(box, "touchstart", { touches: [{ clientX: 300, clientY: 120 }] });
			dispatch(box, "touchmove", { touches: [{ clientX: 280, clientY: 120 }] });
		});
		expect(platformHook).not.toHaveBeenCalled();
		await act(async () => {
			dispatch(box, "touchmove", { touches: [{ clientX: 180, clientY: 120 }] });
		});
		expect(menuItem("copy")).toBeTruthy();
		expect(box.style.transform).toBe("translateX(-120px)");
		await act(async () => {
			dispatch(box, "touchend");
		});
		expect(menuItem("copy")).toBeTruthy();
		expect(menuItem("cancel")).toBeTruthy();
		expect(box.style.transform).toBe("translateX(-180px)");
		expect(admission.getPhase()).toBe("history-scrolling");
		await act(async () => {
			menuItem("cancel").click();
		});
		expect(menuItem("copy")).toBeTruthy();
		expect(menuItem("cancel")).toBeTruthy();
		await act(async () => {
			admission.markHistoryIntent();
		});
		expect(admission.getDebugSnapshot().pending).toBe(0);
		expect(boxes()[0]).toBe(box);
		expect(bodyUnmounts).toBe(0);
	});

	test("warm controller receives updated Windows paths, tool identities and navigation callbacks", async () => {
		const oldOpen = mock((..._args: unknown[]) => {});
		const latestOpen = mock((..._args: unknown[]) => {});
		const oldRow: RowOverrides = {
			narratorId: "old-reader",
			toolUseId: "render-id",
			toolDetailRef: { toolUseId: "old-tool", toolCallId: "old-call" },
			toolMeta: { toolName: "Edit", filePath: "/old.ts", isFileTool: true },
		};
		await renderRows([oldRow], {
			narratorId: "host",
			openFilePanel: oldOpen,
		} as unknown as NarratorDockContextValue);
		await act(async () => {
			clock.quiet();
			clock.frame();
		});
		platform = "windows";
		const latestRow: RowOverrides = {
			...oldRow,
			narratorId: "latest-reader",
			toolDetailRef: {
				toolUseId: "actual-tool",
				toolCallId: "actual-call",
				messageId: "actual-message",
				executionAttempt: 3,
			},
			toolMeta: { toolName: "Edit", filePath: "C:/work/new.ts", isFileTool: true },
		};
		await renderRows([latestRow], {
			narratorId: "host",
			openFilePanel: latestOpen,
		} as unknown as NarratorDockContextValue);
		await rightClick(boxes()[0]);
		await act(async () => {
			menuItem("contextMenu_copyFilePath").click();
		});
		expect(clipboardCopy).toHaveBeenCalledWith("C:\\work\\new.ts");
		await rightClick(boxes()[0]);
		await act(async () => {
			menuItem("editPreview.open").click();
		});
		expect(latestOpen).toHaveBeenCalledWith("C:/work/new.ts", undefined, {
			toolEdit: { narratorId: "latest-reader", ...latestRow.toolDetailRef },
		});
		expect(oldOpen).not.toHaveBeenCalled();
		expect(bodyMounts).toBe(1);
	});

	test("an opened inspector and its latest content persist across history scroll", async () => {
		const row = { inspectContent: { title: "injection", text: "original payload" } };
		await renderRows([row]);
		await rightClick(boxes()[0]);
		await act(async () => {
			menuItem("contentInspector.inspect").click();
		});
		expect(document.querySelector("[data-inspector]")?.textContent).toContain("original payload");
		await act(async () => {
			admission.observeScroll({ scrollTop: 200, viewportHeight: 300, atBottom: false });
		});
		await renderRows([{ inspectContent: { ...row.inspectContent, text: "latest payload" } }]);
		expect(document.querySelector("[data-inspector]")?.textContent).toContain("latest payload");
		await act(async () => {
			document.querySelector<HTMLButtonElement>("[data-inspector] button")?.click();
		});
		expect(document.querySelector("[data-inspector]")).toBeNull();
		expect(admission.getDebugSnapshot().pending).toBe(0);
		expect(bodyUnmounts).toBe(0);
	});

	test("at-bottom and absent-scope rows eagerly mount controls", async () => {
		admission.setAtBottom(true);
		await renderRows();
		expect(platformHook).toHaveBeenCalled();
		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		platformHook.mockClear();
		admission.markHistoryIntent();
		await renderRows([{}], null, false);
		expect(platformHook).toHaveBeenCalled();
	});
});
