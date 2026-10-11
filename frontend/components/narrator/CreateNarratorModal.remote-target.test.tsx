import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

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
const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const create = mock((_input: Record<string, unknown>, _options?: unknown) => {});
let settingsResolve: ((value: unknown) => void) | undefined;
let settingsResult: Promise<unknown>;
let remoteDevice = {
	id: "remote",
	name: "Remote",
	status: "online",
	platformOs: "linux",
	defaultCwd: "/device-default",
};
mock.module("../../lib/api", () => ({
	api: {
		getSettings: () => settingsResult,
		listDevices: async () => [remoteDevice],
	},
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutate: create, isPending: false }),
}));
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [{ id: "fav", path: "/host/favorite" }] }),
	useCreateFavoriteDirectory: () => ({ mutate: () => {} }),
	useDeleteFavoriteDirectory: () => ({ mutate: () => {} }),
	useReorderFavoriteDirectories: () => ({ mutate: () => {} }),
}));
mock.module("../common/DirectoryPicker", () => ({
	DirectoryPicker: ({
		value,
		onChange,
		deviceId,
		placeholder,
		description,
	}: {
		value: string;
		onChange: (value: string) => void;
		deviceId: string;
		placeholder?: string;
		description?: string;
	}) => (
		<input
			data-directory-device={deviceId}
			data-directory-hint={description}
			placeholder={placeholder}
			value={value}
			onInput={(event) => onChange(event.currentTarget.value)}
		/>
	),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => false }));
mock.module("@dnd-kit/core", () => ({
	closestCenter: () => {},
	DndContext: Wrapper,
	DragOverlay: Wrapper,
	PointerSensor: class {},
	useSensor: () => ({}),
	useSensors: () => [],
}));
mock.module("@dnd-kit/sortable", () => ({
	SortableContext: Wrapper,
	useSortable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: () => {},
		transform: null,
		transition: undefined,
		isDragging: false,
	}),
	verticalListSortingStrategy: {},
}));
mock.module("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
mock.module("@mantine/core", () => ({
	ActionIcon: Wrapper,
	Divider: Wrapper,
	Group: Wrapper,
	ScrollArea: Wrapper,
	Stack: Wrapper,
	Text: Wrapper,
	Tooltip: Wrapper,
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
	TextInput: () => null,
	Checkbox: () => null,
	Select: ({
		label,
		data,
		onChange,
	}: {
		label: string;
		data: Array<{ value: string; label: string; disabled?: boolean }>;
		onChange: (value: string) => void;
	}) => (
		<div data-select={label}>
			{data.map((option) => (
				<button
					type="button"
					key={option.value}
					data-device={option.value}
					disabled={option.disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CreateNarratorModal } = await import("./CreateNarratorModal");
let root: Root, container: HTMLElement, client: InstanceType<typeof QueryClient>;
async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	create.mockClear();
	remoteDevice = {
		id: "remote",
		name: "Remote",
		status: "online",
		platformOs: "linux",
		defaultCwd: "/device-default",
	};
	settingsResult = new Promise((resolve) => {
		settingsResolve = resolve;
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function mount(initialCwd?: string, initialDeviceId?: string, opened = true) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<CreateNarratorModal
					opened={opened}
					onClose={() => {}}
					initialCwd={initialCwd}
					initialDeviceId={initialDeviceId}
				/>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await flush();
	});
}
async function selectRemote() {
	await act(async () => {
		(container.querySelector('[data-device="remote"]') as HTMLButtonElement).click();
		await flush();
	});
}
async function submit() {
	await act(async () => {
		[...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "createNarrator")
			?.click();
		await flush();
	});
}
test("remote selection isolates host favorites, keeps chosen cwd after late settings, and sends only workspaceTarget", async () => {
	await mount();
	expect(container.textContent).toContain("/host/favorite");
	await selectRemote();
	expect(container.textContent).not.toContain("/host/favorite");
	await act(async () => {
		const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
		if (!field) throw new Error("remote field missing");
		field.value = "/selected repo";
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
		settingsResolve?.({ paths: { defaultProjectDir: "/host/default" } });
		await flush();
	});
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "/selected repo",
	});
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
});
test("empty remote cwd cannot accidentally submit legacy local creation", async () => {
	await mount();
	await selectRemote();
	await act(async () => {
		const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
		if (!field) throw new Error("missing");
		field.value = "";
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
	await submit();
	expect(create).not.toHaveBeenCalled();
});

for (const reportedCwd of ["C:\\WINDOWS\\system32", "D:\\configured-project", ""]) {
	test(`Windows reported default ${JSON.stringify(reportedCwd)} never selects a workspace`, async () => {
		remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: reportedCwd };
		await mount();
		await selectRemote();
		const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
		if (!field) throw new Error("Windows directory field missing");
		expect(field.value).toBe("");
		expect(field.getAttribute("placeholder")).toBeNull();
		expect(field.getAttribute("data-directory-hint")).toBe("remoteWorkingDirectoryHint");
		await submit();
		expect(create).not.toHaveBeenCalled();
	});
}

test("Windows manual project selection survives late local settings and submits only the chosen target", async () => {
	remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: "C:\\WINDOWS\\system32" };
	await mount();
	await selectRemote();
	await act(async () => {
		const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
		if (!field) throw new Error("Windows directory field missing");
		field.value = "D:\\projects\\实际项目";
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
		settingsResolve?.({ paths: { defaultProjectDir: "/host/default" } });
		await flush();
	});
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "D:\\projects\\实际项目",
	});
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
});

test("an explicit Windows entry-point directory is preserved even when its device is selected again", async () => {
	remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: "C:\\WINDOWS\\system32" };
	await mount("D:\\chosen-project", "remote");
	await selectRemote();
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "D:\\chosen-project",
	});
});

