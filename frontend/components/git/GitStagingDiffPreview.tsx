import {
	ActionIcon,
	Button,
	Checkbox,
	Group,
	Loader,
	Menu,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import type {
	GitStagingDiff,
	GitStagingFile,
	GitStagingList,
	GitStagingUnit,
} from "@shared/git-staging-lists";
import type { GitStagingObservationState } from "@shared/git-workspace-events";
import { IconArrowRight, IconChevronDown, IconListDetails, IconRefresh } from "@tabler/icons-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	type GitStagingController,
	GitStagingGuardError,
	useGitStagingDiff,
} from "../../hooks/useGitStagingLists";
import { ApiError } from "../../lib/api/client";
import type { GitTarget } from "../../lib/api/git";
import { type GitPatchUnitActions, GitPatchView } from "./GitPatchView";
import classes from "./GitPatchView.module.css";
import { gitStagingListDisplayName } from "./git-staging-list-display";

type Selection = { owner: string; ids: string[] };
type Carry = {
	generation: number;
	observationId: string | null;
	ids: string[];
	observation: GitStagingObservationState;
};

function MoveMenu({
	lists,
	sourceId,
	disabled,
	label,
	onMove,
	children,
}: {
	lists: GitStagingList[];
	sourceId: string;
	disabled: boolean;
	label: string;
	onMove: (destinationId: string) => void;
	children?: ReactNode;
}) {
	const { t } = useTranslation("git");
	const [opened, setOpened] = useState(false);
	const targetProps = {
		"data-mantine-stop-propagation": opened || undefined,
		onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
			if (event.key === "Escape" && opened) {
				event.preventDefault();
				event.stopPropagation();
				setOpened(false);
			}
		},
	};
	return (
		<Menu
			opened={opened}
			onChange={setOpened}
			withinPortal
			closeOnItemClick={false}
			position="bottom-end"
		>
			<Menu.Target>
				{children ? (
					<Button
						{...targetProps}
						size="compact-xs"
						disabled={disabled}
						rightSection={<IconChevronDown size={13} />}
						data-git-staging-batch-menu
					>
						{children}
					</Button>
				) : (
					<ActionIcon
						{...targetProps}
						className={classes.unitAction}
						size={26}
						variant="subtle"
						disabled={disabled}
						aria-label={label}
						title={label}
						data-git-staging-unit-menu
					>
						<IconChevronDown size={14} />
					</ActionIcon>
				)}
			</Menu.Target>
			<Menu.Dropdown data-git-staging-unit-targets>
				{lists.map((destination) => (
					<Menu.Item
						key={destination.id}
						disabled={disabled || destination.id === sourceId}
						data-git-staging-target={destination.id}
						onClick={() => onMove(destination.id)}
					>
						{gitStagingListDisplayName(destination, t)}
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}

/** Owns one persistent code preview; ownership writes never replace its editor surface. */
export function GitStagingDiffPreview({
	target,
	staging,
	list,
	file,
	onEmpty,
	localizeError,
}: {
	target: GitTarget;
	staging: GitStagingController;
	list: GitStagingList;
	file: GitStagingFile;
	onEmpty: () => void;
	localizeError: (error: Error | null) => Error | null;
}) {
	const { t } = useTranslation("git");
	const { summary, mutation } = staging;
	const query = useGitStagingDiff(target, summary, list, file);
	const version = JSON.stringify([
		staging.scopeKey,
		staging.selectionKey,
		summary?.generation,
		summary?.observationId,
		list.snapshotVersion,
		target.canWrite,
		staging.refused,
	]);
	const retained = useRef<GitStagingDiff | undefined>(undefined);
	if (query.data && !query.error && query.data.snapshotVersion === list.snapshotVersion)
		retained.current = query.data;
	const data = query.data ?? retained.current;
	const fresh =
		!!query.data &&
		query.data.snapshotVersion === list.snapshotVersion &&
		!query.isFetching &&
		!query.error;
	const [selection, setSelection] = useState<Selection>({ owner: version, ids: [] });
	const [carry, setCarry] = useState<Carry | null>(null);
	const [showAllUnits, setShowAllUnits] = useState(false);
	const writeLock = useRef(false);
	const retired = useRef<string | null>(null);
	const latest = useRef({ version, summary, list, writable: false });
	const writable =
		staging.writable &&
		fresh &&
		!!staging.version &&
		retired.current !== version &&
		(summary?.state === "ready" || summary?.state === "conflict");
	latest.current = { version, summary, list, writable };
	const unitById = useMemo(
		() => new Map(data?.units.map((unit) => [unit.id, unit]) ?? []),
		[data?.units],
	);
	const unitIndices = useMemo(
		() => new Map(data?.units.map((unit, index) => [unit.id, index + 1]) ?? []),
		[data?.units],
	);
	const selectedIds = useMemo(
		() => (selection.owner === version ? selection.ids.filter((id) => unitById.has(id)) : []),
		[selection, version, unitById],
	);
	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
	const previousVersion = useRef(version);
	useLayoutEffect(() => {
		if (previousVersion.current !== version) {
			previousVersion.current = version;
			if (!writeLock.current) setSelection({ owner: version, ids: [] });
		}
		if (!carry || !fresh || carry.generation > (summary?.generation ?? -1)) return;
		const observed = staging.observation;
		if (
			observed &&
			(observed.instanceId !== carry.observation.instanceId ||
				observed.epoch > carry.observation.epoch)
		) {
			setCarry(null);
			return;
		}
		if (!writable || !observed || observed.epoch !== carry.observation.epoch) return;
		if (carry.generation === summary?.generation && carry.observationId === summary.observationId) {
			setSelection({
				owner: version,
				ids: carry.ids.filter((id) => unitById.has(id)),
			});
		}
		setCarry(null);
	}, [
		version,
		carry,
		fresh,
		summary?.generation,
		summary?.observationId,
		unitById,
		writable,
		staging.observation,
	]);
	useLayoutEffect(() => {
		if (
			(fresh && query.data?.units.length === 0) ||
			(query.error instanceof ApiError && query.error.status === 404)
		)
			onEmpty();
	}, [fresh, query.data, query.error, onEmpty]);

	function move(ids: string[], destinationId: string) {
		if (
			!writable ||
			!latest.current.writable ||
			writeLock.current ||
			latest.current.version !== version ||
			!staging.version ||
			!ids.length ||
			!data
		)
			return;
		const unique = [...new Set(ids)];
		if (!unique.every((id) => unitById.has(id))) return;
		if (!summary?.lists.some((entry) => entry.id === destinationId)) return;
		if (destinationId === list.id) return;
		writeLock.current = true;
		const preserved = selectedIds;
		mutation.mutate(
			{
				action: "move",
				fromListId: list.id,
				toListId: destinationId,
				unitIds: unique,
				...staging.version,
			},
			{
				onSuccess: (result) => {
					if (result.observation)
						setCarry({
							generation: result.generation,
							observationId: result.observationId,
							ids: preserved,
							observation: result.observation,
						});
					else setSelection({ owner: latest.current.version, ids: [] });
				},
				onError: (error) => {
					if (
						error instanceof GitStagingGuardError ||
						(error instanceof ApiError && [401, 403, 409].includes(error.status))
					) {
						retired.current = version;
						setSelection({ owner: version, ids: [] });
					}
				},
				onSettled: () => {
					writeLock.current = false;
				},
			},
		);
	}
	function toggle(id: string, checked: boolean) {
		if (!writable) return;
		setSelection({
			owner: version,
			ids: checked
				? [...new Set([...selectedIds, id])]
				: selectedIds.filter((value) => value !== id),
		});
	}
	const active = summary?.lists.find((entry) => entry.id === summary.activeListId);
	const unitActions: GitPatchUnitActions | undefined = data
		? {
				units: data.units,
				mappings: data.unitMappings,
				selectedIds,
				showAll: showAllUnits,
				render: (unit: GitStagingUnit, inline: boolean) => {
					const index = unitIndices.get(unit.id) ?? 0;
					const range =
						unit.kind === "text"
							? `${t("staging.unitRange", { start: unit.workStart + 1, end: Math.max(unit.workStart + 1, unit.workEnd) })} +${unit.added} −${unit.removed}`
							: t(`staging.unit.${unit.kind}`);
					const moveLabel = active
						? t("staging.moveUnitToList", { name: gitStagingListDisplayName(active, t) })
						: "";
					return (
						<div
							className={classes.unitControls}
							data-git-staging-unit={unit.id}
							data-inline={inline || undefined}
							data-selected={selectedSet.has(unit.id) || undefined}
						>
							<Checkbox
								size="xs"
								classNames={{
									root: classes.unitSelect,
									body: classes.unitSelectBody,
									inner: classes.unitSelectInner,
									input: classes.unitSelectInput,
								}}
								disabled={!writable}
								checked={selectedSet.has(unit.id)}
								aria-label={t("staging.selectUnit", { index, range })}
								data-git-staging-unit-select={unit.id}
								onChange={(event) => toggle(unit.id, event.currentTarget.checked)}
							/>
							{!inline && (
								<Text size="xs" ff="monospace" truncate style={{ flex: 1 }} title={range}>
									{range}
								</Text>
							)}
							{active && active.id !== unit.listId ? (
								<Tooltip label={moveLabel}>
									<ActionIcon
										className={classes.unitAction}
										size={26}
										variant="subtle"
										disabled={!writable}
										aria-label={moveLabel}
										title={moveLabel}
										data-git-staging-unit-active={unit.id}
										onClick={() => move([unit.id], active.id)}
									>
										<IconArrowRight size={15} />
									</ActionIcon>
								</Tooltip>
							) : (
								<span style={{ width: 26 }} />
							)}
							<MoveMenu
								key={version}
								lists={summary?.lists ?? []}
								sourceId={list.id}
								disabled={!writable}
								label={t("staging.moveUnitOther", { index })}
								onMove={(destinationId) => move([unit.id], destinationId)}
							/>
						</div>
					);
				},
			}
		: undefined;
	return (
		<Stack
			gap="xs"
			data-git-staging-preview
			data-git-staging-preview-version={version}
			data-git-staging-preview-ready={fresh || undefined}
			data-git-staging-preview-writable={writable || undefined}
			aria-busy={mutation.isPending || query.isFetching}
		>
			{data && (
				<Group
					gap="xs"
					wrap="nowrap"
					className={classes.previewToolbar}
					data-git-staging-preview-toolbar
				>
					<Checkbox
						size="xs"
						aria-label={t("staging.selectAllUnits")}
						disabled={!writable}
						checked={data.units.length > 0 && selectedIds.length === data.units.length}
						indeterminate={selectedIds.length > 0 && selectedIds.length < data.units.length}
						onChange={(event) => {
							if (writable)
								setSelection({
									owner: version,
									ids: event.currentTarget.checked ? data.units.map((unit) => unit.id) : [],
								});
						}}
					/>
					<MoveMenu
						key={version}
						lists={summary?.lists ?? []}
						sourceId={list.id}
						disabled={!writable || !selectedIds.length}
						label={t("staging.moveToList")}
						onMove={(destinationId) => move(selectedIds, destinationId)}
					>
						{t("staging.moveSelected", { count: selectedIds.length })}
					</MoveMenu>
					<Tooltip label={t("staging.allUnits")}>
						<ActionIcon
							variant={showAllUnits ? "light" : "subtle"}
							aria-label={t("staging.allUnits")}
							aria-pressed={showAllUnits}
							data-git-staging-show-units
							onClick={() => setShowAllUnits((value) => !value)}
						>
							<IconListDetails size={16} />
						</ActionIcon>
					</Tooltip>
					{(query.isFetching || mutation.isPending) && <Loader size="xs" />}
					{(query.error || retired.current === version) && (
						<ActionIcon
							variant="subtle"
							aria-label={t("workspace.retry")}
							disabled={
								mutation.isPending || query.isFetching || !target.canWrite || staging.refused
							}
							onClick={async () => {
								setSelection({ owner: version, ids: [] });
								await staging.refresh();
								const result = await query.refetch();
								if (!result.error) {
									retired.current = null;
									setSelection({ owner: latest.current.version, ids: [] });
								}
							}}
						>
							<IconRefresh size={15} />
						</ActionIcon>
					)}
				</Group>
			)}
			{mutation.error && (
				<Text c="red" size="xs" role="alert">
					{localizeError(mutation.error)?.message}
				</Text>
			)}
			{query.error && data && (
				<Text c="red" size="xs" role="alert">
					{localizeError(query.error)?.message}
				</Text>
			)}
			<GitPatchView
				diff={data?.diff}
				truncated={data?.truncated}
				file={file.path}
				resetKey={`${staging.displayScope}:${list.id}:${file.fileId}`}
				loading={!data && query.isLoading}
				error={data ? null : localizeError(query.error)}
				unitActions={unitActions}
			/>
		</Stack>
	);
}
