import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import type { ComposerDocument } from "@shared/composer-document";
import { parseHTML } from "linkedom";
import { act, type ComponentProps, type ReactNode, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../lib/api";
import { composerAssetsFromFiles } from "../narrator/composer/composer-document-adapter";
import { loadDraftImageAttachments } from "../narrator/composer/draft-image-attachments";
import type {
	NarratorComposer,
	NarratorComposerHandle,
} from "../narrator/composer/NarratorComposer";

// Keep the real ingestion, attachment persistence, document snapshot, and API call
// boundary. Only external navigation/settings and the editor/UI shell are replaced.
const modules = [
	"@mantine/core",
	"@tanstack/react-query",
	"@tanstack/react-router",
	"react-i18next",
	"../../hooks/useAuth",
	"../../hooks/useNarrator",
	"../../hooks/usePlatform",
	"../../hooks/useProjectDirStatus",
	"../../hooks/useRecentTabs",
	"../common/DirectoryPicker",
	"../narrator/CreateNarratorLazyModal",
	"../narrator/composer/NarratorComposer",
	"../narrator/interaction/PermissionModePickerMenu",
	"../narrator/interaction/UploadProgressBar",
	"../narrator/model/ModelPickerMenu",
	"../narrator/model/ReasoningEffortPickerMenu",
	"../narrator/model/use-draft-reasoning-effort",
] as const;
const originals = new Map<string, object>();
for (const id of modules) originals.set(id, await import(id));
const replace = (id: (typeof modules)[number], exports: object) =>
	mock.module(id, () => ({ ...originals.get(id), ...exports }));
const shell = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const button = ({
	children,
	onClick,
	disabled,
}: {
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) => (
	<button type="button" disabled={disabled} onClick={onClick}>
		{children}
	</button>
);
const create = mock(async () => ({
	id: "new-session",
	title: "New",
	cwd: "/workspace",
	status: "idle",
}));
const navigate = mock(() => {});
const noteSent = mock(() => {});
const clearText = mock(() => {});
let props: ComponentProps<typeof NarratorComposer>;
let documentOverride: ComposerDocument | undefined;
let progressState: { attachmentCount: number; progress: number | null; canCancel: boolean } | null;
function documentFromProps(): ComposerDocument | undefined {
	return documentOverride;
}
replace("@mantine/core", {
	ActionIcon: button,
	Box: shell,
	Button: button,
	Group: shell,
	Text: shell,
	Tooltip: shell,
});
replace("@tanstack/react-query", {
	useQuery: () => ({
		data: { agent: { defaultPermissionMode: "default", defaultStartInPlanMode: false } },
	}),
});
replace("@tanstack/react-router", { useNavigate: () => navigate });
const translate = (key: string) => key;
replace("react-i18next", { useTranslation: () => ({ t: translate }) });
replace("../../hooks/useAuth", { useCurrentUser: () => ({ data: { id: "dashboard-user" } }) });
replace("../../hooks/useNarrator", { useCreateNarrator: () => ({ mutateAsync: create }) });
replace("../../hooks/usePlatform", {
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useNarratorPlanModeCapability: () => ({ supported: false }),
});
replace("../../hooks/useProjectDirStatus", {
	useProjectDirStatus: () => ({ usablePath: "/workspace", needsChoice: false }),
});
replace("../../hooks/useRecentTabs", { addRecentTab: async () => {} });
replace("../common/DirectoryPicker", { DirectoryBrowserModal: () => null });
replace("../narrator/CreateNarratorLazyModal", { CreateNarratorLazyModal: () => null });
replace("../narrator/interaction/PermissionModePickerMenu", {
	PermissionModePickerMenu: () => null,
});
replace("../narrator/model/ModelPickerMenu", { ModelPickerMenu: () => null });
replace("../narrator/model/ReasoningEffortPickerMenu", { ReasoningEffortPickerMenu: () => null });
replace("../narrator/model/use-draft-reasoning-effort", {
	useDraftReasoningEffort: () => ({ supported: false, options: [] }),
});
replace("../narrator/interaction/UploadProgressBar", {
	UploadProgressBar: ({ sendingState }: { sendingState: typeof progressState }) => {
		progressState = sendingState;
		return null;
	},
});
replace("../narrator/composer/NarratorComposer", {
	NarratorComposer: (next: ComponentProps<typeof NarratorComposer>) => {
		props = next;
		useImperativeHandle(
			next.ref,
			() =>
				({
					getText: () => "",
					getDocument: documentFromProps,
					getFileReferences: () => [],
					hasMissingAssets: () => false,
					captureAttachmentInsertion: () => ({ restore: () => true, cancel: () => {} }),
					insertAcceptedFiles: (files: File[]) => {
						const images = [
							...(props.attachedImages ?? []),
							...files.filter((file) => file.type.startsWith("image/")),
						];
						const media = [
							...(props.attachedMedia ?? []),
							...files.filter(
								(file) => file.type.startsWith("audio/") || file.type.startsWith("video/"),
							),
						];
						const texts = [
							...(props.attachedTextFiles ?? []),
							...files.filter((file) => file.type.startsWith("text/")),
						];
						props.onAttachmentsChange?.(images, texts, media);
						return true;
					},
					noteSent,
					clearTextAndDraft: clearText,
				}) as unknown as NarratorComposerHandle,
		);
		return <div>{next.actions}</div>;
	},
});
const { DashboardComposer, DASHBOARD_COMPOSER_KEY } = await import("./DashboardComposer");

const records = new Map<string, Record<string, unknown>>();
const globals = new Map<string, PropertyDescriptor | undefined>();
let closeDatabase: (() => void) | undefined;
let root: Root;
let host: HTMLElement;
let send: ReturnType<typeof mock<typeof api.sendNarratorMessage>>;
let notify: ReturnType<typeof spyOn<typeof notifications, "show">>;
function request<T>(result: T) {
	const pending = { result, onsuccess: undefined as (() => void) | undefined };
	queueMicrotask(() => pending.onsuccess?.());
	return pending;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}
beforeEach(async () => {
	records.clear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const database = {
		close() {},
		set onversionchange(handler: () => void) {
			closeDatabase = handler;
		},
		transaction() {
			const transaction = {
				oncomplete: undefined as (() => void) | undefined,
				objectStore: () => ({
					get: (key: string) => request(records.get(key)),
					getAll: () => request([...records.values()]),
					put(value: Record<string, unknown>) {
						records.set(String(value.draftKey), structuredClone(value));
						queueMicrotask(() => transaction.oncomplete?.());
					},
					delete(key: string) {
						records.delete(key);
						queueMicrotask(() => transaction.oncomplete?.());
					},
				}),
			};
			return transaction;
		},
	};
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: { getItem: () => null, setItem() {} },
		indexedDB: { open: () => request(database) },
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	create.mockClear();
	navigate.mockClear();
	noteSent.mockClear();
	clearText.mockClear();
	documentOverride = undefined;
	progressState = null;
	send = mock(
		async () => ({ id: "message" }) as Awaited<ReturnType<typeof api.sendNarratorMessage>>,
	);
	notify = spyOn(notifications, "show").mockImplementation(() => "notice");
	api.sendNarratorMessage = send;
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	await act(async () => {
		root.render(<DashboardComposer />);
	});
});
const originalSend = api.sendNarratorMessage;
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	await new Promise((resolve) => setTimeout(resolve, 0));
	closeDatabase?.();
	closeDatabase = undefined;
	api.sendNarratorMessage = originalSend;
	notify.mockRestore();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => {
	for (const [id, original] of originals) mock.module(id, () => original);
});
const audio = (name = "speech.wav") =>
	new File(["original dashboard audio"], name, { type: "audio/wav" });
const video = () => new File(["original dashboard video"], "clip.mp4", { type: "video/mp4" });
async function attach(files: File[]) {
	await act(async () => {
		await props.onPasteImages?.(files);
	});
}
async function submit() {
	await act(async () => {
		await props.onSendWithMode?.("turn");
	});
}

test("Dashboard stages and persists media-only drafts through the real ingestion hook", async () => {
	const speech = audio();
	const clip = video();
	await attach([speech, clip]);
	expect(props.hasAttachments).toBe(true);
	expect(props.attachedMedia).toEqual([speech, clip]);
	const draft = await loadDraftImageAttachments("dashboard-user", DASHBOARD_COMPOSER_KEY);
	expect(draft?.media?.map((file) => file.name)).toEqual([speech.name, clip.name]);
	expect(await draft?.media?.[0].text()).toBe(await speech.text());
});

test("Dashboard media-only send creates a session and sends native originals in API slot 11", async () => {
	const speech = audio();
	await attach([speech]);
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0][0]).toBe("new-session");
	expect(send.mock.calls[0][1]).toBe("");
	expect(send.mock.calls[0][11]).toEqual([speech]);
	expect(props.attachedMedia).toEqual([]);
	expect(clearText).toHaveBeenCalledTimes(1);
	expect(navigate).toHaveBeenCalledTimes(1);
});

