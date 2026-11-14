/**
 * Palette review page — mock UI so a background colour can be judged in context.
 *
 * Not part of the app: it exists to compare candidate dark-scheme backgrounds side by
 * side using the real components, typography and density. Open `/mock/palette-review.html`
 * on the dev server. Delete once a palette is chosen.
 *
 * The surface colours are the only variable: text, borders, accent and status colours come
 * from the same token values in every frame, so the comparison isolates the background.
 */

import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	MantineProvider,
	Paper,
	ScrollArea,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import {
	IconArrowUp,
	IconCheck,
	IconChevronRight,
	IconCircleDashed,
	IconCode,
	IconDots,
	IconFileText,
	IconFolder,
	IconGitBranch,
	IconHistory,
	IconLayoutSidebar,
	IconPlus,
	IconSearch,
	IconSettings,
	IconSparkles,
	IconTerminal2,
} from "@tabler/icons-react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { mantineTheme } from "../lib/mantine-theme";
import "@mantine/core/styles.css";
import "../styles/tokens.css";

interface Palette {
	scheme: "dark" | "light";
	name: string;
	note: string;
	canvas: string;
	pane: string;
	raised: string;
	hover: string;
	border: string;
	text: string;
	dimmed: string;
}

const DARK_CANDIDATES: Palette[] = [
	{
		scheme: "dark",
		name: "① 经典 · 蓝黑",
		note: "旧默认",
		canvas: "#0b0e14",
		pane: "#191d26",
		raised: "#22262f",
		hover: "#22262f",
		border: "#39404f",
		text: "#e7ebf3",
		dimmed: "#8a93a5",
	},
	{
		scheme: "dark",
		name: "② 石墨",
		note: "中性偏冷，比现状亮一档",
		canvas: "#16181d",
		pane: "#1f2229",
		raised: "#282c34",
		hover: "#282c34",
		border: "#3f4553",
		text: "#e7ebf3",
		dimmed: "#8f97a6",
	},
	{
		scheme: "dark",
		name: "③ VS Code 灰",
		note: "开发者最熟悉的观感",
		canvas: "#1e1e1e",
		pane: "#252526",
		raised: "#2d2d30",
		hover: "#2d2d30",
		border: "#454545",
		text: "#e6e6e6",
		dimmed: "#9d9d9d",
	},
	{
		scheme: "dark",
		name: "④ 东京夜",
		note: "蓝紫调，终端圈流行",
		canvas: "#1a1b26",
		pane: "#24283b",
		raised: "#2f3549",
		hover: "#2f3549",
		border: "#414868",
		text: "#c0caf5",
		dimmed: "#8b93b5",
	},
	{
		scheme: "dark",
		name: "⑤ 暖炭",
		note: "偏暖，长时间看不刺眼",
		canvas: "#191714",
		pane: "#221e1a",
		raised: "#2b2621",
		hover: "#2b2621",
		border: "#423a33",
		text: "#ece7e1",
		dimmed: "#a39a90",
	},
	{
		scheme: "dark",
		name: "⑥ 墨绿",
		note: "辨识度最高，也最容易翻车",
		canvas: "#0f1714",
		pane: "#17211d",
		raised: "#1f2b26",
		hover: "#1f2b26",
		border: "#34473f",
		text: "#e3ebe7",
		dimmed: "#8ea099",
	},
	{
		scheme: "dark",
		name: "⑦ 藏青",
		note: "比现状更蓝，接近 IDE",
		canvas: "#10131f",
		pane: "#191e2e",
		raised: "#222840",
		hover: "#222840",
		border: "#37405c",
		text: "#e4e8f5",
		dimmed: "#8d95ad",
	},
	{
		scheme: "dark",
		name: "⑧ Radix 石墨",
		note: "新默认 · Radix Colors",
		canvas: "#111113",
		pane: "#212225",
		raised: "#272a2d",
		hover: "#2e3135",
		border: "#363a3f",
		text: "#edeef0",
		dimmed: "#b0b4ba",
	},
	{
		scheme: "dark",
		name: "⑨ GitHub",
		note: "GitHub Primer · dark",
		canvas: "#0a0d12",
		pane: "#161b22",
		raised: "#21262d",
		hover: "#262c35",
		border: "#30363d",
		text: "#e6edf3",
		dimmed: "#8b949e",
	},
	{
		scheme: "dark",
		name: "⑩ Catppuccin",
		note: "Catppuccin · Mocha",
		canvas: "#0a0a12",
		pane: "#181825",
		raised: "#1e1e2e",
		hover: "#26263a",
		border: "#313244",
		text: "#cdd6f4",
		dimmed: "#7f849c",
	},
];

