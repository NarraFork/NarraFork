import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InstallScriptResult, RemoteDevice } from "../../lib/api/devices";

const realMantine = { ...(await import("@mantine/core")) };
const realApi = { ...(await import("../../lib/api")) };
const realI18n = { ...(await import("react-i18next")) };
const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	...realMantine,
	Alert: Box,
	Code: Box,
	Group: Box,
	Stack: Box,
	Text: Box,
	Divider: Box,
	Loader: Box,
	Modal: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
		opened ? <div>{children}</div> : null,
	Collapse: ({ expanded, children }: { expanded: boolean; children: ReactNode }) =>
		expanded ? <div>{children}</div> : null,
	Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
		<button type="button" onClick={onClick}>
			{children}
		</button>
	),
	TextInput: ({
		label,
		value,
		onChange,
	}: {
		label: string;
		value: string;
		onChange: (event: unknown) => void;
	}) => (
		<label>
			{label}
			<input value={value} onInput={onChange} readOnly />
		</label>
	),
	Checkbox: Box,
	Select: ({
		label,
		data,
		onChange,
	}: {
		label: string;
		data: { value: string; label: string; disabled?: boolean }[];
		onChange: (value: string) => void;
	}) => (
		<div>
			{label}
			{data.map((item) => (
				<button
					type="button"
					key={item.value}
					disabled={item.disabled}
					onClick={() => onChange(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	),
	SegmentedControl: ({
		data,
		onChange,
	}: {
		data: { value: string; label: string; disabled?: boolean }[];
		onChange: (value: string) => void;
	}) => (
		<div>
			{data.map((item) => (
				<button
					type="button"
					key={item.value}
					disabled={item.disabled}
					onClick={() => onChange(item.value)}
				>
					{item.label}
				</button>
			))}
		</div>
	),
}));
mock.module("react-i18next", () => ({
	...realI18n,
	useTranslation: () => ({
		t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
	}),
}));
let calls: string[] = [];
let requests: { id: string; url: string; resolve: (value: InstallScriptResult) => void }[] = [];
let copiedCommands: string[] = [];
let rotations = 0;
let diagnosticsCalls = 0;
let deliveries: string[] = [];
let rejectEnrollment = false;
let publishedPlatforms = ["linux-amd64", "windows-amd64"];

let resolveLinux: ((value: InstallScriptResult) => void) | undefined;
const generated = (target: string, expiresAt = new Date(Date.now() + 60000).toISOString()) =>
	({
		oneLiner: `install-${target}`,
		script: "script",
		expiresAt,
		target,
		platforms: target === "unix" ? ["linux-amd64"] : ["windows-amd64"],
		tokenDelivery: "enroll",
		shell: "sh",
	}) as InstallScriptResult;
mock.module("../../lib/api", () => ({
	...realApi,
	api: {
		...realApi.api,
		getExecutorManifest: async () => ({
			manifest: {
				version: "1",
				platforms: Object.fromEntries(publishedPlatforms.map((platform) => [platform, {}])),
			},
			platforms: [
				{ platform: "linux-amd64", os: "linux", arch: "amd64", supportsPty: true },
				{ platform: "darwin-arm64", os: "darwin", arch: "arm64", supportsPty: true },
				{ platform: "windows-amd64", os: "windows", arch: "amd64", supportsPty: true },
			],
		}),
		createInstallScript: async (
			id: string,
			input: { target: string; tokenDelivery: string; serverBaseUrl: string },
		) => {
			calls.push(input.target);
			deliveries.push(input.tokenDelivery);
			if (rejectEnrollment && input.tokenDelivery === "enroll") {
				throw new Error("Plaintext private-network enrollment is disabled");
			}
			if (input.target === "unix")
				return new Promise<InstallScriptResult>((resolve) => {
					resolveLinux = resolve;
					requests.push({ id, url: input.serverBaseUrl, resolve });
				});
			return { ...generated(input.target), tokenDelivery: input.tokenDelivery };
		},
		getDeviceDiagnostics: async () => {
			diagnosticsCalls++;
			return { online: true, stage: "ready" };
		},
		rotateDeviceToken: async () => {
			rotations++;
			return { token: "key" };
		},
	},
}));
const { ExecutorInstallModal } = await import("./ExecutorInstallModal");
let root: Root | undefined;
let container: HTMLElement;
let client: QueryClient;
const device = { id: "device", name: "Device" } as RemoteDevice;
async function settle(ms = 20) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
async function setup(
	url = "https://server.example",
	refuseEnrollment = false,
	platforms = ["linux-amd64", "windows-amd64"],
	selectedDevice = device,
) {
	publishedPlatforms = platforms;
	rejectEnrollment = refuseEnrollment;
	calls = [];
	requests = [];
	copiedCommands = [];
	rotations = 0;
	diagnosticsCalls = 0;
	deliveries = [];
	resolveLinux = undefined;
	const { window } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: {
			writeText: async (value: string) => {
				copiedCommands.push(value);
			},
		},
		configurable: true,
	});
	Object.defineProperty(window, "localStorage", {
		value: { getItem: () => url, setItem: () => {} },
		configurable: true,
	});
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ExecutorInstallModal device={selectedDevice} onClose={() => {}} />
			</QueryClientProvider>,
		),
	);
	await settle(450);
	await settle();
}
async function click(text: string) {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	expect(button).toBeDefined();
	await act(async () => button?.dispatchEvent(new window.Event("click", { bubbles: true })));
	await settle();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	container?.remove();
});
afterAll(() => mock.restore());

