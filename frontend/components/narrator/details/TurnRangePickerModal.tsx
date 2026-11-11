/**
 * 导出范围选择器：按轮勾选历史消息。
 *
 * 与导出共用同一个 `scope`，所以这里列出的轮次就是"将要导出的那份内容"里的轮次，
 * 不会出现选中了却导不出来的情况。
 */
import {
	Button,
	Checkbox,
	Collapse,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	expandTurnRange,
	formatTurnRange,
	parseTurnRange,
	rangesFromTurns,
	type TurnRange,
} from "../../../../shared/export-turn-range";
import { api } from "../../../lib/api";

/** 一次渲染多少轮；长会话先渲染一屏，按需再展开。 */
const TURN_PAGE_SIZE = 200;

export function TurnRangePickerModal({
	opened,
	onClose,
	narratorId,
	scope,
	initialRanges,
	onConfirm,
}: {
	opened: boolean;
	onClose: () => void;
	narratorId: string;
	scope: "full" | "visible";
	initialRanges: readonly TurnRange[];
	onConfirm: (ranges: TurnRange[]) => void;
}) {
	const { t } = useTranslation("narrator");
	const { data, isLoading, isError } = useQuery({
		queryKey: ["narrator-export-turns", narratorId, scope],
		queryFn: () => api.getNarratorExportTurns(narratorId, scope),
		enabled: opened,
		staleTime: 30_000,
	});
	const turns = useMemo(() => data?.turns ?? [], [data]);
	const [selected, setSelected] = useState<Set<number>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const [visibleCount, setVisibleCount] = useState(TURN_PAGE_SIZE);
	const lastPicked = useRef<number | null>(null);
	// 用字符串做依赖：父组件传进来的数组每次渲染都是新引用，直接依赖会反复重置选择。
	const initialKey = formatTurnRange(initialRanges);

	// 每次打开都从外部传入的范围重建选择，不保留上次的临时勾选。
	useEffect(() => {
		if (!opened) return;
		setSelected(expandTurnRange(parseTurnRange(initialKey) ?? []) ?? new Set());
		setExpanded(new Set());
		setVisibleCount(TURN_PAGE_SIZE);
		lastPicked.current = null;
	}, [opened, initialKey]);

	const toggleTurn = (turn: number, shiftKey: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			const anchor = lastPicked.current;
			if (shiftKey && anchor !== null) {
				const from = Math.min(anchor, turn);
				const to = Math.max(anchor, turn);
				for (let index = from; index <= to; index += 1) next.add(index);
				return next;
			}
			if (next.has(turn)) next.delete(turn);
			else next.add(turn);
			return next;
		});
		lastPicked.current = turn;
	};

	const toggleExpanded = (turn: number) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(turn)) next.delete(turn);
			else next.add(turn);
			return next;
		});
	};

	const shown = turns.slice(0, visibleCount);

	return (
		<Modal opened={opened} onClose={onClose} title={t("details.exportRangePickerTitle")} size="lg">
			<Stack gap="sm">
				<Group justify="space-between">
					<Text size="xs" c="dimmed">
						{t("details.exportRangeSelected", { count: selected.size })}
					</Text>
					<Group gap="xs">
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={() => setSelected(new Set(turns.map((item) => item.turn)))}
						>
							{t("details.exportRangeSelectAll")}
						</Button>
						<Button size="compact-xs" variant="subtle" onClick={() => setSelected(new Set())}>
							{t("details.exportRangeClear")}
						</Button>
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
					<ScrollArea.Autosize mah={420} type="auto">
						<Stack gap={4}>
							{shown.map((item) => (
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
										<>
											<Button
												size="compact-xs"
												variant="subtle"
												onClick={() => toggleExpanded(item.turn)}
											>
												{expanded.has(item.turn)
													? t("details.exportRangeCollapse")
													: t("details.exportRangeExpand")}
											</Button>
											<Collapse expanded={expanded.has(item.turn)}>
												<Text size="xs" c="dimmed" pl="lg" style={{ whiteSpace: "pre-wrap" }}>
													{item.assistantPreview}
												</Text>
											</Collapse>
										</>
									) : null}
								</Stack>
							))}
						</Stack>
					</ScrollArea.Autosize>
				)}

				{visibleCount < turns.length ? (
					<Button
						size="compact-sm"
						variant="light"
						onClick={() => setVisibleCount((n) => n + TURN_PAGE_SIZE)}
					>
						{t("details.exportRangeLoadMore")}
					</Button>
				) : null}
				{data?.truncated ? (
					<Text size="xs" c="dimmed">
						{t("details.exportRangeTruncated")}
					</Text>
				) : null}

				<Group justify="flex-end">
					<Button variant="default" size="xs" onClick={onClose}>
						{t("common:cancel")}
					</Button>
					<Button
						size="xs"
						onClick={() => {
							onConfirm(rangesFromTurns(selected));
							onClose();
						}}
					>
						{t("details.exportRangeApply")}
					</Button>
				</Group>
				<Text size="xs" c="dimmed">
					{formatTurnRange(rangesFromTurns(selected)) || t("details.exportRangePlaceholder")}
				</Text>
			</Stack>
		</Modal>
	);
}