const LIGHT_CANDIDATES: Palette[] = [
	{
		scheme: "light",
		name: "① 现状 · 冷白",
		note: "当前线上",
		canvas: "#f6f7f9",
		pane: "#ffffff",
		raised: "#eef1f5",
		hover: "#eef1f5",
		border: "#d8dee8",
		text: "#141821",
		dimmed: "#5e6878",
	},
	{
		scheme: "light",
		name: "② 冷灰",
		note: "画布再灰一档，卡片更分明",
		canvas: "#eef1f6",
		pane: "#ffffff",
		raised: "#e6eaf1",
		hover: "#e6eaf1",
		border: "#cfd6e2",
		text: "#141821",
		dimmed: "#5e6878",
	},
	{
		scheme: "light",
		name: "③ 中灰",
		note: "对比最强，类似 Linear / Notion 面板",
		canvas: "#e8ecf2",
		pane: "#ffffff",
		raised: "#dfe4ec",
		hover: "#dfe4ec",
		border: "#c6cedb",
		text: "#141821",
		dimmed: "#5e6878",
	},
	{
		scheme: "light",
		name: "④ 暖纸",
		note: "米白画布，长时间看不发蓝",
		canvas: "#faf8f4",
		pane: "#ffffff",
		raised: "#f2eee7",
		hover: "#f2eee7",
		border: "#ddd6ca",
		text: "#1a1712",
		dimmed: "#6b6357",
	},
	{
		scheme: "light",
		name: "⑤ 米色",
		note: "比暖纸更明显，偏纸质感",
		canvas: "#f7f3ec",
		pane: "#fffdf8",
		raised: "#efe9df",
		hover: "#efe9df",
		border: "#ded5c6",
		text: "#1a1712",
		dimmed: "#6b6357",
	},
	{
		scheme: "light",
		name: "⑥ 淡蓝",
		note: "冷调，和高亮选中色同一家族",
		canvas: "#f1f5fc",
		pane: "#ffffff",
		raised: "#e7edf9",
		hover: "#e7edf9",
		border: "#cfdaea",
		text: "#141821",
		dimmed: "#5e6878",
	},
	{
		scheme: "light",
		name: "⑦ 纯白平铺",
		note: "没有画布层，只靠边框分区",
		canvas: "#ffffff",
		pane: "#ffffff",
		raised: "#f1f3f7",
		hover: "#f1f3f7",
		border: "#dee3ea",
		text: "#141821",
		dimmed: "#5e6878",
	},
	{
		scheme: "light",
		name: "⑧ Radix 石墨",
		note: "新默认 · Radix Colors",
		canvas: "#f0f0f3",
		pane: "#fcfcfd",
		raised: "#e8e8ec",
		hover: "#e0e1e6",
		border: "#d9d9e0",
		text: "#1c2024",
		dimmed: "#60646c",
	},
	{
		scheme: "light",
		name: "⑨ GitHub",
		note: "GitHub Primer · light",
		canvas: "#f6f8fa",
		pane: "#ffffff",
		raised: "#eaeef2",
		hover: "#e1e4e8",
		border: "#d0d7de",
		text: "#1f2328",
		dimmed: "#59636e",
	},
	{
		scheme: "light",
		name: "⑩ Catppuccin",
		note: "Catppuccin · Latte",
		canvas: "#e6e9ef",
		pane: "#eff1f5",
		raised: "#dce0e8",
		hover: "#ccd0da",
		border: "#bcc0cc",
		text: "#363a52",
		dimmed: "#5c5f77",
	},
];

