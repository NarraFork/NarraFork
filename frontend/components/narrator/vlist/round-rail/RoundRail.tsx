"use client";

/**
 * RoundRail.tsx — 轮次导航轨：会话里每一轮一根横条，点哪根跳哪轮。
 *
 * 这条轨道按「轮次序数」定位（每轮严格一格），数据来自后端全量轮次索引，
 *   与前端加载了多少消息无关 —— 这就是它能跳到很早就被窗口裁掉的轮的原因。
 *
 * 形态（桌面 / 触屏分流，与 Vantaloom 一致）：
 *   - 鼠标：划进轨道即出摘要卡（不用点），指着第 k 根 → 第 k 轮落在卡片正中；
 *   - 触屏 / 键盘：点开就地展开的列表（触屏拖不动这排细横条）。
 *
 * DOM 边界：本文件属于 `render/` 之外的组件层，**量的是自己的视口尺寸**
 * （轨道可用高、横条中心坐标），不参与任何列表元素的高度模型 —— 与
 * `PretextExactMessageList` 外壳读自己 clientHeight 同一类，不受零测量铁律约束。
 */

import type { NarratorRound } from "@shared/narrator-rounds";
import { IconBookmark } from "@tabler/icons-react";
import * as React from "react";
import {
	nearestTickIndex,
	pickerCardTop,
	RAIL_EDGE_MARGIN,
	RAIL_LIST_MAX_HEIGHT_PX,
	railCapacity,
	railWindowStart,
	TICK_HEIGHT_PX,
	TICK_PITCH_PX,
} from "./round-rail-geometry";

/** 指针离开轨道 / 摘要卡后多久收起（从轨道移到卡片的路上不闪断）。 */
const HOVER_CLOSE_DELAY_MS = 160;
/** 卡片上滚轮翻一行要累积的位移（滚轮一格约 100px）。 */
const WHEEL_STEP_PX = 100;
/** 收藏轮的右侧小点直径（px）。 */
const FAVORITE_DOT_PX = 5;

export type RoundRailLabels = {
	/** 轨道整体的无障碍名（"轮次导航"）。 */
	rail: string;
	/** 标题提示里的轮数（"共 {count} 轮"）。 */
	railTitle: (count: number) => string;
	/** 尚未回复的轮。 */
	pendingReply: string;
	/** 收藏 / 取消收藏的无障碍名。 */
	favorite: string;
	unfavorite: string;
	/** 空态：这一轮的用户消息没有文本（纯附件）。 */
	emptyRound: string;
};

const DEFAULT_LABELS: RoundRailLabels = {
	rail: "Round timeline",
	railTitle: (count) => `${count} rounds`,
	pendingReply: "Waiting for reply…",
	favorite: "Bookmark this round",
	unfavorite: "Remove bookmark",
	emptyRound: "(no text)",
};

