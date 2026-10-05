import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { NarratorRestorePreview } from "@shared/narrator-backup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as i18nHooks from "react-i18next";
import * as authHooks from "../../hooks/useAuth";
import * as narratorHooks from "../../hooks/useNarrator";
import { narratorBackupsApi } from "../../lib/api/narrator-backups";

type StubProps = Record<string, unknown> & { children?: ReactNode };
const controls = new Map<string, StubProps>();
const realMantine = { ...(await import("@mantine/core")) };
const Wrap = ({ children }: StubProps) => <div>{children}</div>;
const Input = (props: StubProps) => {
	controls.set(String(props.label), props);
	return (
		<input
			aria-label={String(props.label)}
			readOnly
			value={String(props.value ?? "")}
			disabled={!!props.disabled}
		/>
	);
};
mock.module("@mantine/core", () => ({
	...realMantine,
	Modal: ({ opened, children }: StubProps) => (opened ? <div>{children}</div> : null),
	Alert: Wrap,
	Badge: Wrap,
	Group: Wrap,
	Stack: Wrap,
	Text: Wrap,
	Button: ({ children, disabled, onClick }: StubProps) => (
		<button type="button" disabled={!!disabled} onClick={onClick as () => void}>
			{children}
		</button>
	),
	TextInput: Input,
	Textarea: Input,
	FileInput: Input,
	Select: Input,
	Checkbox: Input,
	Menu: {
		...realMantine.Menu,
		Item: ({ children, onClick }: StubProps) => (
			<button type="button" onClick={onClick as () => void}>
				{children}
			</button>
		),
	},
}));
const { NarratorBackupModal } = await import("./NarratorBackupModal");
const { NarratorBackupEntry, NarratorBackupRestoreButton } = await import("./NarratorBackupEntry");
let root: Root;
let qc: QueryClient;
const originals = new Map<string, PropertyDescriptor | undefined>();
const spies: Array<{ mockRestore(): void }> = [];
const valid: NarratorRestorePreview = {
	artifactId: "owned",
	profile: "conversation-state-v1",
	narratorIds: ["deleted-session"],
	verifiedSameInstance: true,
	sameInstanceStateRestoreAllowed: true,
	crossInstanceApplySupported: false,
	productionDiskRestoreAllowed: false,
	blockers: [],
	exclusions: ["fixture exclusion"],
	manualActivationRequired: true,
};
let previewValue = valid;
let restoreCall: ReturnType<typeof spyOn<typeof narratorBackupsApi, "restore">>;
let downloadCall: ReturnType<typeof spyOn<typeof narratorBackupsApi, "download">>;