test("automatically generates, ignores stale results and reuses configuration without rotating keys", async () => {
	await setup();
	expect(calls).toEqual(["unix"]);
	await click("Windows");
	expect(container.textContent).toContain("install-windows");
	expect(container.textContent).not.toContain("amd64");
	const displayed = container.textContent ?? "";
	expect(displayed.indexOf("executorInstallCopyCommand")).toBeLessThan(
		displayed.indexOf("Advanced options"),
	);
	expect(displayed.indexOf("executorInstallCopyCommand")).toBeLessThan(
		displayed.indexOf("This does not confirm"),
	);
	await act(async () => resolveLinux?.(generated("unix")));
	expect(container.textContent).not.toContain("install-unix");
	await click("Linux / macOS");
	expect(container.textContent).toContain("install-unix");
	expect(calls).toHaveLength(2);
	expect(rotations).toBe(0);
	expect(container.textContent).toContain("This does not confirm this installation");
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ExecutorInstallModal device={null} onClose={() => {}} />
			</QueryClientProvider>,
		),
	);
	expect(container.textContent).toBe("");
});

test("a reported Windows device defaults to Windows without an architecture selector", async () => {
	await setup("https://server.example", false, undefined, { ...device, platformOs: "windows" });
	expect(calls).toEqual(["windows"]);
	await click("Advanced options");
	expect(container.textContent).not.toContain("Architecture");
	expect(container.textContent).not.toContain("amd64");
	expect(container.textContent).toContain("executorInstallNoPty");
});

test("a macOS-only release enables Unix but not Windows", async () => {
	await setup("https://server.example", false, ["darwin-arm64"]);
	expect(calls).toEqual(["unix"]);
	const windows = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Windows",
	);
	expect(windows?.disabled).toBe(true);
	expect(container.textContent).not.toContain("arm64");
});

test("a Windows-only release cannot generate a Unix command", async () => {
	await setup("https://server.example", false, ["windows-amd64"]);
	expect(calls).toEqual(["windows"]);
	const unix = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Linux / macOS",
	);
	expect(unix?.disabled).toBe(true);
});

test("loopback and invalid URLs never issue an automatic ticket", async () => {
	await setup("http://localhost:7779");
	expect(calls).toHaveLength(0);
	expect(container.querySelector("input")).not.toBeNull();
});

test("expired cached commands require explicit refresh", async () => {
	await setup();
	await act(async () => resolveLinux?.(generated("unix", "2000-01-01T00:00:00Z")));
	await settle();
	expect(container.textContent).toContain("This command has expired");
	await click("Windows");
	await click("Linux / macOS");
	expect(calls).toHaveLength(2);
	await click("Get a new command");
	expect(calls).toHaveLength(3);
});

test("a displayed command becomes expired without automatically issuing another ticket", async () => {
	await setup();
	await act(async () =>
		resolveLinux?.(generated("unix", new Date(Date.now() + 100).toISOString())),
	);
	expect(container.textContent).toContain("install-unix");
	await settle(1200);
	expect(container.textContent).toContain("This command has expired");
	expect(container.textContent).not.toContain("install-unix");
	expect(calls).toHaveLength(1);
	await click("Get a new command");
	expect(calls).toHaveLength(2);
});