test("Dashboard snapshots media in manifest order and includes it in upload progress", async () => {
	const speech = audio();
	const clip = video();
	await attach([speech, clip]);
	const assets = composerAssetsFromFiles([], [], [clip, speech]);
	documentOverride = {
		version: 1,
		assets,
		paragraphs: [
			{
				children: assets.map((asset) => ({
					type: "attachment",
					id: `node-${asset.id}`,
					assetId: asset.id,
				})),
			},
		],
	};
	const pending = deferred<Awaited<ReturnType<typeof api.sendNarratorMessage>>>();
	send.mockImplementation(() => pending.promise);
	let submitted: Promise<void> = Promise.resolve();
	await act(async () => {
		submitted = props.onSendWithMode?.("turn") as Promise<void>;
	});
	expect(send.mock.calls[0][11]).toEqual([clip, speech]);
	expect(send.mock.calls[0][10]).toEqual({ composerDocument: documentOverride });
	expect(progressState).toMatchObject({ attachmentCount: 2, progress: 0, canCancel: true });
	await act(async () => {
		pending.resolve({ id: "message" } as Awaited<ReturnType<typeof api.sendNarratorMessage>>);
		await submitted;
	});
	expect(noteSent).toHaveBeenCalledTimes(1);
});

test("Dashboard failed upload keeps originals and reuses the created session on retry", async () => {
	const speech = audio();
	await attach([speech]);
	send.mockRejectedValueOnce(new Error("upload failed"));
	await submit();
	expect(props.attachedMedia).toEqual([speech]);
	expect(clearText).not.toHaveBeenCalled();
	expect(navigate).not.toHaveBeenCalled();
	expect(
		await (
			await loadDraftImageAttachments("dashboard-user", DASHBOARD_COMPOSER_KEY)
		)?.media?.[0].text(),
	).toBe(await speech.text());
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	expect(send).toHaveBeenCalledTimes(2);
	expect(send.mock.calls[1][11]).toEqual([speech]);
});
