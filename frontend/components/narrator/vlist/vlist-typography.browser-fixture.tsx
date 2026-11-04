/**
 * Browser fixture for `vlist-typography.browser.test.ts`: transcript rows rendered through the
 * real chain the list uses (segments → adapter → measure → render), each in a box of exactly the
 * height its measure function reserved, plus a DOM ground truth for the same text laid out by
 * the browser with the `--nf-type-*` variables the outline paints with.
 *
 * Test-only entry point (vlist-isolation.guard): bundled by the test, never imported.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { setTypography, type TypographySettings } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { ImageViewerProvider } from "../../common/ImageViewerProvider";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import { measureMarkdown } from "./measure/measure-markdown";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

ensureTypographyCssVars();

const i18n = createInstance();
await i18n.init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	ns: ["narrator", "chat", "common"],
	defaultNS: "narrator",
	resources: { "zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon } },
	react: { useSuspense: false },
});

/** Mixed Chinese/English prose, long enough to wrap several times at any test width. */
export const PARAGRAPH =
	"已把「修复：排查中断后无重试按钮」勾成完成，并在它下面记了三条：推送的分支、根因（中断后 status 停在 aborted）和回归测试位置。Mixed English 与中文混排 in one paragraph, so the wrap points fall between Latin words as well as between 汉字。";

const MARKDOWN = `### 结论与后续

${PARAGRAPH}

- 根因：中断后 \`status\` 停在 \`aborted\`，重试按钮只在 \`failed\` 时显示
- 已提交并推送 **fix/retry-after-interrupt**（3 个文件，+42 −7），CI 绿

\`\`\`ts
const canRetry = status === "failed" || status === "aborted";
\`\`\``;

let seq = 0;
const at = () => `2026-11-04T09:${String(10 + (seq++ % 50)).padStart(2, "0")}:00.000Z`;

function assistant(text: string): NarratorMsg {
	return rowWithElements(
		{ id: `t-${seq}`, narratorId: "n1", role: "assistant", contentText: text, createdAt: at() },
		[{ type: "text", text }] as never,
	) as unknown as NarratorMsg;
}

function user(text: string): NarratorMsg {
	return rowWithElements(
		{
			id: `u-${seq}`,
			narratorId: "n1",
			role: "user",
			origin: "user",
			contentText: text,
			createdAt: at(),
			creator: { id: "u-alice", username: "alice", displayName: "alice" },
		},
		[{ type: "text", text }] as never,
	) as unknown as NarratorMsg;
}

