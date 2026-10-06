import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Code,
	type ComboboxItemGroup,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";
import type { BrokenModelGroup } from "../../lib/api/narrators";
import {
	brokenModelGroupId,
	canConfirmMigration,
	defaultSelectedNarratorIds,
	groupSelectionState,
	toggleGroupSelection,
} from "./broken-model-selection";

const MODEL_SELECT_OPTION_LIMIT = 100;
const NARRATOR_LIST_MAX_HEIGHT = 260;
const NARRATOR_PREVIEW_LIMIT = 20;

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

export interface BrokenModelMigrationModalProps {
	opened: boolean;
	onClose: () => void;
}

/**
 * Bulk-migrate narrators whose persisted model can no longer run.
 *
 * `provider_missing` groups are pre-selected because that breakage is certain.
 * `model_not_listed` groups start unselected: the model is merely absent from the
 * catalog, which a pass-through gateway can still serve, so the user decides.
 */
export function BrokenModelMigrationModal({ opened, onClose }: BrokenModelMigrationModalProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { groupedModels } = useAllModels();
	const [targetModel, setTargetModel] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [lastResult, setLastResult] = useState<{ migrated: number; skipped: number } | null>(null);

	const scan = useQuery({
		queryKey: ["broken-model-narrators"],
		queryFn: () => api.scanBrokenModelNarrators(),
		enabled: opened,
	});

	// Pre-select the definitely-broken narrators whenever a fresh scan arrives.
	useEffect(() => {
		if (!scan.data) return;
		setSelectedIds(defaultSelectedNarratorIds(scan.data.groups));
	}, [scan.data]);

	const migrate = useMutation({
		mutationFn: (payload: { targetModel: string; narratorIds: string[] }) =>
			api.migrateBrokenModelNarrators(payload),
		onSuccess: async (result) => {
			setLastResult({ migrated: result.migrated, skipped: result.skipped });
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["broken-model-narrators"] }),
				qc.invalidateQueries({ queryKey: ["narrators"] }),
			]);
		},
	});

	const undo = useMutation({
		mutationFn: () => api.undoBrokenModelMigration(),
		onSuccess: async () => {
			setLastResult(null);
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["broken-model-narrators"] }),
				qc.invalidateQueries({ queryKey: ["narrators"] }),
			]);
		},
	});

	const toggleGroup = useCallback((group: BrokenModelGroup, checked: boolean) => {
		setSelectedIds((prev) => toggleGroupSelection(prev, group, checked));
	}, []);

	const handleMigrate = useCallback(() => {
		if (!targetModel) return;
		migrate.mutate({ targetModel, narratorIds: [...selectedIds] });
	}, [targetModel, selectedIds, migrate]);

	const modelOptions = groupedModels as ModelComboboxItemGroup[];
	const groups = scan.data?.groups ?? [];
	const undoAvailable = scan.data?.undoAvailable === true;
	const totalSelected = selectedIds.size;

	const groupState = useMemo(
		() => groups.map((group) => ({ group, ...groupSelectionState(group, selectedIds) })),
		[groups, selectedIds],
	);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("brokenModelMigrationTitle")}
			centered
			size="lg"
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("brokenModelMigrationDesc")}
				</Text>

				{scan.isLoading && <Loader size="sm" />}
				{scan.isError && <Alert color="red">{t("brokenModelMigrationScanFailed")}</Alert>}

				{scan.data && groups.length === 0 && (
					<Alert color="green">{t("brokenModelMigrationNoneFound")}</Alert>
				)}

				{scan.data?.truncated && <Alert color="yellow">{t("brokenModelMigrationTruncated")}</Alert>}

				{groups.length > 0 && (
					<ScrollArea.Autosize mah={NARRATOR_LIST_MAX_HEIGHT}>
						<Stack gap="sm">
							{groupState.map(({ group, allSelected, someSelected }) => (
								<Stack key={brokenModelGroupId(group)} gap={4}>
									<Group gap="xs" wrap="nowrap">
										<Checkbox
											checked={allSelected}
											indeterminate={someSelected}
											onChange={(event) => toggleGroup(group, event.currentTarget.checked)}
											label={group.providerPrefix ?? t("brokenModelMigrationNoPrefix")}
										/>
										<Badge size="sm" color={group.reason === "provider_missing" ? "red" : "yellow"}>
											{group.reason === "provider_missing"
												? t("brokenModelReasonProviderMissing")
												: t("brokenModelReasonModelNotListed")}
										</Badge>
										<Text size="xs" c="dimmed">
											{t("brokenModelMigrationGroupCount", { count: group.narrators.length })}
										</Text>
									</Group>
									{group.reason === "model_not_listed" && (
										<Text size="xs" c="dimmed">
											{t("brokenModelMigrationMaybeUsableHint")}
										</Text>
									)}
									<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
										{group.narrators
											.slice(0, NARRATOR_PREVIEW_LIMIT)
											.map((n) => `${n.title || n.id} — ${n.model}`)
											.join("\n")}
										{group.narrators.length > NARRATOR_PREVIEW_LIMIT
											? `\n… +${group.narrators.length - NARRATOR_PREVIEW_LIMIT}`
											: ""}
									</Code>
								</Stack>
							))}
						</Stack>
					</ScrollArea.Autosize>
				)}

				{groups.length > 0 && (
					<Select
						label={t("brokenModelMigrationTargetModel")}
						data={modelOptions}
						searchable
						limit={MODEL_SELECT_OPTION_LIMIT}
						value={targetModel}
						onChange={setTargetModel}
					/>
				)}

				{migrate.isError && (
					<Alert color="red">
						{migrate.error instanceof Error
							? migrate.error.message
							: t("brokenModelMigrationFailed")}
					</Alert>
				)}

				{lastResult && (
					<Alert color="green">
						{t("brokenModelMigrationDone", {
							migrated: lastResult.migrated,
							skipped: lastResult.skipped,
						})}
					</Alert>
				)}

				<Text size="xs" c="dimmed">
					{t("brokenModelMigrationUndoHint")}
				</Text>

				<Group justify="space-between">
					<Button
						variant="default"
						disabled={!undoAvailable}
						loading={undo.isPending}
						onClick={() => undo.mutate()}
					>
						{t("brokenModelMigrationUndo")}
					</Button>
					<Button
						onClick={handleMigrate}
						disabled={!canConfirmMigration(targetModel, totalSelected)}
						loading={migrate.isPending}
					>
						{t("brokenModelMigrationConfirm", { count: totalSelected })}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