beforeEach(() => {
	controls.clear();
	previewValue = valid;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	spies.push(
		spyOn(i18nHooks, "useTranslation").mockReturnValue({
			t: (key: string) => key,
			i18n: { language: "en" },
		} as never),
	);
	spies.push(
		spyOn(narratorBackupsApi, "plan").mockResolvedValue({
			profile: "conversation-state-v1",
			narratorIds: ["source"],
			productionDiskRestoreAllowed: false,
			exclusions: ["fixture exclusion"],
		}),
	);
	spies.push(spyOn(narratorBackupsApi, "preview").mockImplementation(async () => previewValue));
	restoreCall = spyOn(narratorBackupsApi, "restore").mockResolvedValue({
		narratorIds: ["deleted-session"],
		status: "archived",
		manualActivationRequired: true,
		productionDiskRestoreAllowed: false,
	});
	downloadCall = spyOn(narratorBackupsApi, "download").mockResolvedValue(undefined);
	spies.push(restoreCall, downloadCall);
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
afterAll(() => {
	mock.module("@mantine/core", () => realMantine);
});

async function flush() {
	await act(async () => {
		await Bun.sleep(1);
	});
}
async function render(child: ReactNode) {
	await act(async () =>
		root.render(<QueryClientProvider client={qc}>{child}</QueryClientProvider>),
	);
	await flush();
}
function button(key: string): HTMLButtonElement {
	const found = [...document.querySelectorAll("button")].find((item) => item.textContent === key);
	if (!found) throw new Error(`Missing button ${key}: ${document.body.textContent}`);
	return found as HTMLButtonElement;
}
async function click(key: string) {
	await act(async () => button(key).click());
	await flush();
}
async function change(key: string, value: unknown) {
	await act(async () => (controls.get(key)?.onChange as (value: unknown) => void)(value));
	await flush();
}
async function preview() {
	await change("backup.artifact", { currentTarget: { value: "owned" } });
	await click("backup.preview");
}

describe("private backup UI wiring", () => {
	test("missing/deleted narrator restores from list-mode modal without a project, with explicit confirmation and no task start", async () => {
		await render(<NarratorBackupModal opened onClose={() => {}} />);
		expect(document.body.textContent).not.toContain("backup.export");
		await preview();
		expect(button("backup.restore").disabled).toBe(true);
		expect(restoreCall).not.toHaveBeenCalled();
		await change("backup.confirm", { currentTarget: { checked: true } });
		expect(button("backup.restore").disabled).toBe(false);
		await click("backup.restore");
		expect(restoreCall).toHaveBeenCalledWith({ artifactId: "owned", mapping: undefined });
		expect(document.body.textContent).toContain("backup.restored");
		expect(document.body.textContent).toContain("backup.boundary");
		expect(qc.getQueryCache().find({ queryKey: ["chapters"] })).toBeUndefined();
	});
	test.each([
		"Missing account/device/path mapping",
		"Missing history image bytes",
		"ID conflict",
		"Active narrator",
	])("blocked preview cannot confirm or apply: %s", async (blocker) => {
		previewValue = { ...valid, blockers: [blocker], sameInstanceStateRestoreAllowed: false };
		await render(<NarratorBackupModal opened onClose={() => {}} />);
		await preview();
		expect(document.body.textContent).toContain(blocker);
		expect(controls.get("backup.confirm")?.disabled).toBe(true);
		expect(button("backup.restore").disabled).toBe(true);
		expect(restoreCall).not.toHaveBeenCalled();
	});
	test("cross-instance mappings remain advanced dry-run only and never enable actual restore", async () => {
		previewValue = {
			...valid,
			verifiedSameInstance: false,
			sameInstanceStateRestoreAllowed: false,
		};
		await render(<NarratorBackupModal opened onClose={() => {}} />);
		await preview();
		expect(document.body.textContent).toContain("backup.advanced");
		expect(document.body.textContent).toContain("backup.crossDisabled");
		expect(button("backup.restore").disabled).toBe(true);
		await change("undefined", { currentTarget: { value: '{"devices":{"old":"new"}}' } });
		expect(document.body.textContent).not.toContain("backup.verified");
		expect(restoreCall).not.toHaveBeenCalled();
	});
	test("failed background job surfaces failure and never exposes download", async () => {
		spies.push(
			spyOn(narratorBackupsApi, "export").mockResolvedValue({
				jobId: "failed-job",
				status: "failed",
				error: "missing tree object",
			}),
		);
		spies.push(
			spyOn(narratorBackupsApi, "job").mockResolvedValue({
				jobId: "failed-job",
				status: "failed",
				error: "missing tree object",
			}),
		);
		await render(<NarratorBackupModal opened narratorId="source" onClose={() => {}} />);
		await click("backup.export");
		expect(document.body.textContent).toContain("missing tree object");
		expect(
			[...document.querySelectorAll("button")].some(
				(item) => item.textContent === "backup.download",
			),
		).toBe(false);
		expect(downloadCall).not.toHaveBeenCalled();
	});
	test("running export can be cancelled without pretending success", async () => {
		spies.push(
			spyOn(narratorBackupsApi, "export").mockResolvedValue({
				jobId: "running-job",
				status: "running",
			}),
		);
		spies.push(
			spyOn(narratorBackupsApi, "job").mockResolvedValue({
				jobId: "running-job",
				status: "running",
			}),
		);
		const cancel = spyOn(narratorBackupsApi, "cancel").mockResolvedValue({
			jobId: "running-job",
			status: "cancelled",
		});
		spies.push(cancel);
		await render(<NarratorBackupModal opened narratorId="source" onClose={() => {}} />);
		await click("backup.export");
		await click("backup.cancelJob");
		expect(cancel).toHaveBeenCalledWith("running-job");
		expect(downloadCall).not.toHaveBeenCalled();
		expect(
			[...document.querySelectorAll("button")].some(
				(item) => item.textContent === "backup.download",
			),
		).toBe(false);
	});
	test("profile choices never offer production worktree apply", async () => {
		await render(<NarratorBackupModal opened narratorId="source" onClose={() => {}} />);
		expect(controls.get("backup.profile")?.data as unknown[]).toHaveLength(2);
		await change("backup.profile", "conversation-tree-v1");
		expect(narratorBackupsApi.plan).toHaveBeenCalledWith({
			narratorIds: ["source"],
			profile: "conversation-tree-v1",
		});
		expect(document.body.textContent).toContain("backup.treeHint");
		expect(document.body.textContent).toContain("backup.boundary");
	});
	test("public-reader overflow offers no export/download; owner is eligible", async () => {
		const actor = spyOn(authHooks, "useCurrentUser").mockReturnValue({
			data: { id: "reader", role: "user" },
		} as never);
		spies.push(actor);
		spies.push(
			spyOn(narratorHooks, "useNarrator").mockReturnValue({
				data: { ownerUserId: "owner", visibility: "public", variant: "primary" },
			} as never),
		);
		await render(<NarratorBackupEntry narratorId="source" onOpen={() => {}} />);
		expect(document.body.textContent).not.toContain("backup.exportTitle");
		expect(downloadCall).not.toHaveBeenCalled();
		actor.mockReturnValue({ data: { id: "owner", role: "user" } } as never);
		await render(<NarratorBackupEntry narratorId="source" onOpen={() => {}} />);
		expect(document.body.textContent).toContain("backup.exportTitle");
	});
	test("list restore entry is available even with no existing narrator IDs", async () => {
		const get = spyOn(narratorHooks, "useNarrator").mockImplementation(() => {
			throw new Error("must not need an existing session");
		});
		spies.push(get);
		await render(<NarratorBackupRestoreButton />);
		expect(button("backup.restoreTitle")).toBeTruthy();
		expect(get).not.toHaveBeenCalled();
	});
});
