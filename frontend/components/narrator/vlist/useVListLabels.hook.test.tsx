import { describe, expect, it, spyOn } from "bun:test";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "../../../locales/en/common.json";
import enNarrator from "../../../locales/en/narrator.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { getSummary } from "../tool-call/tool-display";
import { useVListLabels, type VListLabels } from "./useVListLabels";

const SUMMARY_KEYS = [
	"communicationRunning",
	"communicationNoRecipients",
	"communicationSuccess",
	"communicationReceived",
	"communicationWaiting",
	"communicationReplyReceived",
	"communicationTimeout",
	"communicationCancelled",
	"communicationError",
	"contextAskOutputChars",
	"contextAskQuestions",
	"contextAskStatusSummary",
	"workspaceCreate",
	"workspaceList",
	"workspaceSwitch",
	"workspaceDevice",
] as const;

async function withLabels(
	check: (test: {
		labels: () => VListLabels;
		rerender: () => Promise<void>;
		i18n: ReturnType<typeof i18next.createInstance>;
	}) => Promise<void>,
) {
	const i18n = i18next.createInstance();
	await i18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		ns: ["narrator", "common"],
		resources: {
			en: { narrator: enNarrator, common: enCommon },
			"zh-CN": { narrator: zhNarrator, common: zhCommon },
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let current: VListLabels | undefined;
	function Harness() {
		current = useVListLabels();
		return null;
	}
	const rerender = async () => {
		await act(async () => {
			root.render(
				<I18nextProvider i18n={i18n}>
					<Harness />
				</I18nextProvider>,
			);
		});
	};
	try {
		await rerender();
		await check({
			labels: () => {
				if (!current) throw new Error("labels hook did not render");
				return current;
			},
			rerender,
			i18n,
		});
	} finally {
		await act(async () => root.unmount());
		container.remove();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("useVListLabels summary labels", () => {
	it("covers every summary fragment, preserving placeholders and language updates", async () => {
		await withLabels(async ({ labels, i18n }) => {
			const initial = labels().adapterLabels;
			for (const language of ["en", "zh-CN"]) {
				await act(async () => {
					await i18n.changeLanguage(language);
				});
				const bundle = labels().adapterLabels;
				for (const key of SUMMARY_KEYS) {
					expect(bundle[key]).toBe(i18n.t(key, { count: "{count}" }));
				}
				expect(bundle.contextAskOutputChars).toContain("{count}");
				expect(bundle.contextAskQuestions).toContain("{count}");
			}
			expect(labels().adapterLabels).not.toBe(initial);
			expect(
				getSummary(
					"ContextAsk",
					{ id: "worker", questions: ["one", "two"] },
					undefined,
					labels().adapterLabels,
				),
			).toBe("worker · 2 个问题");
			expect(getSummary("ContextAsk", { id: "worker" }, undefined, labels().adapterLabels)).toBe(
				"worker · 状态摘要",
			);
			expect(
				getSummary(
					"ContextAsk",
					{ id: "worker" },
					{ _streamingOutput: "1240" },
					labels().adapterLabels,
				),
			).toBe("worker · 1240 字符");
			expect(getSummary("Worktree", { action: "list" }, undefined, labels().adapterLabels)).toBe(
				zhNarrator.workspaceList,
			);
		});
	});

	it("reuses translations across renders and summaries without freezing live metadata", async () => {
		await withLabels(async ({ labels, rerender, i18n }) => {
			const initial = labels();
			const translations = spyOn(i18n, "t");
			const input = { id: "parent", await: false };
			const target = { id: "parent", status: "queued", injectionConsumedAt: "" };
			const metadata = { _sendDeliveryTargets: [target] };
			try {
				for (let frame = 0; frame < 12; frame++) {
					await rerender();
					expect(labels().adapterLabels).toBe(initial.adapterLabels);
					expect(labels().renderLabels).toBe(initial.renderLabels);
					for (let call = 0; call < 64; call++) {
						expect(getSummary("Send", input, metadata, labels().adapterLabels)).toBe(
							"to parent · Sent",
						);
					}
				}
				expect(translations).not.toHaveBeenCalled();
				target.injectionConsumedAt = "2026-10-07T00:00:00Z";
				expect(getSummary("Send", input, metadata, labels().adapterLabels)).toBe(
					"to parent · Received",
				);
				await act(async () => {
					await i18n.changeLanguage("zh-CN");
				});
				expect(translations).toHaveBeenCalled();
				expect(labels().adapterLabels).not.toBe(initial.adapterLabels);
				expect(getSummary("Send", input, metadata, labels().adapterLabels)).toBe(
					"to parent · 已收到",
				);
				translations.mockClear();
				await rerender();
				expect(getSummary("Send", input, undefined, labels().adapterLabels)).toBe(
					"to parent · 发送中",
				);
				expect(translations).not.toHaveBeenCalled();
			} finally {
				translations.mockRestore();
			}
		});
	});
});
