import { useProjects } from "@frontend/hooks/useProjects";
import { RUN_VERDICTS, type ScheduledTaskSearch } from "@frontend/lib/scheduled-task-search";
import {
	Button,
	Drawer,
	Group,
	Popover,
	SegmentedControl,
	Select,
	Stack,
	TextInput,
} from "@mantine/core";
import { IconFilter, IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function TaskFilters({
	search,
	onChange,
	mobile = false,
}: {
	search: ScheduledTaskSearch;
	onChange: (values: Partial<ScheduledTaskSearch>) => void;
	mobile?: boolean;
}) {
	const { t } = useTranslation("scheduledTasks");
	const [opened, setOpened] = useState(false);
	const [query, setQuery] = useState(search.q ?? "");
	useEffect(() => {
		setQuery((current) => (current.trim() === (search.q ?? "") ? current : (search.q ?? "")));
	}, [search.q]);
	const activeCount = [
		search.projectId,
		search.kind,
		search.result,
		search.runContext,
		search.owner,
		search.creator === "user",
	].filter(Boolean).length;
	const advanced = <AdvancedFilters search={search} onChange={onChange} />;
	return (
		<Stack gap="sm">
			<TextInput
				leftSection={<IconSearch size={16} />}
				aria-label={t("search")}
				placeholder={t("search")}
				maxLength={500}
				value={query}
				onChange={(event) => {
					setQuery(event.currentTarget.value);
					onChange({ q: event.currentTarget.value || undefined });
				}}
			/>
			<Group justify="space-between" gap="xs">
				<SegmentedControl
					size="xs"
					fullWidth={mobile}
					value={search.lifecycle ?? "active"}
					onChange={(value) =>
						onChange({
							lifecycle:
								value === "active" ? undefined : (value as ScheduledTaskSearch["lifecycle"]),
						})
					}
					data={[
						{ value: "active", label: t("filter.active") },
						{ value: "ended", label: t("filter.ended") },
						{ value: "all", label: t("filter.all") },
						...(search.lifecycle === "paused"
							? [{ value: "paused", label: t("lifecycle.paused") }]
							: []),
					]}
				/>
				<Group gap="xs">
					<Button
						size="compact-xs"
						color="orange"
						variant={search.attention ? "filled" : "light"}
						onClick={() => onChange({ attention: search.attention ? undefined : true })}
					>
						{t("filter.attention")}
					</Button>
					<Button
						size="compact-xs"
						variant={search.creator === "mine" ? "filled" : "light"}
						onClick={() => onChange({ creator: search.creator === "mine" ? undefined : "mine" })}
					>
						{t("filter.mine")}
					</Button>
					<Button
						size="compact-xs"
						variant={search.creator === "narrator" ? "filled" : "light"}
						onClick={() =>
							onChange({ creator: search.creator === "narrator" ? undefined : "narrator" })
						}
					>
						{t("filter.narrator")}
					</Button>
				</Group>
			</Group>
			<Group justify="space-between" gap="xs">
				{mobile ? (
					<>
						<Button
							size="xs"
							variant="default"
							leftSection={<IconFilter size={14} />}
							onClick={() => setOpened(true)}
						>
							{t("advancedFilters")}
							{activeCount ? ` (${activeCount})` : ""}
						</Button>
						<Drawer
							opened={opened}
							onClose={() => setOpened(false)}
							title={t("advancedFilters")}
							position="bottom"
							size="auto"
						>
							{advanced}
						</Drawer>
					</>
				) : (
					<Popover width={320} position="bottom-start" withinPortal>
						<Popover.Target>
							<Button size="xs" variant="default" leftSection={<IconFilter size={14} />}>
								{t("advancedFilters")}
								{activeCount ? ` (${activeCount})` : ""}
							</Button>
						</Popover.Target>
						<Popover.Dropdown>{advanced}</Popover.Dropdown>
					</Popover>
				)}
				<Select
					size="xs"
					aria-label={t("sortLabel")}
					value={search.sort ?? "nextRun"}
					data={["nextRun", "lastRun", "createdAt", "name"].map((value) => ({
						value,
						label: t(`sort.${value}`),
					}))}
					onChange={(value) =>
						onChange({
							sort: value === "nextRun" ? undefined : (value as ScheduledTaskSearch["sort"]),
						})
					}
				/>
			</Group>
		</Stack>
	);
}

function AdvancedFilters({
	search,
	onChange,
}: {
	search: ScheduledTaskSearch;
	onChange: (values: Partial<ScheduledTaskSearch>) => void;
}) {
	const { t } = useTranslation("scheduledTasks");
	const projects = useProjects();
	return (
		<Stack gap="sm">
			<Select
				label={t("project")}
				placeholder={t("any")}
				searchable
				clearable
				data={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))}
				value={search.projectId ?? null}
				error={projects.isError ? t("projectsLoadFailed") : undefined}
				onChange={(value) => onChange({ projectId: value ?? undefined })}
				comboboxProps={{ withinPortal: false }}
			/>
			<Select
				label={t("creator")}
				placeholder={t("any")}
				clearable
				value={search.creator ?? null}
				data={["mine", "user", "narrator"].map((value) => ({ value, label: t(`filter.${value}`) }))}
				onChange={(value) =>
					onChange({ creator: (value as ScheduledTaskSearch["creator"]) || undefined })
				}
				comboboxProps={{ withinPortal: false }}
			/>
			<TextInput
				label={t("ownerUserId")}
				value={search.owner ?? ""}
				onChange={(event) => onChange({ owner: event.currentTarget.value || undefined })}
			/>
			<Select
				label={t("scheduleKind")}
				placeholder={t("any")}
				clearable
				value={search.kind ?? null}
				data={["at", "repeat", "cron"].map((value) => ({ value, label: t(`kind.${value}`) }))}
				onChange={(value) =>
					onChange({ kind: (value as ScheduledTaskSearch["kind"]) || undefined })
				}
				comboboxProps={{ withinPortal: false }}
			/>
			<Select
				label={t("latestResult")}
				placeholder={t("any")}
				clearable
				value={search.result ?? null}
				data={RUN_VERDICTS.map((value) => ({ value, label: t(`verdict.${value}`) }))}
				onChange={(value) =>
					onChange({ result: (value as ScheduledTaskSearch["result"]) || undefined })
				}
				comboboxProps={{ withinPortal: false }}
			/>
			<Select
				label={t("runContext")}
				placeholder={t("any")}
				clearable
				value={search.runContext ?? null}
				data={[
					{ value: "standalone", label: t("ctxStandalone") },
					{ value: "project", label: t("ctxProject") },
				]}
				onChange={(value) =>
					onChange({ runContext: (value as ScheduledTaskSearch["runContext"]) || undefined })
				}
				comboboxProps={{ withinPortal: false }}
			/>
		</Stack>
	);
}
