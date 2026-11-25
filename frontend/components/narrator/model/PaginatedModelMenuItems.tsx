import { ActionIcon, Button, Group, Menu, Stack, Text, TextInput } from "@mantine/core";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import { IconCheck, IconDotsVertical } from "@tabler/icons-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelOptions } from "../../../hooks/useModelCatalog";
import type { ModelCatalogOption } from "../../../lib/api/model-catalog";
import {
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_PARENT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	type ModelOption,
} from "../../../lib/constants";
import type { ModelMenuItems } from "./ModelMenuItems";

export interface PaginatedModelMenuItemsProps
	extends Partial<ComponentProps<typeof ModelMenuItems>> {
	opened?: boolean;
	currentModel: string | null | undefined;
	onSelect: (value: string) => void;
	onShowPrice?: (model: ModelOption) => void;
	onSetAsDefaultModel?: (value: string) => void;
	onSetAsSummaryModel?: (value: string) => void;
	onEditDefaultModel?: () => void;
	onEditSummaryModel?: () => void;
	defaultModelValue?: string | null;
	summaryModelValue?: string | null;
	canFollowParent?: boolean;
	inheritance?: SubagentModelInheritance | null;
	label?: string;
}

/** The directory is read only while visible; every next/source page requires a gesture. */
export function PaginatedModelMenuItems({
	opened = true,
	currentModel,
	onSelect,
	onShowPrice,
	onSetAsDefaultModel,
	onSetAsSummaryModel,
	onEditDefaultModel,
	onEditSummaryModel,
	defaultModelValue,
	summaryModelValue,
	canFollowParent = false,
	label,
}: PaginatedModelMenuItemsProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const [input, setInput] = useState("");
	const [q, setQ] = useState("");
	const [cursor, setCursor] = useState<string>();
	const [sourceModelId, setSourceModelId] = useState<string>();
	const [actions, setActions] = useState<string>();
	const composing = useRef(false);
	const [composition, setComposition] = useState(false);
	useEffect(() => {
		if (!opened || composition) return;
		const timer = setTimeout(() => {
			setQ(input);
			setCursor(undefined);
		}, 180);
		return () => clearTimeout(timer);
	}, [input, opened, composition]);
	useEffect(() => {
		if (opened) return;
		setCursor(undefined);
		setSourceModelId(undefined);
		setActions(undefined);
	}, [opened]);
	const pendingSearch = input !== q || composition;
	const query = useModelOptions(
		{ q, cursor, sourceModelId, limit: 40, scope: sourceModelId ? "concrete" : "all" },
		opened && !pendingSearch,
	);
	const rows = pendingSearch ? [] : (query.data?.items ?? []);
	const select = (value: string) => onSelect(value);
	const details = (row: ModelCatalogOption) => onShowPrice?.({ ...row });
	return (
		<Stack gap={4} miw={280} maw={480}>
			{label && <Menu.Label>{label}</Menu.Label>}
			<TextInput
				aria-label={t("modelFilterPlaceholder")}
				placeholder={t("modelFilterPlaceholder")}
				value={input}
				maxLength={100}
				onChange={(event) => setInput(event.currentTarget.value)}
				onCompositionStart={() => {
					composing.current = true;
					setComposition(true);
				}}
				onCompositionEnd={(event) => {
					composing.current = false;
					setInput(event.currentTarget.value);
					setComposition(false);
				}}
				onKeyDown={(event) => {
					if (composing.current || event.nativeEvent.isComposing) event.stopPropagation();
				}}
			/>
			{!sourceModelId && !q && (
				<>
					<Menu.Item
						leftSection={
							currentModel === FOLLOW_DEFAULT_MODEL ? <IconCheck size={14} /> : undefined
						}
						onClick={() => select(FOLLOW_DEFAULT_MODEL)}
					>
						{t("followDefault", { model: defaultModelValue ?? "" })}
					</Menu.Item>
					{onEditDefaultModel && (
						<Menu.Item onClick={onEditDefaultModel}>{t("setAsDefaultModel")}</Menu.Item>
					)}
					<Menu.Item
						leftSection={
							currentModel === FOLLOW_SUMMARY_MODEL ? <IconCheck size={14} /> : undefined
						}
						onClick={() => select(FOLLOW_SUMMARY_MODEL)}
					>
						{summaryModelValue || t("modelGroupSummary")}
					</Menu.Item>
					{onEditSummaryModel && (
						<Menu.Item onClick={onEditSummaryModel}>{t("setAsSummaryModel")}</Menu.Item>
					)}
					{canFollowParent && (
						<Menu.Item onClick={() => select(FOLLOW_PARENT_MODEL)}>{t("followParent")}</Menu.Item>
					)}
					<Menu.Divider />
				</>
			)}
			{sourceModelId && (
				<Button
					size="xs"
					variant="subtle"
					onClick={() => {
						setSourceModelId(undefined);
						setCursor(undefined);
					}}
				>
					{tc("back")}
				</Button>
			)}
			{rows.map((row) => (
				<Stack gap={0} key={row.value}>
					<Group gap={0} wrap="nowrap">
						<Menu.Item
							style={{ flex: 1, minWidth: 0 }}
							leftSection={currentModel === row.value ? <IconCheck size={14} /> : undefined}
							onClick={() => select(row.value)}
						>
							<Text size="sm" truncate>
								{row.label}
							</Text>
							{row.provider && (
								<Text size="xs" c="dimmed" truncate>
									{row.provider}
								</Text>
							)}
						</Menu.Item>
						{row.sourceCount != null && row.modelId && (
							<Button
								variant="subtle"
								size="compact-xs"
								onClick={() => {
									setSourceModelId(row.modelId);
									setCursor(undefined);
									setInput("");
									setQ("");
								}}
							>
								{row.sourceCount}
							</Button>
						)}
						{(onShowPrice || onSetAsDefaultModel || onSetAsSummaryModel) && (
							<ActionIcon
								variant="subtle"
								aria-label={t("modelActions")}
								onClick={() => setActions(actions === row.value ? undefined : row.value)}
							>
								<IconDotsVertical size={14} />
							</ActionIcon>
						)}
					</Group>
					{actions === row.value && (
						<Group gap={4} pl="sm">
							{onShowPrice && (
								<Button size="compact-xs" variant="subtle" onClick={() => details(row)}>
									{t("modelTooltip")}
								</Button>
							)}
							{onSetAsDefaultModel && (
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() => onSetAsDefaultModel(row.value)}
								>
									{t("setAsDefaultModel")}
								</Button>
							)}
							{onSetAsSummaryModel && (
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() => onSetAsSummaryModel(row.value)}
								>
									{t("setAsSummaryModel")}
								</Button>
							)}
						</Group>
					)}
				</Stack>
			))}
			{(query.isFetching || pendingSearch) && (
				<Text size="xs" c="dimmed">
					{tc("loading")}
				</Text>
			)}
			{query.error && !pendingSearch && (
				<Stack gap={4}>
					<Text size="xs" c="red" role="alert">
						{query.error.message}
					</Text>
					<Button
						variant="subtle"
						size="xs"
						onClick={() => {
							if (cursor) setCursor(undefined);
							else void query.refetch();
						}}
					>
						{tc("retry")}
					</Button>
				</Stack>
			)}
			{!query.isFetching && !query.error && !pendingSearch && rows.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("noModelMatches")}
				</Text>
			)}
			<Group justify="space-between">
				{cursor && (
					<Button variant="subtle" size="xs" onClick={() => setCursor(undefined)}>
						{tc("back")}
					</Button>
				)}
				{!pendingSearch && query.data?.hasMore && query.data.nextCursor && (
					<Button
						variant="subtle"
						size="xs"
						disabled={query.isFetching}
						onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
					>
						{t("contextComposition.loadMore")}
					</Button>
				)}
			</Group>
		</Stack>
	);
}