const SESSIONS: ReadonlyArray<{ title: string; path: string; state: "live" | "wait" | "idle" }> = [
	{ title: "虚拟文件系统多层任务与子代理共享设计", path: "/home/…/narrafork", state: "live" },
	{ title: "bubblewrap与socat的作用", path: "/home/…/narrafork", state: "idle" },
	{ title: "双桌面容器数据隔离确认", path: "/home/…/narrafork-unified-gateway", state: "wait" },
	{ title: "锐评spec/机制与tasks.json设计", path: "/home/…/narrafork", state: "idle" },
	{ title: "前端性能专项优化与本地dev环境搭建", path: "/home/…/narrafork-public", state: "live" },
	{
		title: "基于GitHub Release的更新检测与下载机制设计",
		path: "/home/…/narrafork-public",
		state: "idle",
	},
];

const STATE_COLOR: Record<string, string> = {
	live: "var(--mock-live)",
	wait: "var(--mock-wait)",
	idle: "var(--mock-idle)",
};

function Dot({ state }: { state: "live" | "wait" | "idle" }) {
	return (
		<Box
			style={{
				width: 6,
				height: 6,
				borderRadius: 999,
				flexShrink: 0,
				background: STATE_COLOR[state],
			}}
		/>
	);
}

function Sidebar({ p }: { p: Palette }) {
	return (
		<Box
			style={{
				width: 236,
				flexShrink: 0,
				borderRight: `1px solid ${p.border}`,
				display: "flex",
				flexDirection: "column",
			}}
		>
			<Group gap={6} px={12} py={10} style={{ borderBottom: `1px solid ${p.border}` }}>
				<Text size="xs" fw={600} style={{ color: p.text, flex: 1 }}>
					叙述者
				</Text>
				<ActionIcon size="xs" variant="subtle" color="gray">
					<IconSearch size={12} />
				</ActionIcon>
				<ActionIcon size="xs" variant="subtle" color="gray">
					<IconPlus size={12} />
				</ActionIcon>
			</Group>
			<ScrollArea style={{ flex: 1 }} offsetScrollbars>
				<Stack gap={0} p={6}>
					{SESSIONS.map((s, i) => (
						<Box
							key={s.title}
							style={{
								padding: "6px 8px",
								borderRadius: 4,
								background: i === 0 ? p.raised : "transparent",
								display: "flex",
								gap: 7,
								alignItems: "flex-start",
							}}
						>
							<Box style={{ paddingTop: 4 }}>
								<Dot state={s.state} />
							</Box>
							<Box style={{ minWidth: 0 }}>
								<Text size="xs" fw={i === 0 ? 600 : 400} truncate style={{ color: p.text }}>
									{s.title}
								</Text>
								<Text size="xs" truncate style={{ color: p.dimmed, fontSize: 10 }}>
									{s.path}
								</Text>
							</Box>
						</Box>
					))}
				</Stack>
			</ScrollArea>
			<Group gap={6} px={12} py={8} style={{ borderTop: `1px solid ${p.border}`, color: p.dimmed }}>
				<IconSettings size={12} />
				<Text size="xs" style={{ color: p.dimmed }}>
					设置
				</Text>
			</Group>
		</Box>
	);
}

function ToolCard({ p }: { p: Palette }) {
	return (
		<Paper
			withBorder
			p={0}
			style={{
				background: p.pane,
				borderColor: p.border,
				overflow: "hidden",
			}}
		>
			<Group gap={6} px={10} py={6} style={{ borderBottom: `1px solid ${p.border}` }}>
				<ThemeIcon size={16} radius={4} variant="light" color="indigo">
					<IconTerminal2 size={10} />
				</ThemeIcon>
				<Text size="xs" fw={600} style={{ color: p.text }}>
					Bash
				</Text>
				<Text size="xs" ff="monospace" truncate style={{ color: p.dimmed, flex: 1 }}>
					bun test --isolate server/services/__tests__/knowledge-*
				</Text>
				<Badge size="xs" variant="light" color="green" leftSection={<IconCheck size={8} />}>
					通过
				</Badge>
			</Group>
			<Box px={10} py={6} style={{ fontFamily: "var(--nf-font-mono)", fontSize: 11 }}>
				<Text size="xs" ff="monospace" style={{ color: p.dimmed }}>
					<span style={{ color: "var(--mock-added)" }}>✓</span> 14 pass · 0 fail
					<span style={{ color: p.border }}> · </span>1.02s
				</Text>
				<Text size="xs" ff="monospace" style={{ color: p.dimmed }}>
					knowledge-query.test.ts <span style={{ color: p.border }}>……</span> 8 pass
				</Text>
			</Box>
		</Paper>
	);
}

