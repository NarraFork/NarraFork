/**
 * 导出配置 + 轮次选择：一个弹窗里把这次导出要说清的事都说完。
 *
 * 与详情页共用同一份状态（格式、工具详情、更早历史、范围都是受控的），所以弹窗里改
 * 什么、外面就变什么，不存在"应用/取消"两套值。
 *
 * 轮次列表与导出共用同一个 `scope`，列出来的轮次就是这份导出里真实存在的轮次。
 */
import {
	Box,
	Checkbox,
	Collapse,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Select,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	expandTurnRange,
	formatTurnRange,
	parseTurnRange,
	rangesFromTurns,
} from "../../../../shared/export-turn-range";
import { api } from "../../../lib/api";
import { TurnRangeInput } from "./TurnRangeInput";

/** 一次渲染多少轮；长会话先渲染一屏，按需再展开。 */
const TURN_PAGE_SIZE = 200;

export function TurnRangePickerModal({
	opened,
	onClose,
	narratorId,
	format,
	onFormatChange,
	includeToolIO,
	onIncludeToolIOChange,
	fullHistory,
	onFullHistoryChange,
	range,
	onRangeChange,
}: {
	opened: boolean;
	onClose: () => void;
	narratorId: string;
	format: "markdown" | "json";
	onFormatChange: (value: "markdown" | "json") => void;
	includeToolIO: boolean;
	onIncludeToolIOChange: (value: boolean) => void;
	fullHistory: boolean;
	onFullHistoryChange: (value: boolean) => void;
	range: string;
	onRangeChange: (value: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const scope = fullHistory ? "full" : "visible";
	const { data, isLoading, isError } = useQuery({
		queryKey: ["narrator-export-turns", narratorId, scope],
		queryFn: () => api.getNarratorExportTurns(narratorId, scope),
		enabled: opened,
		// 弹窗反复开关不该重复走一遍轮次扫描。
		staleTime: 5 * 60_000,
	});
	const turns = data?.turns ?? [];
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const [visibleCount, setVisibleCount] = useState(TURN_PAGE_SIZE);
	const lastPicked = useRef<number | null>(null);

	// 选中集合就是范围串：输入框与勾选列表改的是同一份状态。
	const selected = useMemo(
		() => expandTurnRange(parseTurnRange(range) ?? []) ?? new Set<number>(),
		[range],
	);
	const shown = turns.slice(0, visibleCount);

	const writeSelection = (next: Set<number>) => {
		onRangeChange(formatTurnRange(rangesFromTurns(next)));
	};

	const toggleTurn = (turn: number, shiftKey: boolean) => {
		const next = new Set(selected);
		const anchor = lastPicked.current;
		if (shiftKey && anchor !== null) {
			const from = Math.min(anchor, turn);
			const to = Math.max(anchor, turn);
			for (let index = from; index <= to; index += 1) next.add(index);
		} else if (next.has(turn)) {
			next.delete(turn);
		} else {
			next.add(turn);
		}
		lastPicked.current = turn;
		writeSelection(next);
	};

	const toggleExpanded = (turn: number) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(turn)) next.delete(turn);
			else next.add(turn);
			return next;
		});
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("details.exportRangePickerTitle")} size="lg">
			<Stack gap="sm">
				<Group grow align="flex-start">
					<Select
						label={t("details.exportFormat")}
						data={[
							{ value: "markdown", label: t("details.exportFormatMarkdown") },
							{ value: "json", label: t("details.exportFormatJson") },
						]}
						value={format}
						onChange={(value) => onFormatChange(value === "json" ? "json" : "markdown")}
						allowDeselect={false}
					/>
					<Box pt={22}>
						<Checkbox
							label={t("details.exportIncludeToolIO")}
							checked={includeToolIO}
							onChange={(event) => onIncludeToolIOChange(event.currentTarget.checked)}
						/>
					</Box>
				</Group>
				<Checkbox
					label={t("details.exportFullHistory")}
					description={t("details.exportFullHistoryDescription")}
					checked={fullHistory}
					onChange={(event) => onFullHistoryChange(event.currentTarget.checked)}
				/>

				<TurnRangeInput value={range} onChange={onRangeChange} />

				<Divider />

				<Group justify="space-between">
					<Text size="xs" c="dimmed">
						{t("details.exportRangeSelected", { count: selected.size })}
					</Text>
					<Group gap="xs">
						<UnstyledButton onClick={() => writeSelection(new Set(turns.map((item) => item.turn)))}>
							<Text size="xs" c="indigo">
								{t("details.exportRangeSelectAll")}
							</Text>
						</UnstyledButton>
						<UnstyledButton onClick={() => writeSelection(new Set())}>
							<Text size="xs" c="dimmed">
								{t("details.exportRangeClear")}
							</Text>
						</UnstyledButton>
					</Group>
				</Group>

				{isLoading ? (
					<Group justify="center" py="lg">
						<Loader size="sm" />
					</Group>
				) : isError ? (
					<Text size="sm" c="red">
						{t("details.exportRangeLoadFailed")}
					</Text>
				) : turns.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("details.exportRangeEmpty")}
					</Text>
				) : (
					<ScrollArea.Autosize mah={360} type="auto">
						<Stack gap={6}>
							{shown.map((item) => {
								const open = expanded.has(item.turn);
								return (
									<Stack key={item.turn} gap={2}>
										<Checkbox
											checked={selected.has(item.turn)}
											readOnly
											// Shift 点选一段轮次，和文件列表里的区间选择一致。
											onClick={(event) => toggleTurn(item.turn, event.shiftKey)}
											label={
												<Text size="sm" lineClamp={2}>
													<Text span fw={600}>{`#${item.turn} `}</Text>
													{item.userPreview || t("details.exportRangeNoUserMessage")}
												</Text>
											}
										/>
										{item.assistantPreview ? (
											<Box pl={26}>
												{/* 整行可点：小字按钮在深色行里太难命中。 */}
												<UnstyledButton
													onClick={() => toggleExpanded(item.turn)}
													aria-expanded={open}
													aria-label={
														open ? t("details.exportRangeCollapse") : t("details.exportRangeExpand")
													}
												>
													<Group gap={4} wrap="nowrap">
														{open ? (
															<IconChevronDown size={12} color="var(--mantine-color-dimmed)" />
														) : (
															<IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
														)}
														<Text size="xs" c="dimmed">
															{open
																? t("details.exportRangeCollapse")
																: t("details.exportRangeExpand")}
														</Text>
													</Group>
												</UnstyledButton>
												<Collapse expanded={open}>
													<Text size="xs" c="dimmed" pt={4} style={{ whiteSpace: "pre-wrap" }}>
														{item.assistantPreview}
													</Text>
												</Collapse>
											</Box>
										) : null}
									</Stack>
								);
							})}
						</Stack>
					</ScrollArea.Autosize>
				)}

				{visibleCount < turns.length ? (
					<UnstyledButton onClick={() => setVisibleCount((n) => n + TURN_PAGE_SIZE)}>
						<Text size="xs" c="indigo">
							{t("details.exportRangeLoadMore")}
						</Text>
					</UnstyledButton>
				) : null}
				{data?.truncated ? (
					<Text size="xs" c="dimmed">
						{t("details.exportRangeTruncated")}
					</Text>
				) : null}

				<Group justify="flex-end">
					<Text size="xs" c="dimmed" style={{ flex: 1 }}>
						{formatTurnRange(rangesFromTurns(selected)) || t("details.exportRangePlaceholder")}
					</Text>
					<UnstyledButton onClick={onClose}>
						<Text size="sm" fw={600} c="indigo">
							{t("details.exportRangeDone")}
						</Text>
					</UnstyledButton>
				</Group>
			</Stack>
		</Modal>
	);
}