test("Linux remote default directory retains its existing prefill behavior", async () => {
	await mount();
	await selectRemote();
	const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
	expect(field?.value).toBe("/device-default");
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "/device-default",
	});
});

test("reopening a mounted local modal as Windows never borrows same-frame host cwd prefill", async () => {
	remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: "" };
	await mount();
	await act(async () => {
		settingsResolve?.({ paths: { defaultProjectDir: "/host/default" } });
		await flush();
	});
	const localField = container.querySelector<HTMLInputElement>('[data-directory-device="local"]');
	if (!localField) throw new Error("local directory field missing");
	expect(localField.value).toBe("/host/default");
	await act(async () => {
		localField.value = "";
		localField.dispatchEvent(new window.Event("input", { bubbles: true }));
		await flush();
	});
	await mount(undefined, "remote", false);
	await mount(undefined, "remote");
	const remoteField = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
	if (!remoteField) throw new Error("Windows directory field missing after reopening");
	expect(remoteField.value).toBe("");
	await submit();
	expect(create).not.toHaveBeenCalled();
});

test("reopening as local resets the previous Windows selection before local defaults arrive", async () => {
	remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: "" };
	await mount("D:\\previous-project", "remote");
	await mount(undefined, "local", false);
	await mount(undefined, "local");
	let field = container.querySelector<HTMLInputElement>('[data-directory-device="local"]');
	expect(field?.value).toBe("");
	await act(async () => {
		settingsResolve?.({ paths: { defaultProjectDir: "/host/current-project" } });
		await flush();
	});
	field = container.querySelector<HTMLInputElement>('[data-directory-device="local"]');
	expect(field?.value).toBe("/host/current-project");
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "local",
		cwd: "/host/current-project",
	});
});

test("reopening an existing Windows modal adopts the new explicit entry-point directory", async () => {
	remoteDevice = { ...remoteDevice, platformOs: "windows", defaultCwd: "C:\\WINDOWS\\system32" };
	await mount("D:\\previous-project", "remote");
	await mount(undefined, "remote", false);
	await mount("E:\\new-explicit-project", "remote");
	await act(async () => {
		settingsResolve?.({ paths: { defaultProjectDir: "/host/default" } });
		await flush();
	});
	const field = container.querySelector<HTMLInputElement>('[data-directory-device="remote"]');
	expect(field?.value).toBe("E:\\new-explicit-project");
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "E:\\new-explicit-project",
	});
});
