/**
 * Creating a session on an execution device from the home page.
 *
 * The home page's directory control used to browse only this server, so a session could
 * not be created on a remote device from there at all. These tests pin what the server
 * depends on:
 *  - "local" stays the default and submits no `deviceId`;
 *  - picking a remote device prefills that device's directory and submits both;
 *  - a remote device without a directory blocks the send (the server refuses it too);
 *  - a persisted device that is gone is never silently replaced by the local machine;
 *  - a single-machine instance sees no device selector at all.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

/** Devices the mocked workspace query reports for the next render. */
let devices: Array<{ id: string; name: string; online: boolean; defaultCwd?: string | null }> = [];
/** Props the device-aware directory modal received on its last render. */
let modalProps: Record<string, unknown> | null = null;
/** The create payload fields these tests assert on; the composer submits more. */
type CreatePayload = { deviceId?: string | null; cwd?: string | null };
const create = mock(async (_payload: CreatePayload) => ({
	id: "new-session",
	title: "New",
	cwd: "/workspace",
	status: "idle",
}));
const sendMessage = mock(async () => ({ id: "message" }));
const clearAttachments = mock(() => {});
const noteSent = mock(() => {});
const clearText = mock(() => {});
let sendRequested: (() => void) | null = null;

mock.module("@mantine/core", () => ({
	ActionIcon: box,
	Box: box,
	Button: ({
		children,
		disabled,
		onClick,
	}: {
		children?: ReactNode;
		disabled?: boolean;
		onClick?: () => void;
	}) => (
		<button type="button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
	Group: box,
	Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	Tooltip: box,
	Select: ({
		"aria-label": ariaLabel,
		data,
		value,
		onChange,
	}: {
		"aria-label"?: string;
		data?: Array<{ value: string; label: string; disabled?: boolean }>;
		value?: string;
		onChange?: (value: string) => void;
	}) => (
		<div data-device-select={ariaLabel} data-value={value}>
			{(data ?? []).map((item) => (
				<button
					key={item.value}
					type="button"
					data-device-option={item.value}
					disabled={item.disabled}
					onClick={() => onChange?.(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	),
}));
mock.module("@mantine/notifications", () => ({ notifications: { show: mock(() => "notice") } }));
mock.module("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { agent: { defaultPermissionMode: "default", defaultStartInPlanMode: false } },
	}),
}));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => mock(() => {}) }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("../../hooks/useAuth", () => ({ useCurrentUser: () => ({ data: { id: "user" } }) }));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutateAsync: create, isPending: false }),
}));
mock.module("../../hooks/usePlatform", () => ({
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useNarratorPlanModeCapability: () => ({ supported: false }),
}));
mock.module("../../hooks/useProjectDirStatus", () => ({
	useProjectDirStatus: () => ({ usablePath: "/workspace", needsChoice: false }),
}));
mock.module("../../hooks/useRecentTabs", () => ({ addRecentTab: async () => {} }));
mock.module("../../hooks/useWorkspaceContext", () => ({
	useWorkspaceDevices: () => ({ data: { devices }, isSuccess: true }),
}));
mock.module("../../lib/api", () => ({
	api: {
		getSettings: mock(async () => ({ agent: {} })),
		sendNarratorMessage: sendMessage,
		browseWorkspaceDirectory: mock(async () => ({
			path: "",
			entries: [],
			parent: null,
			sep: "/",
		})),
	},
	isAbortError: () => false,
}));
mock.module("../common/DeviceDirectoryPicker", () => ({
	DeviceDirectoryModal: (props: Record<string, unknown>) => {
		modalProps = props;
		return props.opened ? (
			<div data-device-modal={String(props.deviceId)}>
				<button
					type="button"
					data-select-picked="true"
					onClick={() => (props.onSelect as (path: string) => void)("/picked/dir")}
				/>
			</div>
		) : null;
	},
}));
mock.module("../narrator/CreateNarratorLazyModal", () => ({
	CreateNarratorLazyModal: () => null,
	preloadCreateNarratorModal: () => {},
}));
mock.module("../narrator/interaction/PermissionModePickerMenu", () => ({
	PermissionModePickerMenu: () => null,
}));
mock.module("../narrator/interaction/UploadProgressBar", () => ({ UploadProgressBar: () => null }));
mock.module("../narrator/interaction/use-composer-attachments", () => ({
	useComposerAttachments: () => ({
		attachedImages: [],
		attachedTextFiles: [],
		attachedMedia: [],
		attachedMediaRef: { current: [] },
		attachmentsHydrating: false,
		attachmentsRestoreFailed: false,
		retryAttachmentRestore: () => {},
		restoredAttachmentResources: [],
		setIsDragging: () => {},
		dragCounterRef: { current: 0 },
		updateAttachedImages: () => {},
		updateAttachedTextFiles: () => {},
		updateAttachedMedia: () => {},
		reconcileDocumentAssets: () => {},
		clearAttachedFilesAndDraft: clearAttachments,
	}),
}));
mock.module("../narrator/interaction/use-composer-file-ingest", () => ({
	useComposerFileIngest: () => ({
		handleFileInputChange: () => {},
		handleComposerPasteImages: () => {},
		dropZoneProps: {},
		ingestingRef: { current: false },
	}),
}));
mock.module("../narrator/interaction/use-narrator-send", () => ({
	snapshotComposerFiles: () => ({ images: [], textFiles: [], media: [] }),
}));
mock.module("../narrator/model/ModelPickerMenu", () => ({ ModelPickerMenu: () => null }));
mock.module("../narrator/model/ReasoningEffortPickerMenu", () => ({
	ReasoningEffortPickerMenu: () => null,
}));
mock.module("../narrator/model/use-draft-reasoning-effort", () => ({
	useDraftReasoningEffort: () => ({ supported: false, options: [], defaultEffort: undefined }),
}));
mock.module("../narrator/composer/NarratorComposer", () => ({
	NarratorComposer: ({
		ref,
		actions,
		onSendWithMode,
	}: {
		ref?: React.Ref<unknown>;
		actions?: ReactNode;
		onSendWithMode?: () => void;
	}) => {
		sendRequested = onSendWithMode ?? null;
		useImperativeHandle(
			ref,
			() => ({
				getText: () => "hello",
				getDocument: () => undefined,
				getFileReferences: () => [],
				hasMissingAssets: () => false,
				captureAttachmentInsertion: () => ({ restore: () => true, cancel: () => {} }),
				captureAttachmentSelection: () => {},
				insertAcceptedFiles: () => true,
				focus: () => {},
				noteSent,
				clearTextAndDraft: clearText,
			}),
			[],
		);
		return (
			<div data-composer="true">
				{/* The start button lives in the composer's action slot; the send path itself
				    is exercised through `onSendWithMode` below. */}
				{actions}
			</div>
		);
	},
}));

