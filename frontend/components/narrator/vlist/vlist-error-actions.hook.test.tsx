import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { api } from "@frontend/lib/api";
import {
	defaultScheduler,
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

mock.module("../../../hooks/useAuth", () => ({
	useCurrentUser: () => ({ data: { role: "admin" } }),
}));
mock.module("../../../hooks/useModels", () => ({
	useAllModels: () => ({ defaultModelValue: "provider:model" }),
}));
const { useVListErrorNoticeActions } = await import("./vlist-error-actions");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { narrator: {} } }, react: { useSuspense: false } });
let root: Root;
let qc: QueryClient;
let container: HTMLElement;
let previous: Map<string, PropertyDescriptor | undefined>;
let detail: ReturnType<typeof spyOn<typeof api, "getNarrator">>;
let actions: ReturnType<typeof useVListErrorNoticeActions>;
function Host({ enabled }: { enabled?: boolean }) {
	actions = useVListErrorNoticeActions("identity", enabled);
	return null;
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, globals);
	notifyManager.setScheduler((callback) => callback());
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	detail = spyOn(api, "getNarrator").mockResolvedValue({
		id: "identity",
		model: "provider:model",
	} as Awaited<ReturnType<typeof api.getNarrator>>);
});
afterEach(() => {
	act(() => root.unmount());
	qc.clear();
	container.remove();
	detail.mockRestore();
	notifyManager.setScheduler(defaultScheduler);
	for (const [key, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function render(enabled?: boolean) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={qc}>
					<Host enabled={enabled} />
				</QueryClientProvider>
			</I18nextProvider>,
		),
	);
}
test("chat opt-out makes no narrator-detail request and exposes no narrator actions", async () => {
	await render(false);
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["narrators"] });
	});
	expect(detail).not.toHaveBeenCalled();
	expect(actions.resolve("message", "ECONNRESET")).toBeUndefined();
	expect(actions.canOfferModelTest("ECONNRESET")).toBe(false);
	expect(
		actions.canOfferProviderFix(
			"OpenAI API error 403: Image generation is not enabled for this group",
		),
	).toBe(false);
});
test("default narrator mode still fetches detail and offers model actions", async () => {
	await render();
	expect(detail).toHaveBeenCalledTimes(1);
	expect(detail.mock.calls[0]?.[0]).toBe("identity");
	expect(actions.resolve("message", "ECONNRESET")?.onTestModel).toBeDefined();
	expect(actions.canOfferModelTest("ECONNRESET")).toBe(true);
	expect(
		actions.canOfferProviderFix(
			"OpenAI API error 403: Image generation is not enabled for this group",
		),
	).toBe(true);
});
test("disabled mode stays inert with cached narrator data and a failed enabled read", async () => {
	detail.mockRejectedValue(new Error("not a narrator"));
	await render(true);
	expect(detail).toHaveBeenCalledTimes(1);
	await act(async () => {
		qc.setQueryData(["narrators", "identity"], { model: "provider:model" });
	});
	await render(false);
	detail.mockClear();
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["narrators"] });
	});
	expect(detail).not.toHaveBeenCalled();
	expect(actions.resolve("message", "ECONNRESET")).toBeUndefined();
	expect(actions.canOfferModelTest("ECONNRESET")).toBe(false);
});
