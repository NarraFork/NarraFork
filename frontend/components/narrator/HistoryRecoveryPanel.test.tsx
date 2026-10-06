import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

beforeAll(() => {
	(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../lib/api";
import type { HistoryRecoveryResult } from "../../lib/api/types";
import { HistoryRecoveryPanel } from "./HistoryRecoveryPanel";

const i18n = i18next.createInstance();
await i18n.init({
	lng: "en",
	resources: {
		en: {
			narrator: {
				"historyRecovery.title": "History too large to display",
				"historyRecovery.description": "Delete oversized message",
				"historyRecovery.candidateTitle":
					"seq {{seq}} · {{role}} · {{toolCount}} tool calls · {{size}}",
				"historyRecovery.latest": "latest",
				"historyRecovery.skipRevert": "Keep workspace files as-is",
				"historyRecovery.skipRevertDesc": "Only remove the message",
				"historyRecovery.delete": "Delete selected message and after",
				"historyRecovery.deleteFailed": "Delete failed",
				"historyRecovery.scanFailed": "Could not list",
				"historyRecovery.noCandidates": "No oversized messages",
				"historyRecovery.retryLoad": "Retry loading history",
			},
			common: {},
		},
	},
	react: { useSuspense: false },
});

let root: Root;
let container: HTMLElement;
let getHistoryRecovery: ReturnType<typeof spyOn<typeof api, "getHistoryRecovery">>;
let deleteMessage: ReturnType<typeof spyOn<typeof api, "deleteMessage">>;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const doc = window.document;
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.window = window;
	globals.document = doc;
	globals.HTMLElement = window.HTMLElement;
	globals.Element = window.Element;
	globals.Node = window.Node;
	globals.requestAnimationFrame = (cb: FrameRequestCallback) =>
		setTimeout(() => cb(0), 0) as unknown as number;
	globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
	container = doc.createElement("div");
	doc.body.appendChild(container);
	root = createRoot(container);
	getHistoryRecovery = spyOn(api, "getHistoryRecovery");
	deleteMessage = spyOn(api, "deleteMessage");
});

afterEach(async () => {
	try {
		await act(async () => root.unmount());
	} catch {
		// Mantine transition cleanup can race linkedom teardown; the assertions already ran.
	}
	container.remove();
});

function renderPanel(
	loadError: unknown,
	onRecovered: () => void = () => {},
	seed?: HistoryRecoveryResult,
) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (seed) qc.setQueryData(["narrators", "n", "history-recovery"], seed);
	return act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={qc}>
					<MantineProvider>
						<HistoryRecoveryPanel narratorId="n" loadError={loadError} onRecovered={onRecovered} />
					</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
}

describe("HistoryRecoveryPanel", () => {
	test("is hidden when the load error is not the aggregate budget", async () => {
		getHistoryRecovery.mockResolvedValue({
			candidates: [],
			thresholds: { toolCount: 32, byteSize: 1024 * 1024 },
		});
		await renderPanel(new Error("boom"));
		// Mantine injects style tags into the container; assert on visible copy only.
		expect(container.textContent ?? "").not.toContain("History too large");
		expect(getHistoryRecovery).not.toHaveBeenCalled();
	});

	test("lists oversized candidates and offers delete", async () => {
		getHistoryRecovery.mockResolvedValue({
			candidates: [],
			thresholds: { toolCount: 32, byteSize: 1024 * 1024 },
		});
		deleteMessage.mockResolvedValue({ ok: true, deletedCount: 1 });
		const loadError = Object.assign(new Error("History aggregation exceeds"), {
			data: { code: "HISTORY_AGGREGATE_UNAVAILABLE" },
		});
		await renderPanel(loadError, () => {}, {
			candidates: [
				{
					messageId: "m1",
					seq: 33,
					role: "assistant",
					createdAt: "2026-09-22T02:25:50.756Z",
					toolCount: 711,
					byteSize: 263_784,
					preview: "long message",
					latest: true,
				},
			],
			thresholds: { toolCount: 32, byteSize: 1024 * 1024 },
		});
		// Seeded cache paints immediately; a background refetch is fine.
		expect(container.textContent).toContain("711");
		expect(container.textContent).toContain("latest");
		expect(container.textContent).toContain("Delete selected message and after");
	});
});