/** 时长：45s / 11m 45s / 1h 5m。缺任一端 → ""（不显示，而不是显示 0）。 */
export function formatRoundSpan(startedAt: number | null, repliedAt: number | null): string {
	if (typeof startedAt !== "number" || typeof repliedAt !== "number") return "";
	const span = repliedAt - startedAt;
	// 时钟回拨 / 后端给 0：显示「-3m」比不显示更让人困惑。
	if (span <= 0) return "";
	if (span < 1000) return "<1s";
	const totalSec = Math.round(span / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const restSec = totalSec % 60;
	if (minutes < 60) return restSec > 0 ? `${minutes}m ${restSec}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMin = minutes % 60;
	return restMin > 0 ? `${hours}h ${restMin}m` : `${hours}h`;
}

/**
 * 卡片第二行：`时间 · 耗时 · token`（与 Vantaloom 的元信息行同构）。
 *
 * 时间取轮首的钟点（同一天只显示时:分，跨天带日期）—— 它回答「这是什么时候
 * 问的」，比「多久以前」更容易和日志、提交对上。
 * 缺哪段就不写哪段，绝不编数字。
 */
export function formatRoundMeta(round: NarratorRound, pendingLabel: string): string {
	const parts: string[] = [];
	const when = formatRoundClock(round.startedAt);
	if (when) parts.push(when);
	const span = formatRoundSpan(round.startedAt, round.repliedAt);
	if (span) parts.push(span);
	if (typeof round.tokens === "number" && round.tokens > 0) {
		parts.push(`${formatTokenCount(round.tokens)} token`);
	}
	// 还没回复：先写已有的（通常就是轮首时间），再补一句「还在等」。
	if (typeof round.repliedAt !== "number") {
		return parts.length > 0 ? `${parts.join(" · ")} · ${pendingLabel}` : pendingLabel;
	}
	return parts.join(" · ");
}

/** 轮首钟点：当天 → `14:05`，跨年 → `3/14 14:05`；缺时间 → ""。 */
export function formatRoundClock(startedAt: number | null | undefined): string {
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "";
	const date = new Date(startedAt);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return clock;
	const sameYear = date.getFullYear() === now.getFullYear();
	const day = `${date.getMonth() + 1}/${date.getDate()}`;
	return sameYear ? `${day} ${clock}` : `${date.getFullYear()}/${day} ${clock}`;
}

/** 时长 + token 组成折叠条文案（"已处理 2m 14s · 12.3k token"）。 */
export function formatRoundSummary(round: NarratorRound, pendingLabel: string): string {
	const span = formatRoundSpan(round.startedAt, round.repliedAt);
	const tokens =
		typeof round.tokens === "number" && round.tokens > 0
			? `${formatTokenCount(round.tokens)} token`
			: "";
	const parts = [span, tokens].filter(Boolean);
	if (parts.length > 0) return parts.join(" · ");
	// 还没回复：给一句明确的进行中说明，而不是空白条目。
	return typeof round.repliedAt === "number" ? "" : pendingLabel;
}

/**
 * 1200 → 1.2k，12300 → 12.3k，34k → 34k，1500000 → 1.5M。<=0 → ""。
 *
 * 千位以内保留一位小数只在**整数部分不够窄**时才丢：`value < 100` 保一位
 * （1.2k / 12.3k），再大就连整数部分都挤了，取整（340k / 999k）。
 * 早先的阈值写成 `10`，于是 12.3k 被压成 12k —— 时间线那一行很短，一位小数
 * 恰是「这个数字大概多大」的唯一线索，不该丢。
 */
export function formatTokenCount(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const value = n / 1000;
		return `${value < 100 ? value.toFixed(1) : Math.round(value)}k`;
	}
	const value = n / 1_000_000;
	return `${value < 100 ? value.toFixed(1) : Math.round(value)}M`;
}

/** 已知轮数下，把「该不该显示导航轨」判出来：至少两轮才值得画。 */
export function shouldShowRoundRail(roundCount: number): boolean {
	return roundCount >= 2;
}

export function RoundRail({
	rounds,
	activeIndex,
	onJumpToRound,
	favorites,
	onToggleFavorite,
	labels: labelsProp,
	className,
	tapToOpen = false,
}: {
	rounds: readonly NarratorRound[];
	/** 当前在看的轮（`resolveActiveRoundIndex` 的结果）；-1 = 还没判出。 */
	activeIndex: number;
	onJumpToRound: (round: NarratorRound) => void;
	/** 已收藏轮的 seq 集合（收藏横条右侧多一个点）。 */
	favorites: ReadonlySet<number>;
	onToggleFavorite?: (seq: number) => void;
	labels?: Partial<RoundRailLabels>;
	className?: string;
	/** 触屏 / 窄屏：点轨道任何位置都弹滚动列表（细横条指头点不准，触摸也没有 hover）。 */
	tapToOpen?: boolean;
}) {
	const labels = React.useMemo<RoundRailLabels>(
		() => ({ ...DEFAULT_LABELS, ...labelsProp }),
		[labelsProp],
	);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const railRef = React.useRef<HTMLButtonElement>(null);
	const viewportRef = React.useRef<HTMLSpanElement>(null);
	const pickerListRef = React.useRef<HTMLDivElement>(null);
	const tickRefs = React.useRef<Array<HTMLSpanElement | null>>([]);

	// 无悬停形态（触屏 / 极窄 / 键盘）：点开就地展开的列表。
	const [open, setOpen] = React.useState(false);
	const [hoverSeq, setHoverSeq] = React.useState<number | null>(null);
	const [hoverPos, setHoverPos] = React.useState<{ left: number; top: number }>({
		left: 22,
		top: 0,
	});
	const [capacity, setCapacity] = React.useState(24);
	const [railStart, setRailStart] = React.useState(Number.MAX_SAFE_INTEGER);
	const closeTimerRef = React.useRef<number | null>(null);
	const wheelAccumRef = React.useRef(0);
	const wasOpenRef = React.useRef(false);

	const hasRounds = rounds.length > 0;

	// ── 可用高度 → 容量 ──
	// 观测外层 `[data-round-rail-bounds]`（滚动视口）的高度，而不是观测轨体自身：
	// 轨体垂直居中（`translateY(-50%)`），用 `bottom - rect.top` 观测自身会造成
	// 扩容 → `rect.top` 上移 → 可用高度变大的正反馈循环，也会在分屏下窗格溢出。
	React.useLayoutEffect(() => {
		if (!hasRounds) return;
		const bounds = containerRef.current?.closest<HTMLElement>("[data-round-rail-bounds]");
		const measure = () => {
			const available = bounds ? bounds.clientHeight : window.innerHeight;
			const next = railCapacity(available);
			setCapacity((current) => (current === next ? current : next));
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		if (observer && bounds) observer.observe(bounds);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [hasRounds]);

	// 指针在轨道上 / 列表开着时窗口不动，否则指针底下那根会换成别的轮。
	const frozen = hoverSeq !== null || open;
	const nextStart = railWindowStart(
		railStart,
		frozen ? -1 : activeIndex,
		rounds.length,
		capacity,
		RAIL_EDGE_MARGIN,
	);
	if (rounds.length > 0 && nextStart !== railStart) {
		setRailStart(nextStart);
	}

	const cancelHoverClose = React.useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);
	const scheduleHoverClose = React.useCallback(() => {
		cancelHoverClose();
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setHoverSeq(null);
		}, HOVER_CLOSE_DELAY_MS);
	}, [cancelHoverClose]);
	React.useEffect(() => cancelHoverClose, [cancelHoverClose]);

	const closePicker = React.useCallback((restoreFocus: boolean) => {
		setOpen(false);
		setHoverSeq(null);
		if (restoreFocus) {
			window.requestAnimationFrame(() => railRef.current?.focus());
		}
	}, []);

	React.useEffect(() => {
		if (!open && hoverSeq === null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closePicker(open);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, hoverSeq, closePicker]);

	// 打开选择器时一次性把当前轮滚进视野并移交焦点；不放到内联 ref 回调里，
	// 避免在弹层内点收藏触发重渲染时把滚动位置拉回当前轮。
	React.useEffect(() => {
		const prevOpen = wasOpenRef.current;
		wasOpenRef.current = open;
		if (!open || prevOpen) return;
		const list = pickerListRef.current;
		if (!list) return;
		const target =
			list.querySelector<HTMLButtonElement>("[data-round-card-active='1']") ??
			list.querySelector<HTMLButtonElement>("[data-round-card-select='1']");
		target?.scrollIntoView({ block: "center" });
		target?.focus();
	}, [open]);

	/** 指针 y → 窗口内哪一轮（只看露出的横条）。 */
	const nearestTickAt = React.useCallback(
		(clientY: number): number => {
			const viewport = viewportRef.current?.getBoundingClientRect();
			const centers = rounds.map((_, index) => {
				const rect = tickRefs.current[index]?.getBoundingClientRect();
				if (!rect) return Number.NaN;
				const center = rect.top + rect.height / 2;
				if (viewport && (center < viewport.top || center > viewport.bottom)) return Number.NaN;
				return center;
			});
			return nearestTickIndex(centers, clientY);
		},
		[rounds],
	);

	const shownTicks = Math.min(capacity, rounds.length);
	const railViewportHeight = shownTicks * TICK_PITCH_PX - (TICK_PITCH_PX - TICK_HEIGHT_PX);
	const hiddenAbove = nextStart > 0;
	const hiddenBelow = nextStart + shownTicks < rounds.length;
	const railMask =
		hiddenAbove || hiddenBelow
			? `linear-gradient(to bottom, ${
					hiddenAbove ? "transparent 0, black 12px" : "black 0"
				}, ${hiddenBelow ? "black calc(100% - 12px), transparent 100%" : "black 100%"})`
			: undefined;

	const jumpTo = (round: NarratorRound | undefined) => {
		if (!round) return;
		cancelHoverClose();
		setHoverSeq(null);
		setOpen(false);
		onJumpToRound(round);
	};

	const hoverIndex = hoverSeq === null ? -1 : rounds.findIndex((r) => r.seq === hoverSeq);
	const shownHover = hoverIndex >= 0 ? rounds[hoverIndex] : undefined;

	// 在 layout effect 中测量悬停卡片位置，避免在 render 期调用 getBoundingClientRect 触发同步回流。
	React.useLayoutEffect(() => {
		if (!shownHover || open) return;
		const left = railRef.current ? railRef.current.getBoundingClientRect().width + 6 : 22;
		const top = pickerCardTopForRow(containerRef.current, tickRefs.current[hoverIndex], 60);
		setHoverPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
	}, [shownHover, hoverIndex, open]);

	if (!shouldShowRoundRail(rounds.length)) return null;

	return (
		<div ref={containerRef} className={className} style={{ position: "relative" }}>
			<button
				ref={railRef}
				type="button"
				aria-label={labels.rail}
				aria-expanded={open}
				aria-haspopup="listbox"
				title={hoverSeq === null ? labels.railTitle(rounds.length) : undefined}
				onPointerMove={(event) => {
					if (event.pointerType !== "mouse" || open) return;
					cancelHoverClose();
					const tick = nearestTickAt(event.clientY);
					const round = tick >= 0 ? rounds[tick] : undefined;
					setHoverSeq(round ? round.seq : null);
				}}
				onPointerLeave={(event) => {
					if (event.pointerType === "mouse") scheduleHoverClose();
				}}
				onClick={(event) => {
					// 触屏 / 窄屏，或键盘/辅助技术激活（`event.detail === 0` 且无指针坐标）：
					// 先走选择器弹层，绝不能把无坐标激活送进 `nearestTickAt(0)` 误跳第一根刻度。
					if (tapToOpen || event.detail === 0) {
						cancelHoverClose();
						setHoverSeq(null);
						setOpen((value) => !value);
						return;
					}
					// 桌面指针点击：点哪根跳哪轮，落点只认指针位置（不读 hover —— 它可能还是
					// 上一次渲染的值，快速移过来点会跳到上一个悬停的轮）。
					const tick = nearestTickAt(event.clientY);
					if (tick >= 0) {
						jumpTo(rounds[tick]);
						return;
					}
					// 点空档（横条之间）：桌面上不弹列表，交给 hover 兜底。
					if (shownHover) {
						jumpTo(shownHover);
						return;
					}
					setHoverSeq(null);
					setOpen((value) => !value);
				}}
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "flex-start",
					padding: "8px 6px",
					border: "none",
					background: "transparent",
					cursor: "pointer",
					visibility: open ? "hidden" : "visible",
				}}
			>
				<span
					ref={viewportRef}
					style={{
						display: "block",
						overflow: "hidden",
						height: railViewportHeight,
						maskImage: railMask,
						WebkitMaskImage: railMask,
					}}
				>
					<span
						style={{
							display: "flex",
							flexDirection: "column",
							alignItems: "flex-start",
							gap: TICK_PITCH_PX - TICK_HEIGHT_PX,
							transform: `translateY(${-nextStart * TICK_PITCH_PX}px)`,
							transition: "transform 250ms ease",
						}}
					>
						{rounds.map((round, index) => {
							const active = index === activeIndex;
							const pointed = round.seq === hoverSeq;
							const favorited = favorites.has(round.seq);
							return (
								<span
									key={round.seq}
									ref={(element) => {
										tickRefs.current[index] = element;
									}}
									aria-hidden="true"
									style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}
								>
									<span
										style={{
											height: TICK_HEIGHT_PX,
											borderRadius: 999,
											width: active ? 14 : pointed ? 12 : 8,
											background: active
												? "var(--mantine-color-text)"
												: pointed
													? "var(--mantine-color-dimmed)"
													: "var(--mantine-color-dark-3)",
											opacity: active ? 0.85 : pointed ? 0.6 : 0.45,
											transition: "width 250ms ease, opacity 250ms ease",
										}}
									/>
									{favorited ? (
										<span
											style={{
												width: FAVORITE_DOT_PX,
												height: FAVORITE_DOT_PX,
												borderRadius: 999,
												background: "var(--mantine-color-text)",
												opacity: active ? 1 : 0.65,
											}}
										/>
									) : null}
								</span>
							);
						})}
					</span>
				</span>
			</button>

			{/* 悬停摘要卡：中线对准指着的那根横条，到屏幕边缘夹住，点击直接跳转到该轮。 */}
			{shownHover && !open ? (
				<div
					onPointerEnter={cancelHoverClose}
					onPointerLeave={scheduleHoverClose}
					onWheel={(event) => {
						if (hoverIndex < 0) return;
						wheelAccumRef.current += event.deltaY;
						const steps = Math.trunc(wheelAccumRef.current / WHEEL_STEP_PX);
						if (steps === 0) return;
						wheelAccumRef.current -= steps * WHEEL_STEP_PX;
						const next = Math.min(rounds.length - 1, Math.max(0, hoverIndex + steps));
						const target = rounds[next];
						if (target) setHoverSeq(target.seq);
					}}
					style={{
						position: "absolute",
						left: hoverPos.left,
						top: hoverPos.top,
						width: 280,
						zIndex: 50,
					}}
				>
					<RoundCard
						round={shownHover}
						active={hoverIndex === activeIndex}
						ordinal={hoverIndex + 1}
						total={rounds.length}
						favorited={favorites.has(shownHover.seq)}
						onSelect={() => jumpTo(shownHover)}
						onToggleFavorite={onToggleFavorite}
						labels={labels}
					/>
				</div>
			) : null}

			{open ? (
				<>
					<div
						style={{ position: "fixed", inset: 0, zIndex: 40 }}
						aria-hidden="true"
						onClick={() => closePicker(true)}
					/>
					<div
						ref={pickerListRef}
						role="listbox"
						aria-label={labels.rail}
						style={{
							position: "absolute",
							left: 6,
							top: "50%",
							transform: "translateY(-50%)",
							zIndex: 50,
							width: 300,
							maxWidth: "calc(100vw - 24px)",
							maxHeight: RAIL_LIST_MAX_HEIGHT_PX,
							overflowY: "auto",
							overflowX: "hidden",
							// 同卡片：列表也浮在正文上，必须不透明。
							background: "var(--mantine-color-body)",
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: 10,
							boxShadow: "0 10px 28px rgba(0, 0, 0, 0.32)",
							padding: 4,
							display: "grid",
							gridTemplateColumns: "minmax(0, 1fr)",
							gap: 1,
						}}
					>
						{rounds.map((round, index) => (
							<RoundCard
								key={round.seq}
								round={round}
								active={index === activeIndex}
								ordinal={index + 1}
								total={rounds.length}
								favorited={favorites.has(round.seq)}
								onSelect={() => jumpTo(round)}
								onToggleFavorite={onToggleFavorite}
								labels={labels}
							/>
						))}
					</div>
				</>
			) : null}
		</div>
	);
}

/** 单个轮次条目：原话（加粗）+ 时长/token + 收藏。避免嵌套 `<button>`，主操作与收藏按钮平级。 */
export function RoundCard({
	round,
	active,
	ordinal,
	total,
	favorited,
	onSelect,
	onToggleFavorite,
	labels,
}: {
	round: NarratorRound;
	active: boolean;
	ordinal: number;
	total: number;
	favorited: boolean;
	onSelect?: () => void;
	onToggleFavorite?: (seq: number) => void;
	labels: RoundRailLabels;
}) {
	const summary = formatRoundMeta(round, labels.pendingReply);
	const bodyContent = (
		<>
			<span
				aria-hidden="true"
				style={{
					height: 2.5,
					flexShrink: 0,
					borderRadius: 999,
					width: active ? 14 : 10,
					background: active ? "var(--mantine-color-text)" : "var(--mantine-color-dimmed)",
					opacity: active ? 0.85 : 0.4,
				}}
			/>
			<span
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 2,
					minWidth: 0,
					flex: 1,
				}}
			>
				<span
					style={{
						fontWeight: 600,
						fontSize: "var(--mantine-font-size-sm)",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}
				>
					{round.userText || labels.emptyRound}
				</span>
				{/* 回复缩略：给出「AI 答了什么」的那一眼。只有两行 —— 它是确认用的，不是用来读的。 */}
				{round.replyPreview ? (
					<span
						style={{
							fontSize: "var(--mantine-font-size-xs)",
							color: "var(--mantine-color-dimmed)",
							display: "-webkit-box",
							WebkitLineClamp: 2,
							WebkitBoxOrient: "vertical",
							overflow: "hidden",
						}}
					>
						{round.replyPreview}
					</span>
				) : null}
				{summary ? (
					<span
						style={{
							fontSize: "var(--mantine-font-size-xs)",
							color: "var(--mantine-color-dimmed)",
							fontVariantNumeric: "tabular-nums",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{summary}
					</span>
				) : null}
			</span>
		</>
	);
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 8px",
				minWidth: 0,
				// ⚠️ 必须有**不透明**背景：卡片浮在正文之上，纯透明会让文字和下面的
				// 消息正文叠在一起完全看不清（实测就是这样）。`body` 是主题里
				// 不透明的那一档，`default` / `default-hover` 都带透明通道。
				background: "var(--mantine-color-body)",
				border: "1px solid var(--mantine-color-default-border)",
				borderRadius: 8,
				boxShadow: "0 6px 20px rgba(0, 0, 0, 0.28)",
				...(active ? { borderColor: "var(--mantine-color-text)" } : {}),
			}}
		>
			{onSelect ? (
				<button
					type="button"
					data-round-card-select="1"
					data-round-card-active={active ? "1" : undefined}
					onClick={onSelect}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						flex: 1,
						minWidth: 0,
						padding: 0,
						border: "none",
						background: "transparent",
						color: "inherit",
						textAlign: "left",
						cursor: "pointer",
					}}
				>
					{bodyContent}
				</button>
			) : (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						flex: 1,
						minWidth: 0,
					}}
				>
					{bodyContent}
				</div>
			)}
			{onToggleFavorite ? (
				<button
					type="button"
					aria-pressed={favorited}
					aria-label={favorited ? labels.unfavorite : labels.favorite}
					onClick={(event) => {
						// 行本身是跳转，收藏不能顺带触发它。
						event.stopPropagation();
						event.preventDefault();
						onToggleFavorite(round.seq);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					style={{
						display: "grid",
						placeItems: "center",
						width: 20,
						height: 20,
						flexShrink: 0,
						border: "none",
						background: "transparent",
						cursor: "pointer",
						padding: 0,
						color: favorited ? "var(--mantine-color-text)" : "var(--mantine-color-dimmed)",
					}}
				>
					<IconBookmark
						size={14}
						fill={favorited ? "currentColor" : "none"}
						strokeWidth={favorited ? 1.5 : 1.75}
					/>
				</button>
			) : null}
			<span
				style={{
					flexShrink: 0,
					fontSize: "var(--mantine-font-size-xs)",
					fontVariantNumeric: "tabular-nums",
					color: "var(--mantine-color-dimmed)",
				}}
				// span 不支持 aria-label（role 不对）；序号本身已可读，提示交给 title。
				title={`${ordinal} / ${total}`}
			>
				{ordinal}
			</span>
		</div>
	);
}

/** 摘要卡顶边（相对容器）：中线对准那根横条，再夹进视口。 */
function pickerCardTopForRow(
	container: HTMLElement | null,
	tick: HTMLElement | null | undefined,
	cardHeight: number,
): number {
	if (!container || !tick) return 0;
	const containerRect = container.getBoundingClientRect();
	const tickRect = tick.getBoundingClientRect();
	const anchorY = tickRect.top + tickRect.height / 2;
	const top = pickerCardTop(anchorY, cardHeight, 8, window.innerHeight - 8);
	return top - containerRect.top;
}