function DiffCard({ p }: { p: Palette }) {
	return (
		<Box style={{ border: `1px solid ${p.border}`, borderRadius: 4, overflow: "hidden" }}>
			<Group
				gap={6}
				px={10}
				py={5}
				style={{ background: p.pane, borderBottom: `1px solid ${p.border}` }}
			>
				<IconCode size={12} color={p.dimmed} />
				<Text size="xs" fw={600} style={{ color: p.text }}>
					frontend/lib/mantine-theme.ts
				</Text>
				<Text size="xs" style={{ color: "var(--mock-added)", fontVariantNumeric: "tabular-nums" }}>
					+42
				</Text>
				<Text
					size="xs"
					style={{ color: "var(--mock-removed)", fontVariantNumeric: "tabular-nums" }}
				>
					−18
				</Text>
			</Group>
			<Box px={10} py={4} style={{ background: "var(--mock-diff-bg)" }}>
				<Text size="xs" ff="monospace" style={{ color: "var(--mock-diff-text)" }}>
					@@ -13,7 +13,9 @@ export const mantineTheme
				</Text>
			</Box>
			<Box px={10} py={3} style={{ fontFamily: "var(--nf-font-mono)", fontSize: 11 }}>
				<Text size="xs" ff="monospace" style={{ color: p.dimmed }}>
					<span style={{ opacity: 0.5 }}> </span>primaryColor: "indigo",
				</Text>
				<Text
					size="xs"
					ff="monospace"
					style={{ color: p.text, background: "var(--mock-added-bg)" }}
				>
					<span style={{ color: "var(--nf-live-graphic-dark)" }}>+</span> colors: {"{"} dark: [ink
					阶]
					{" }"},
				</Text>
				<Text
					size="xs"
					ff="monospace"
					style={{ color: p.text, background: "var(--mock-removed-bg)" }}
				>
					<span style={{ color: "var(--mock-removed)" }}>−</span> defaultRadius: "sm",
				</Text>
			</Box>
		</Box>
	);
}

function Chat({ p }: { p: Palette }) {
	return (
		<Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
			<Group gap={8} px={14} py={8} style={{ borderBottom: `1px solid ${p.border}` }}>
				<Text size="xs" fw={600} style={{ color: p.text }} truncate>
					基于 GitHub Release 的更新检测与下载机制设计
				</Text>
				<Badge size="xs" variant="light" color="indigo">
					primary
				</Badge>
				<Box style={{ flex: 1 }} />
				<Group gap={2}>
					<ActionIcon size="xs" variant="subtle" color="gray">
						<IconGitBranch size={12} />
					</ActionIcon>
					<ActionIcon size="xs" variant="subtle" color="gray">
						<IconHistory size={12} />
					</ActionIcon>
					<ActionIcon size="xs" variant="subtle" color="gray">
						<IconDots size={12} />
					</ActionIcon>
				</Group>
			</Group>

			<Box px={16} py={12} style={{ flex: 1, overflow: "hidden" }}>
				<Stack gap={10}>
					<Group gap={6} wrap="nowrap">
						<Badge size="xs" variant="light" color="gray">
							系统
						</Badge>
						<Text size="xs" style={{ color: p.dimmed }}>
							我通过文件编辑器修改了 README.md
						</Text>
					</Group>

					<Group align="flex-start" gap={8} wrap="nowrap">
						<ThemeIcon size={20} radius={999} variant="filled" color="indigo">
							<IconSparkles size={11} />
						</ThemeIcon>
						<Box>
							<Text size="xs" fw={600} style={{ color: p.text }}>
								domixie
							</Text>
							<Text size="xs" style={{ color: p.text, lineHeight: 1.6 }}>
								许可证这边简单介绍一下 MPL2.0 的基本要义，快速开始应当增加直接运行预构建包的部分，
								指向 GitHub release，并说明 baseline 后续版本用于不带 AVX-512 指令集的旧芯片
							</Text>
						</Box>
					</Group>

					<ToolCard p={p} />
					<DiffCard p={p} />

					<Group gap={6} mt={2}>
						<IconCircleDashed size={12} color="var(--mock-live)" />
						<Text size="xs" style={{ color: p.dimmed }}>
							正在检索 worker 生命周期相关代码…
						</Text>
					</Group>
				</Stack>
			</Box>

			<Box px={12} py={8} style={{ borderTop: `1px solid ${p.border}` }}>
				<Paper withBorder p={8} style={{ background: p.pane, borderColor: p.border }}>
					<Text size="xs" style={{ color: p.dimmed }}>
						发送消息…
					</Text>
					<Group justify="space-between" mt={6}>
						<Group gap={4}>
							<Badge size="xs" variant="light" color="gray" radius="sm">
								deepseek-v3
							</Badge>
							<Badge size="xs" variant="light" color="gray" radius="sm">
								全部允许
							</Badge>
						</Group>
						<Button size="xs" radius="sm" rightSection={<IconArrowUp size={11} />}>
							发送
						</Button>
					</Group>
				</Paper>
			</Box>
		</Box>
	);
}

