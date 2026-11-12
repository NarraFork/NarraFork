/**
 * Browser fixture for the old Dynamic Spec cards in an outline session
 * (`spec-carryover-readonly.browser.test.ts`, outline P2 PR 12a): the fork-carryover and
 * context-cleared cards through the real adapter → measure → render chain, with the buttons the
 * shell's real hook (`useSpecCarryoverActions`) wires, as a spec session gets them, as an outline
 * session does, and with none injected (every button natively disabled, the existing convention),
 * one after the other in the shell's labels of the chosen language. It
 * reports each card's measured and painted height and every button's box, state and color, and
 * which handlers ran, so the test can hold the read-only card to the same geometry.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "../../../locales/en/common.json";
import enNarrator from "../../../locales/en/narrator.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { ConfirmDialogContext } from "../../common/confirm-dialog-context";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterSegment, adaptSegment } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";
import { useSpecCarryoverActions } from "./vlist-spec-carryover-actions";

export interface FixtureOptions {
	width: number;
	scheme: "light" | "dark";
	language: "en" | "zh-CN";
}

const BLOCKS = [
	{ type: "spec_fork_carryover", total: 12, open: 7, protectedOpen: 2 },
	{ type: "spec_context_cleared", total: 4, open: 3, protectedOpen: 1 },
];

/** Handlers that ran, as `<backend>:<action>`. */
const calls: string[] = [];

function segment(index: number): AdapterSegment {
	return {
		kind: "message",
		msg: rowWithElements(
			{ id: `spec-card-${index}`, role: "system", createdAt: "2026-11-08T09:00:00.000Z" },
			[BLOCKS[index] as never],
		),
	};
}

function Cards({
	options,
	backend,
}: {
	options: FixtureOptions;
	backend: "spec" | "outline" | "none";
}) {
	const { adapterLabels } = useVListLabels();
	const resolve = useSpecCarryoverActions(
		"fixture-narrator",
		() => calls.push(`${backend}:view`),
		backend === "outline" ? "outline" : "spec",
	);
	const ctx = { lod: 5 as const, labels: adapterLabels };
	return (
		<>
			{BLOCKS.map((_, index) => {
				const [spec] = adaptSegment(segment(index), ctx);
				if (!spec) return null;
				const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, options.width, 5, spec.opts);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				const actions = backend === "none" ? undefined : resolve(`spec-card-${index}`);
				// The spec session's mutating handlers are recorded instead of calling the server.
				extra.specCarryoverActions =
					actions && backend === "spec"
						? {
								...actions,
								onClearTasks: () => calls.push("spec:clear"),
								onResetSpec: () => calls.push("spec:reset"),
							}
						: actions;
				return (
					<div
						key={`${backend}-${spec.key}`}
						data-card=""
						data-backend={backend}
						data-measured={measured.height}
						style={{ position: "relative", width: options.width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</>
	);
}

let root: Root | null = null;

/** Render both versions of both cards at these options; resolves once painted. */
export async function render(options: FixtureOptions): Promise<void> {
	setTypography({ fontScalePercent: 100, lineHeightScalePercent: 100 });
	calls.length = 0;
	const i18n = i18next.createInstance();
	await i18n.use(initReactI18next).init({
		lng: options.language,
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
	const host = document.getElementById("root") as HTMLElement;
	root?.unmount();
	root = createRoot(host);
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient()}>
				<ConfirmDialogContext.Provider value={{ confirm: async () => false }}>
					<MantineProvider forceColorScheme={options.scheme}>
						<div
							id="shot"
							style={{
								width: options.width,
								boxSizing: "content-box",
								padding: 16,
								display: "flex",
								flexDirection: "column",
								gap: 8,
								background: "var(--mantine-color-body)",
							}}
						>
							<Cards options={options} backend="spec" />
							<Cards options={options} backend="outline" />
							<Cards options={options} backend="none" />
						</div>
					</MantineProvider>
				</ConfirmDialogContext.Provider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export interface ButtonReport {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** The native attribute. */
	disabled: boolean;
	ariaDisabled: string | null;
	dataDisabled: boolean;
	color: string;
	background: string;
	cursor: string;
}

export interface CardReport {
	backend: string;
	measured: number;
	painted: number;
	buttons: ButtonReport[];
}

export function report(): CardReport[] {
	return Array.from(document.querySelectorAll<HTMLElement>("[data-card]")).map((card) => {
		const paper = card.firstElementChild as HTMLElement | null;
		const origin = card.getBoundingClientRect();
		return {
			backend: card.dataset.backend ?? "",
			measured: Number(card.dataset.measured),
			painted: paper ? Math.round(paper.getBoundingClientRect().height) : 0,
			buttons: Array.from(card.querySelectorAll<HTMLButtonElement>("button")).map((button) => {
				const box = button.getBoundingClientRect();
				const style = getComputedStyle(button);
				return {
					text: button.textContent ?? "",
					x: Math.round((box.left - origin.left) * 10) / 10,
					y: Math.round((box.top - origin.top) * 10) / 10,
					width: Math.round(box.width * 10) / 10,
					height: Math.round(box.height * 10) / 10,
					disabled: button.hasAttribute("disabled"),
					ariaDisabled: button.getAttribute("aria-disabled"),
					dataDisabled: button.hasAttribute("data-disabled"),
					color: style.color,
					background: style.backgroundColor,
					cursor: style.cursor,
				};
			}),
		};
	});
}

/** The handlers that ran since the last render. */
export function ran(): string[] {
	return [...calls];
}
