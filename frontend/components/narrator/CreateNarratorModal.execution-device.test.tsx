/**
 * Creating a session on an execution device.
 *
 * The dialog picks the executor first, because the directory field means something
 * different per device: a local path list (picker + favorites) on this server, a plain
 * absolute path on another machine. These tests pin the parts the server depends on:
 *  - "local" stays the default and submits no `deviceId`;
 *  - an offline device cannot be selected;
 *  - picking a remote device replaces the local picker and submits device + directory;
 *  - a remote device with no directory blocks submit (the server refuses it too).
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

interface SelectOption {
	value?: string;
	label?: string;
	disabled?: boolean;
}

const create = mock((_data: Record<string, unknown>, _options?: unknown) => {});
const invalidateQueries = mock(() => Promise.resolve());
const setNarratorGitIdentity = mock(() => Promise.resolve({ ok: true }));

const devices = [
	{
		id: "win-box",
		name: "windows box",
		online: true,
		platform: { os: "windows" },
		defaultCwd: "C:\\work",
		scope: "project" as const,
	},
	{
		id: "asleep-box",
		name: "asleep box",
		online: false,
		defaultCwd: "/srv/app",
		scope: "project" as const,
	},
];

/** Text the mocked directory field will report on its next "type" click. */
let typedDirectory = "";

mock.module("@mantine/core", () => ({
	Alert: box,
	Badge: box,
	Box: box,
	Divider: box,
	Loader: box,
	SegmentedControl: box,
	Group: box,
	Stack: box,
	Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	TextInput: ({
		label,
		value,
		onChange,
		error,
	}: {
		label?: string;
		value?: string;
		onChange?: (event: { currentTarget: { value: string } }) => void;
		error?: string;
	}) => (
		<div data-label={label} data-value={value ?? ""} data-error={error ?? ""}>
			<button
				type="button"
				data-type-directory="true"
				onClick={() => onChange?.({ currentTarget: { value: typedDirectory } })}
			/>
		</div>
	),
	Textarea: box,
	Menu: Object.assign(box, {
		Target: box,
		Dropdown: box,
		Label: box,
		Item: box,
		Divider: box,
	}),
	NumberInput: box,
	Tooltip: box,
	ActionIcon: box,
	Checkbox: box,
	ScrollArea: box,
	Select: ({
		label,
		data,
		value,
		onChange,
	}: {
		label?: string;
		data?: SelectOption[];
		value?: string;
		onChange?: (value: string | null) => void;
	}) => (
		<div data-select={label} data-value={value ?? ""}>
			{(data ?? []).map((item) =>
				item.value ? (
					<button
						key={item.value}
						type="button"
						data-device-option={item.value}
						disabled={item.disabled}
						onClick={() => onChange?.(item.value ?? null)}
					>
						{item.label}
					</button>
				) : null,
			)}
		</div>
	),
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
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
}));
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => false }));
mock.module("@mantine/notifications", () => ({ notifications: { show: mock(() => {}) } }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQuery: () => ({ data: { paths: { defaultProjectDir: "/instance" }, agent: {} } }),
	useQueryClient: () => ({ invalidateQueries }),
	useMutation: () => ({ mutate: mock(() => {}), reset: mock(() => {}), isPending: false }),
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../../hooks/useProjectDirStatus", () => ({
	useProjectDirStatus: () => ({ usablePath: "/instance", needsChoice: false, isLoading: false }),
}));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutate: create, isPending: false }),
}));
mock.module("../../hooks/usePromptLibrary", () => ({
	usePromptLibrary: () => ({ data: [], isLoading: false }),
	useCreatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useUpdatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useDeletePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
}));
const mutation = { mutate: mock(() => {}), reset: mock(() => {}), isPending: false };
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => mutation,
	useDeleteFavoriteDirectory: () => mutation,
	useReorderFavoriteDirectories: () => mutation,
}));
mock.module("../../hooks/useGitIdentityVisibility", () => ({
	useGitIdentityVisibility: () => ({
		contextMenu: false,
		createModal: false,
		setContextMenu: () => {},
		setCreateModal: () => {},
	}),
}));
mock.module("../../hooks/useGitIdentities", () => ({
	useGitIdentities: () => ({
		data: [],
		isLoading: false,
		isError: false,
	}),
	narratorGitIdentityQueryKey: (id: string) => ["narrator", id, "gitIdentity"],
}));
mock.module("../../hooks/useWorkspaceContext", () => ({
	useWorkspaceDevices: () => ({
		data: { devices },
		isLoading: false,
		error: null,
	}),
}));
mock.module("../../lib/api", () => ({
	api: {
		getSettings: mock(() => {}),
		setNarratorGitIdentity,
		browseWorkspaceDirectory: mock(async () => ({
			path: "",
			entries: [],
			parent: null,
			sep: "\\",
			truncated: false,
		})),
	},
	getToken: () => null,
}));
// The local picker is a marker: these tests assert WHICH editor is shown, so a real
// picker (with its own queries) would only add moving parts.
mock.module("../common/DirectoryPicker", () => ({
	DirectoryPicker: () => <div data-local-directory-picker="true" />,
}));

