import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";
import type { UseNarratorSendOptions, UseNarratorSendResult } from "./use-narrator-send";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const transportRequests = mock(async () => {
	throw new Error("unbridged request");
});
mock.module("@frontend/lib/business-transport", () => ({
	businessTransport: { request: transportRequests },
}));
mock.module("../../../lib/narrator-ws-manager", () => ({ narratorWSManager: { checkSync() {} } }));
const { api } = await import("../../../lib/api");
const { useNarratorSend } = await import("./use-narrator-send");
let root: Root;
let actions: UseNarratorSendResult;
let options: UseNarratorSendOptions;
let text: string;
let send: ReturnType<typeof spyOn<typeof api, "sendNarratorMessage">>;
let notify: ReturnType<typeof spyOn<typeof notifications, "show">>;
const globals = new Map<string, PropertyDescriptor | undefined>();
function Probe() {
	actions = useNarratorSend(options);
	return null;
}
beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	text = "hello";
	transportRequests.mockClear();
	send = spyOn(api, "sendNarratorMessage").mockResolvedValue({});
	notify = spyOn(notifications, "show").mockReturnValue("notification");
	const composer = {
		getText: () => text,
		getDocument: () => undefined,
		getFileReferences: () => [],
		hasMissingAssets: () => false,
		hideTextForSend: mock(() => {}),
		commitDraftAfterSend: mock(() => {}),
		noteSent: mock(() => {}),
		getTextAndFileReferences: () => ({ text, fileReferences: [] }),
	} as unknown as NarratorComposerHandle;
	options = {
		narratorId: "n",
		composerRef: { current: composer },
		attachedImages: [],
		attachedTextFiles: [],
		clearAttachedFilesAndDraft: mock(() => {}),
		sendingRef: { current: false },
		setQueuedMessages: mock(() => {}),
		reconcileBufferedMessages: mock(() => {}),
		scrollToBottom: mock(() => {}),
		isActive: false,
		isSubagent: false,
		isTakenOver: false,
		showCompactQueueChoice: false,
		canRetryLastUserMessage: false,
		canContinueNarrator: false,
		fetchedNarrator: null,
		narrator: null,
		currentUser: null,
		enterQueueMode: "turn",
		ctrlEnterQueueMode: "tool",
		createNarrator: { mutateAsync: mock(async () => ({ id: "created" })) },
		interruptNarrator: { mutateAsync: mock(async () => ({ settled: true })) },
		registerSubmitToNarrator: undefined,
		setNarratorWorking: mock(() => {}),
		navigateToNarrator: mock(() => {}),
		normalizeBooleanOverride: () => "inherit",
		normalizeDangerReflectionOverride: () => "inherit",
		t: ((key: string) => key) as TFunction<"narrator">,
	};
});
afterEach(async () => {
	await act(async () => root.unmount());
	send.mockRestore();
	notify.mockRestore();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
async function submit() {
	await act(async () => root.render(<Probe />));
	await act(async () => actions.handleSend());
}
test("the aggregate multipart budget rejects two individually small files before send and preserves the draft", async () => {
	options.attachedImages = [
		new File([new Uint8Array(4 * 1024 * 1024)], "a.png"),
		new File([new Uint8Array(4 * 1024 * 1024)], "b.png"),
	];
	await submit();
	expect(send).not.toHaveBeenCalled();
	expect(transportRequests).not.toHaveBeenCalled();
	expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
	expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	expect(notify.mock.calls.at(-1)?.[0].message).toBe("remote:attachmentTooLarge");
});
test("the request budget counts UTF-8 bytes, not characters", async () => {
	options.attachedTextFiles = [new File([new Uint8Array(7 * 1024 * 1024 - 200)], "log.txt")];
	text = "界".repeat(100);
	await submit();
	expect(send).not.toHaveBeenCalled();
	expect(notify.mock.calls.at(-1)?.[0].message).toBe("remote:attachmentTooLarge");
});
test("a small attachment still uses the existing send path", async () => {
	options.attachedImages = [new File(["image"], "a.png", { type: "image/png" })];
	await submit();
	expect(send).toHaveBeenCalledTimes(1);
	expect(options.composerRef.current?.hideTextForSend).toHaveBeenCalledTimes(1);
});
test.each([
	"/new",
	"/fork",
	"/save_dump",
	"/modeltrace test",
])("%s does not enter an unbridged client control path", async (command) => {
	text = command;
	await submit();
	expect(send).not.toHaveBeenCalled();
	expect(transportRequests).not.toHaveBeenCalled();
	expect(options.createNarrator.mutateAsync).not.toHaveBeenCalled();
	expect(notify.mock.calls.at(-1)?.[0].message).toBe("remote:unsupported");
});
test.each([
	"/new",
	"/fork",
	"/save_dump",
	"/modeltrace",
])("forwarded %s cannot bypass the unsupported control gate", async (command) => {
	await act(async () => root.render(<Probe />));
	await act(async () => actions.forwardTextToNarrator(command));
	expect(send).not.toHaveBeenCalled();
	expect(transportRequests).not.toHaveBeenCalled();
	expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
	expect(notify.mock.calls.at(-1)?.[0].message).toBe("remote:unsupported");
});
