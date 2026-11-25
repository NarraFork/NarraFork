"use client";

/**
 * RenderRoundGroup.tsx — 整轮折叠条（"已处理 2m 14s"）。三态，两级展开。
 *
 *   1. **收起**：一行头部。高度是常量（measure 层给出），零测量。
 *   2. **盒内预览**（点一下）：头部 + 被折元素原样渲染在下面。这一态的高度
 *      **不预测**，由 ResizeObserver 实测后经 `onUnknownHeight` 上报，shell 的
 *      `heightOverrides` 覆盖回几何（见 `round-fold-heights` 的 retain 防线）。
 *   3. **提升为完整行**（预览里再点一次「展开为完整行」）：整轮回到内联，
 *      折叠条从序列里消失 —— 这一步由 shell 重建文档完成，本组件不参与。
 *
 * 为什么要两级：预览是「快速看一眼这轮做了什么」，内容仍在盒子里，因此没有
 * 右键菜单 / 块选中 / 独立虚拟化；真要继续操作这一轮的内容，就该把它提升为
 * 正常行，让每个元素都拿到完整身份。
 *
 * 本文件在 `render/` 下，不在零测量守卫扫描的纯路径里（见 CONTRACT.md §0）。
 */

import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type RoundGroupRenderData = {
	/** 已拼好的标题（"已处理 2m 14s"）。 */
	title: string;
	/** 折叠里的元素个数（无障碍描述与调试用）。 */
	childCount: number;
};

export function RenderRoundGroup({
	data,
	open,
	onToggle,
	onPromote,
	children,
}: {
	data: RoundGroupRenderData;
	/** 盒内预览中。 */
	open: boolean;
	/** 收起 ↔ 预览。 */
	onToggle?: () => void;
	/** 预览 → 完整行（整轮回到内联）。 */
	onPromote?: () => void;
	/** 被折元素（由 shell 注入，每个仍是自己的 RenderXxx）。 */
	children?: ReactNode;
}) {
	const { t } = useTranslation("narrator");
	return (
		<div style={{ paddingBottom: open ? 4 : 0 }}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				title={open ? t("roundFoldCollapse") : t("roundFoldExpand")}
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					maxWidth: "100%",
					padding: "1px 4px",
					margin: "0 -4px",
					border: "none",
					background: "transparent",
					borderRadius: 4,
					cursor: "pointer",
					color: "var(--mantine-color-dimmed)",
					fontSize: "var(--mantine-font-size-xs)",
					lineHeight: 1.5,
				}}
			>
				<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{data.title}
				</span>
				<IconChevronRight
					size={14}
					stroke={2}
					style={{
						flexShrink: 0,
						opacity: 0.7,
						transform: open ? "rotate(90deg)" : undefined,
						transition: "transform 250ms ease",
					}}
				/>
			</button>
			{open ? (
				<div>
					<div
						style={{
							marginTop: 6,
							paddingTop: 6,
							borderTop: "1px solid var(--mantine-color-dark-4)",
						}}
					>
						{children}
					</div>
					{/* 第二级入口：内容需要完整交互（右键、选中、独立折叠）时用它。
					    文案保持极简 —— 它是一条说明，不是主操作。 */}
					<button
						type="button"
						onClick={onPromote}
						style={{
							marginTop: 4,
							padding: "1px 4px",
							margin: "4px 0 0 -4px",
							border: "none",
							background: "transparent",
							borderRadius: 4,
							cursor: "pointer",
							color: "var(--mantine-color-dimmed)",
							fontSize: "var(--mantine-font-size-xs)",
							opacity: 0.8,
						}}
					>
						{t("roundFoldPromote")} →
					</button>
				</div>
			) : null}
		</div>
	);
}