const { CreateNarratorModalBody } = await import("./CreateNarratorModal");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	const { document } = parseHTML("<html><body></body></html>");
	(globalThis as unknown as { window: unknown }).window = document;
	(globalThis as unknown as { document: unknown }).document = document;
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div") as unknown as HTMLDivElement;
	document.body.appendChild(container as unknown as Node);
	root = createRoot(container);
	create.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
});

function render() {
	act(() => {
		root.render(<CreateNarratorModalBody opened onClose={() => {}} />);
	});
}

function submit() {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === "createNarrator",
	);
	if (!button) throw new Error("Create button not found");
	act(() => button.click());
}

function pickDevice(deviceId: string) {
	const option = container.querySelector(`[data-device-option="${deviceId}"]`);
	if (!option) throw new Error(`Device option ${deviceId} not rendered`);
	act(() => (option as unknown as HTMLButtonElement).click());
}

function directoryField(): HTMLElement | null {
	return container.querySelector('[data-label="workingDirectory"]');
}

function typeDirectory(value: string) {
	const field = directoryField();
	if (!field) throw new Error("Directory field not rendered");
	const button = field.querySelector("[data-type-directory]");
	if (!button) throw new Error("Directory field is not editable");
	typedDirectory = value;
	act(() => (button as unknown as HTMLButtonElement).click());
}

test("local stays the default and submits no device", () => {
	render();
	expect(container.querySelector("[data-local-directory-picker]")).not.toBeNull();
	expect(container.querySelector("[data-select]")?.getAttribute("data-value")).toBe("local");
	submit();
	expect(create).toHaveBeenCalledTimes(1);
	const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
	expect(payload.deviceId).toBeUndefined();
});

test("an offline device cannot be selected", () => {
	render();
	const offline = container.querySelector(
		'[data-device-option="asleep-box"]',
	) as unknown as HTMLButtonElement;
	expect(offline.disabled).toBe(true);
	const online = container.querySelector(
		'[data-device-option="win-box"]',
	) as unknown as HTMLButtonElement;
	expect(online.disabled).toBe(false);
});

test("picking a remote device swaps in its own path editor and submits device + directory", () => {
	render();
	pickDevice("win-box");
	// The local picker no longer applies: its favorites and drive list are meaningless there.
	expect(container.querySelector("[data-local-directory-picker]")).toBeNull();
	// The device's declared directory is prefilled, and it is editable.
	expect(directoryField()?.getAttribute("data-value")).toBe("C:\\work");
	typeDirectory("C:\\srv");
	expect(directoryField()?.getAttribute("data-value")).toBe("C:\\srv");
	submit();
	const payload = create.mock.calls[0]?.[0] as Record<string, unknown>;
	expect(payload.deviceId).toBe("win-box");
	expect(payload.cwd).toBe("C:\\srv");
});

test("a remote creation with no directory cannot be submitted", () => {
	render();
	pickDevice("win-box");
	typeDirectory("");
	expect(directoryField()?.getAttribute("data-error")).toBe("workingDirectoryRemoteRequired");
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === "createNarrator",
	) as unknown as HTMLButtonElement;
	expect(button.disabled).toBe(true);
});