function FilePanel({ p }: { p: Palette }) {
	return (
		<Box
			style={{
				width: 300,
				flexShrink: 0,
				borderLeft: `1px solid ${p.border}`,
				display: "flex",
				flexDirection: "column",
			}}
		>
			<Group gap={6} px={12} py={8} style={{ borderBottom: `1px solid ${p.border}` }}>
				<IconFileText size={12} color={p.dimmed} />
				<Text size="xs" fw={600} style={{ color: p.text }}>
					README.md
				</Text>
				<Box style={{ flex: 1 }} />
				<ActionIcon size="xs" variant="subtle" color="gray">
					<IconLayoutSidebar size={12} />
				</ActionIcon>
			</Group>
			<Group gap={4} px={12} py={6} style={{ color: p.dimmed }}>
				<IconFolder size={11} />
				<Text size="xs" style={{ color: p.dimmed }}>
					docs
				</Text>
				<IconChevronRight size={11} />
				<Text size="xs" style={{ color: p.dimmed }}>
					README.md
				</Text>
			</Group>
			<Divider color={p.border} />
			<Box px={12} py={8} style={{ flex: 1, overflow: "hidden" }}>
				<Stack gap={3}>
					<Text size="xs" fw={700} style={{ color: p.text, fontSize: 13 }}>
						NarraFork
					</Text>
					<Text size="xs" style={{ color: p.dimmed }}>
						多人协作 · 多模型协作 · 多设备流转
					</Text>
					<Box mt={6}>
						<Text size="xs" fw={600} style={{ color: p.text }}>
							核心能力
						</Text>
						<Text size="xs" style={{ color: p.dimmed }}>
							会话面板、多 Agent 协作、上下文管理
						</Text>
					</Box>
					<Box mt={6} style={{ background: p.raised, borderRadius: 4, padding: "6px 8px" }}>
						<Text size="xs" ff="monospace" style={{ color: p.dimmed, fontSize: 10 }}>
							bun run dev
						</Text>
					</Box>
				</Stack>
			</Box>
		</Box>
	);
}