function bash(command: string, output: string): NarratorMsg {
	const id = `a-bash-${seq}`;
	const outputJson = { _text: output, _metadata: { exitCode: 0 } };
	const input = { command, description: "运行重试按钮的测试 / run the retry tests" };
	return rowWithElements(
		{
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${id}`,
					toolName: "Bash",
					inputJson: input,
					outputJson,
					status: "completed",
				},
			],
			createdAt: at(),
		},
		[
			{
				type: "tool_use",
				id: `tu-${id}`,
				name: "Bash",
				input,
				inputJson: input,
				outputJson,
				status: "completed",
			},
		] as never,
	) as unknown as NarratorMsg;
}

function scene(): NarratorMsg[] {
	return [
		user(`帮我看看：用户中断回合后为什么没有「重试」按钮？Please check the aborted state too.`),
		assistant(MARKDOWN),
		bash(
			"bun test --isolate frontend/components/narrator/RetryButton.test.tsx",
			" 3 pass\n 0 fail\nRan 3 tests across 1 file. [412.00ms]",
		),
		assistant(PARAGRAPH),
	];
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Rows({ width }: { width: number }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const ctx: AdapterContext = {
		lod: 5,
		labels: adapterLabels,
		resolveToolCategory: getCategory,
		resolveToolColor: (n: string, i?: unknown) => getCategoryColor(getCategory(n, i)),
		resolveToolSummary: (tc) => {
			const call = tc as { toolName: string; inputJson?: unknown; outputJson?: unknown };
			const meta = (call.outputJson as { _metadata?: Record<string, unknown> } | undefined)
				?._metadata;
			return getSummary(call.toolName, call.inputJson, meta);
		},
		isExpanded: () => true,
	};
	const specs = adaptSegments(segmentMessages(scene()) as unknown as AdapterSegment[], ctx);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }}>
			{specs.map((spec) => {
				const entry = VLIST_REGISTRY[spec.kind];
				if (!entry) return null;
				const measured = entry.measure(spec.data as never, width, 5, spec.opts as never);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.narratorId = "n1";
				if (spec.kind === "tool-call") extra.labels = renderLabels.toolCall;
				return (
					<div
						key={spec.key}
						data-row={spec.kind}
						data-measured-height={measured.height}
						style={{ position: "relative", height: measured.height, width, overflow: "visible" }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
}

let root: Root | null = null;

/** Render the scene at `width` with the given typography, in a color scheme. */
export function render(
	typography: Partial<TypographySettings>,
	width: number,
	scheme: "dark" | "light" = "dark",
): void {
	setTypography(typography);
	const host = document.getElementById("root") as HTMLElement;
	root?.unmount();
	host.innerHTML = "";
	root = createRoot(host);
	flushSync(() => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={queryClient}>
					<MantineProvider forceColorScheme={scheme}>
						<ImageViewerProvider>
							<OutlineOpenerProvider value={{ open: () => true }}>
								<div
									id="shot"
									style={{ background: "var(--mantine-color-body)", display: "inline-block" }}
								>
									<Rows width={width} />
								</div>
								<div
									id="ground-truth"
									className="nf-type-scope"
									style={{ width, padding: "0 16px 16px", boxSizing: "content-box" }}
								>
									<div id="gt-paragraph" style={{ width }}>
										{PARAGRAPH}
									</div>
								</div>
							</OutlineOpenerProvider>
						</ImageViewerProvider>
					</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
}

/**
 * Painted geometry vs the measured one:
 *   - every row box is exactly its measured height, and nothing in it is painted below it;
 *   - every measured text line is painted at the measured line box, and no line's text is
 *     wider than the row (a line the browser needs more room for than pretext measured);
 *   - the same paragraph laid out by the browser with the `--nf-type-*` variables (the
 *     outline's way) is exactly as tall as the transcript measured it.
 */
export function report() {
	const m = typographyMetrics();
	const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")].map((row) => {
		const box = row.getBoundingClientRect();
		const measured = Number(row.dataset.measuredHeight);
		let paintedBottom = 0;
		for (const el of row.querySelectorAll<HTMLElement>("[data-vlist-line]")) {
			const r = el.getBoundingClientRect();
			paintedBottom = Math.max(paintedBottom, r.bottom - box.top);
		}
		let widest = 0;
		for (const el of row.querySelectorAll<HTMLElement>("[data-vlist-line-frags]")) {
			widest = Math.max(widest, el.getBoundingClientRect().right - box.right);
		}
		const bodyLines = [...row.querySelectorAll<HTMLElement>("[data-vlist-line]")]
			.map((el) => el.getBoundingClientRect().height)
			.filter((h) => h === m.line.body).length;
		// Every glyph run in the row, whatever renders it (bubble, card, markdown).
		let textBottom = 0;
		let textRight = 0;
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim()) continue;
			range.selectNodeContents(node);
			for (const r of range.getClientRects()) {
				if (r.width === 0 || r.height === 0) continue;
				textBottom = Math.max(textBottom, r.bottom - box.top);
				textRight = Math.max(textRight, r.right - box.right);
			}
		}
		return {
			kind: row.dataset.row ?? "",
			measured,
			boxHeight: box.height,
			lines: row.querySelectorAll("[data-vlist-line]").length,
			bodyLines,
			paintedBottom,
			overflowRight: widest,
			textBottom,
			textRight,
		};
	});
	const gt = document.getElementById("gt-paragraph") as HTMLElement;
	const width = gt.getBoundingClientRect().width;
	return {
		rows,
		lineBody: m.line.body,
		groundTruth: {
			width,
			painted: gt.getBoundingClientRect().height,
			measured: measureMarkdown(PARAGRAPH, width).height,
			fontSize: getComputedStyle(gt).fontSize,
			lineHeight: getComputedStyle(gt).lineHeight,
		},
	};
}