const { DashboardComposer } = await import("./DashboardComposer");

const COMPOSER_PREFS_KEY = "narrafork_dashboard_composer";
let stored = new Map<string, string>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	const { window, document } = parseHTML("<html><body></body></html>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: window,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		writable: true,
		value: document,
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
		},
	});
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div") as unknown as HTMLDivElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container);
	devices = [];
	modalProps = null;
	sendRequested = null;
	stored = new Map();
	create.mockClear();
	sendMessage.mockClear();
	noteSent.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
});

function render() {
	act(() => root.render(<DashboardComposer />));
}

function deviceSelect(): HTMLElement | null {
	return container.querySelector("[data-device-select]");
}

function pickDevice(deviceId: string) {
	const option = container.querySelector(`[data-device-option="${deviceId}"]`);
	if (!option) throw new Error(`Device option ${deviceId} not rendered`);
	act(() => (option as unknown as HTMLButtonElement).click());
}

async function send() {
	if (!sendRequested) throw new Error("Composer did not request a send");
	await act(async () => {
		sendRequested?.();
	});
}

test("a single-machine instance shows no device selector and creates locally", async () => {
	render();
	expect(deviceSelect()).toBeNull();
	expect(modalProps).not.toBeNull();
	await send();
	expect(create).toHaveBeenCalledTimes(1);
	const payload = create.mock.calls[0][0];
	expect(payload.deviceId).toBeUndefined();
});

test("picking a remote device prefills its directory and submits device plus path", async () => {
	devices = [{ id: "win-box", name: "windows box", online: true, defaultCwd: "C:\\work" }];
	render();
	expect(deviceSelect()?.getAttribute("data-value")).toBe("local");
	pickDevice("win-box");
	// The directory follows the device: a local path is meaningless on that machine.
	expect(modalProps?.deviceId).toBe("win-box");
	expect(modalProps?.initialPath).toBe("C:\\work");
	await send();
	const payload = create.mock.calls[0][0];
	expect(payload.deviceId).toBe("win-box");
	expect(payload.cwd).toBe("C:\\work");
});

test("a remote device without a directory refuses to send and opens the picker", async () => {
	devices = [{ id: "win-box", name: "windows box", online: true, defaultCwd: null }];
	render();
	pickDevice("win-box");
	await send();
	expect(create).not.toHaveBeenCalled();
	expect(modalProps?.opened).toBe(true);
});

test("the chosen target is remembered across mounts", async () => {
	stored.set(COMPOSER_PREFS_KEY, JSON.stringify({ deviceId: "win-box", cwd: "C:\\srv" }));
	devices = [{ id: "win-box", name: "windows box", online: true, defaultCwd: "C:\\work" }];
	render();
	expect(deviceSelect()?.getAttribute("data-value")).toBe("win-box");
	await send();
	const payload = create.mock.calls[0][0];
	// A remembered path is kept even when the device declares a different default.
	expect(payload.cwd).toBe("C:\\srv");
	expect(payload.deviceId).toBe("win-box");
});

test("a remembered device that is gone is reported, never replaced by this server", async () => {
	stored.set(COMPOSER_PREFS_KEY, JSON.stringify({ deviceId: "gone-box", cwd: "/srv/app" }));
	devices = [];
	render();
	expect(container.textContent).toContain("composer.deviceUnavailable");
	// The menu stays so the warning has a way back. Sending must not open an empty
	// directory dialog, and it must not create the session on this server by itself.
	expect(deviceSelect()?.getAttribute("data-value")).toBe("gone-box");
	const start = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === "composer.start",
	) as unknown as HTMLButtonElement;
	expect(start.disabled).toBe(true);
	await send();
	expect(create).not.toHaveBeenCalled();
	expect(modalProps?.opened).toBe(false);
	pickDevice("local");
	await send();
	expect(create).toHaveBeenCalledTimes(1);
	const payload = create.mock.calls[0][0];
	expect(payload.deviceId).toBeUndefined();
	expect(payload.cwd).toBe("/workspace");
});

test("an offline remembered device blocks send without opening the directory picker", async () => {
	stored.set(COMPOSER_PREFS_KEY, JSON.stringify({ deviceId: "asleep", cwd: "/srv/app" }));
	devices = [{ id: "asleep", name: "asleep box", online: false, defaultCwd: "/srv/app" }];
	render();
	const offline = container.querySelector(
		'[data-device-option="asleep"]',
	) as unknown as HTMLButtonElement;
	expect(offline.disabled).toBe(true);
	await send();
	expect(create).not.toHaveBeenCalled();
	expect(modalProps?.opened).toBe(false);
});
