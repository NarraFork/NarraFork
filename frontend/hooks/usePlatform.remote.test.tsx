import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: { id: "n", cwd: "/repo" } }) }));
mock.module("./useWorkspaceContext", () => ({ useWorkspaceContext: () => ({ data: undefined }) }));
const requests = mock(async () => new Response("{}"));
mock.module("@frontend/lib/business-transport", () => ({
	businessTransport: { request: requests },
}));
const addListener = mock(() => ({ _id: 1 }));
const onConnectionChange = mock(() => () => {});
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener,
		onConnectionChange,
		removeListener: () => {},
		send: () => true,
	},
}));
const platform = await import("./usePlatform");
const { useNarratorTerminals } = await import("./useTerminals");
const { useGitWorkspace, useGitStatus, useGitBadgeRefresh } = await import("./useGit");
const { useChatUnread, useNarratorChatRoom, useChatUnreadLive, useChatRoomLive } = await import(
	"./useChat"
);
const { useOutlineEnabled, useOutlineEnabledInCache } = await import("./useOutlineEnabled");
const { useOutlineSpaces, useOutlineQuestionGroups, useOutlineQuestionsLive } = await import(
	"./useOutline"
);
const { useDeepSeekBalance } = await import("./useDeepSeekBalance");
const { useOpencodeUsage } = await import("./useOpencodeUsage");
const { useProviderBalance } = await import("./useProviderBalance");
const { useTokenDanceBalance } = await import("./useTokenDanceBalance");
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let client: QueryClient;
let container: HTMLElement;
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	// Old normal-build preference caches must not turn unsupported features back on.
	client.setQueryData(["settings"], { outline: { enabled: true } });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	requests.mockClear();
	addListener.mockClear();
	onConnectionChange.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
function Probe() {
	useNarratorTerminals("n");
	useGitWorkspace("n");
	useGitStatus({ narratorId: "n", workspaceKey: "repo", canWrite: true });
	useGitBadgeRefresh();
	useChatUnread(true);
	useNarratorChatRoom("n", true);
	useChatUnreadLive();
	useChatRoomLive("room");
	useOutlineSpaces(true);
	useOutlineQuestionGroups(["block"]);
	useOutlineQuestionsLive([]);
	useDeepSeekBalance("provider", "generation", true);
	useOpencodeUsage("provider", "generation", true);
	useProviderBalance("provider", "generation", true);
	useTokenDanceBalance(1, true);
	const outline = useOutlineEnabled();
	const cachedOutline = useOutlineEnabledInCache();
	return (
		<span>
			{String(outline.enabled)}:{String(cachedOutline)}
		</span>
	);
}
test("unsupported mounted hooks issue no queries or websocket subscriptions even with cached feature settings", async () => {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
	});
	expect(container.textContent).toBe("false:false");
	expect(requests).not.toHaveBeenCalled();
	expect(addListener).not.toHaveBeenCalled();
	expect(onConnectionChange).not.toHaveBeenCalled();
	await act(async () => {
		await client.invalidateQueries();
	});
	expect(requests).not.toHaveBeenCalled();
});
test("filesystem, terminal, browser, share and quota capabilities fail closed while all approval kinds remain enabled", () => {
	expect(platform.useFileSystemCapability().preview.supported).toBe(false);
	expect(platform.useTerminalCapability().supported).toBe(false);
	expect(platform.useNarratorBrowserSessionsCapability().supported).toBe(false);
	expect(platform.useShareCapability().previewSupported).toBe(false);
	expect(platform.useProviderQuotaCapability("openai").supported).toBe(false);
	const permissions = platform.useNarratorPermissionsCapability();
	expect(permissions.supported).toBe(true);
	expect(permissions.approveDeny).toBe(true);
	expect(permissions.reflections).toEqual(["danger", "plan", "question", "goal"]);
	expect(platform.useNarratorPlanModeCapability().supported).toBe(true);
	expect(platform.useNarratorRetryRecoveryCapability().supported).toBe(true);
});