function Frame({ p, baseline }: { p: Palette; baseline: boolean }) {
	const dark = p.scheme === "dark";
	const vars = {
		"--mock-live": dark ? "var(--nf-live-graphic-dark)" : "var(--nf-live-graphic-light)",
		"--mock-wait": dark ? "var(--nf-wait-graphic-dark)" : "var(--nf-wait-graphic-light)",
		"--mock-idle": p.border,
		"--mock-added": dark ? "#51cf66" : "#2f9e44",
		"--mock-added-bg": dark ? "rgba(81,207,102,0.12)" : "rgba(47,158,68,0.10)",
		"--mock-removed": dark ? "#f0555a" : "#c92a2a",
		"--mock-removed-bg": dark ? "rgba(240,85,90,0.10)" : "rgba(201,42,42,0.08)",
		"--mock-diff-bg": dark ? "var(--nf-diff-hunk-bg-dark)" : "var(--nf-diff-hunk-bg-light)",
		"--mock-diff-text": dark ? "var(--nf-diff-hunk-text-dark)" : "var(--nf-diff-hunk-text-light)",
		colorScheme: p.scheme,
		"--mantine-color-body": p.canvas,
		"--mantine-color-default": p.pane,
		"--mantine-color-default-hover": p.hover,
		"--mantine-color-default-border": p.border,
		"--mantine-color-dimmed": p.dimmed,
		"--mantine-color-text": p.text,
		"--mantine-color-dark-4": p.border,
		color: p.text,
		background: p.canvas,
	} as React.CSSProperties;

	return (
		<Box mb={28}>
			<Group gap={8} mb={6} px={2}>
				<Text size="sm" fw={700} style={{ color: dark ? "#e7ebf3" : "#141821" }}>
					{p.name}
				</Text>
				<Text size="xs" style={{ color: dark ? "#8a93a5" : "#5e6878" }}>
					{p.note}
				</Text>
				{baseline ? (
					<Badge size="xs" variant="light" color="indigo">
						当前线上
					</Badge>
				) : null}
				<Box style={{ flex: 1 }} />
				<Text
					size="xs"
					ff="monospace"
					style={{ color: dark ? "#8a93a5" : "#5e6878", fontSize: 10 }}
				>
					canvas {p.canvas} · pane {p.pane}
				</Text>
			</Group>
			<Box
				style={{
					...vars,
					borderRadius: 8,
					border: `1px solid ${dark ? "#2b303b" : "#c9d0dc"}`,
					overflow: "hidden",
					display: "flex",
					height: 470,
					fontSize: 13,
				}}
			>
				<Sidebar p={p} />
				<Chat p={p} />
				<FilePanel p={p} />
			</Box>
		</Box>
	);
}

function Section({
	title,
	note,
	items,
	onDark,
}: {
	title: string;
	note: string;
	items: Palette[];
	onDark: boolean;
}) {
	const heading = onDark ? "#e7ebf3" : "#141821";
	const sub = onDark ? "#8a93a5" : "#5e6878";
	return (
		<Box
			style={{
				background: onDark ? "#0b0e14" : "#eef1f5",
				padding: "32px 0 8px",
			}}
		>
			<Box style={{ maxWidth: 1280, margin: "0 auto", padding: "0 32px" }}>
				<Text size="lg" fw={700} style={{ color: heading }}>
					{title}
				</Text>
				<Text size="sm" mb="lg" style={{ color: sub }}>
					{note}
				</Text>
				{items.map((c, i) => (
					<Frame key={c.name} p={c} baseline={i === 0} />
				))}
			</Box>
		</Box>
	);
}

function Page() {
	const params = new URLSearchParams(location.search);
	const set = params.get("set") ?? "both";
	const only = params.get("only");
	const pick = (list: Palette[]) => {
		if (!only) return list;
		const indexes = only.split(",").map((n) => Number(n));
		return list.filter((_, i) => indexes.includes(i));
	};
	return (
		<Box style={{ minHeight: "100vh" }}>
			<Box
				style={{
					position: "sticky",
					top: 0,
					zIndex: 10,
					display: "flex",
					gap: 16,
					alignItems: "center",
					padding: "10px 32px",
					background: "#000",
					borderBottom: "1px solid #2b303b",
				}}
			>
				<Text size="sm" fw={700} style={{ color: "#e7ebf3" }}>
					NarraFork · 背景候选
				</Text>
				<Anchor href="?set=light" size="xs" style={{ color: "#8a93a5" }}>
					浅色
				</Anchor>
				<Anchor href="?set=dark" size="xs" style={{ color: "#8a93a5" }}>
					深色
				</Anchor>
				<Anchor href="?set=both" size="xs" style={{ color: "#8a93a5" }}>
					全部
				</Anchor>
			</Box>
			{set !== "dark" ? (
				<Section
					title="浅色背景候选"
					note="只有画布/面板色不同：文字、边框、主色、状态色一致。"
					items={pick(LIGHT_CANDIDATES)}
					onDark={false}
				/>
			) : null}
			{set !== "light" ? (
				<Section
					title="深色背景候选"
					note="只有画布/面板色不同：文字、边框、主色、状态色一致。"
					items={pick(DARK_CANDIDATES)}
					onDark
				/>
			) : null}
		</Box>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<MantineProvider theme={mantineTheme} forceColorScheme="dark">
		<Page />
	</MantineProvider>,
);

export type { Palette };