async function inputUrl(value: string) {
	const input = container.querySelector("input");
	expect(input).not.toBeNull();
	await act(async () => {
		if (!input) return;
		input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

test("invalid URL correction is debounced and public HTTP selects manual delivery", async () => {
	await setup("not-a-url");
	await click("Advanced options");
	expect(calls).toHaveLength(0);
	await inputUrl("https://first.example");
	await settle(100);
	await inputUrl("http://public.example");
	await settle(100);
	expect(calls).toHaveLength(0);
	await settle(450);
	expect(calls).toHaveLength(1);
	expect(deliveries).toEqual(["prompt"]);
	expect(rotations).toBe(0);
	await click("Windows");
	expect(rotations).toBe(0);
	await click("executorInstallRevealKey");
	expect(rotations).toBe(1);
	expect(container.textContent).toContain("key");
});

test("private HTTP enrollment refusal offers manual delivery without rotating keys", async () => {
	await setup("http://192.168.1.10:7779", true);
	expect(container.textContent).toContain("Plaintext private-network enrollment is disabled");
	await click("executorInstallTokenDeliveryManual");
	expect(deliveries).toEqual(["enroll", "prompt"]);
	await act(async () => resolveLinux?.({ ...generated("unix"), tokenDelivery: "prompt" }));
	expect(container.textContent).toContain("executorInstallTokenReminder");
	expect(rotations).toBe(0);
});

test("advanced options allow explicitly choosing manual delivery", async () => {
	await setup("http://192.168.1.10:7779");
	await click("Advanced options");
	await click("executorInstallTokenDeliveryManual");
	expect(deliveries).toEqual(["enroll", "prompt"]);
	expect(rotations).toBe(0);
});

test("loopback installation requires confirmation again after URL or device changes", async () => {
	await setup("http://localhost:7779");
	expect(calls).toHaveLength(0);
	await click("executorInstallConfirmLocalHost");
	expect(calls).toHaveLength(1);
	await inputUrl("http://127.0.0.1:7779");
	await settle(450);
	expect(calls).toHaveLength(1);
	await inputUrl("http://localhost:7779");
	await settle(450);
	expect(calls).toHaveLength(1);
	await click("executorInstallConfirmLocalHost");
	// The original URL's cached command may be reused, but only after confirmation.
	expect(calls).toHaveLength(1);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ExecutorInstallModal device={{ ...device, id: "other-device" }} onClose={() => {}} />
			</QueryClientProvider>,
		),
	);
	await settle(450);
	expect(calls).toHaveLength(1);
	await click("executorInstallConfirmLocalHost");
	expect(calls).toHaveLength(2);
});

test("a valid unexpired command can be explicitly refreshed without rotating keys", async () => {
	await setup();
	await act(async () => resolveLinux?.(generated("unix")));
	expect(container.textContent).toContain("install-unix");
	await click("Get a new command");
	expect(calls).toHaveLength(2);
	await act(async () => resolveLinux?.({ ...generated("unix"), oneLiner: "fresh-command" }));
	expect(container.textContent).toContain("fresh-command");
	expect(container.textContent).not.toContain("install-unix");
	expect(rotations).toBe(0);
});

test("URL edits immediately remove old commands and only the current URL can be copied", async () => {
	await setup("http://172.30.8.150:7779");
	await act(async () =>
		requests[0].resolve({ ...generated("unix"), oneLiner: "old-172.30.8.150" }),
	);
	await click("Advanced options");
	await click("executorInstallCopyCommand");
	expect(copiedCommands).toEqual(["old-172.30.8.150"]);
	await inputUrl("http://172.30.23.61:7779");
	expect(container.textContent).not.toContain("old-172.30.8.150");
	expect(container.textContent).not.toContain("executorInstallCopyCommand");
	await settle(450);
	expect(requests[1].url).toBe("http://172.30.23.61:7779");
	await inputUrl("http://172.30.23.62:7779");
	await settle(450);
	await act(async () =>
		requests[2].resolve({ ...generated("unix"), oneLiner: "current-172.30.23.62" }),
	);
	await act(async () =>
		requests[1].resolve({ ...generated("unix"), oneLiner: "late-172.30.23.61" }),
	);
	expect(container.textContent).toContain("current-172.30.23.62");
	expect(container.textContent).not.toContain("late-172.30.23.61");
	await click("executorInstallCopyCommand");
	expect(copiedCommands).toEqual(["old-172.30.8.150", "current-172.30.23.62"]);
});

test("switching devices hides old output and ignores its late responses", async () => {
	await setup();
	await act(async () => requests[0].resolve({ ...generated("unix"), oneLiner: "old-device" }));
	await click("Get a new command");
	const oldRequest = requests[1];
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ExecutorInstallModal device={{ ...device, id: "other-device" }} onClose={() => {}} />
			</QueryClientProvider>,
		),
	);
	expect(container.textContent).not.toContain("old-device");
	expect(container.textContent).not.toContain("executorInstallCopyCommand");
	await settle(450);
	const currentRequest = requests[2];
	expect(currentRequest.id).toBe("other-device");
	await act(async () =>
		currentRequest.resolve({ ...generated("unix"), oneLiner: "current-device" }),
	);
	await act(async () => oldRequest.resolve({ ...generated("unix"), oneLiner: "late-old-device" }));
	expect(container.textContent).toContain("current-device");
	expect(container.textContent).not.toContain("late-old-device");
	await click("executorInstallCopyCommand");
	expect(copiedCommands).toEqual(["current-device"]);
});

test("closing disables the real diagnostics query polling", async () => {
	await setup();
	expect(diagnosticsCalls).toBeGreaterThan(0);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<ExecutorInstallModal device={null} onClose={() => {}} />
			</QueryClientProvider>,
		),
	);
	const before = diagnosticsCalls;
	await settle(2200);
	expect(diagnosticsCalls).toBe(before);
});
