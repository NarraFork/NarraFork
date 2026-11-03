import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ModelDescription } from "@shared/model-catalog/schema/api";
import { IconPencil, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useCatalogStatus,
	useCatalogUpdate,
	useModelDescriptions,
} from "../../hooks/useModelCatalog";
import { useAllModels } from "../../hooks/useModels";
import { formatCompactNumber } from "../../lib/compact-number";
import { formatLocaleDate, formatLocaleDateTime } from "../../lib/intl-format";
import { ModelOverrideEditor, OriginBadge } from "./ModelOverrideEditor";

function CatalogStatusCard() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const status = useCatalogStatus();
	const update = useCatalogUpdate();
	const run = (input: Parameters<typeof update.mutate>[0]) =>
		update.mutate(input, {
			onSuccess: (next) => {
				if ("action" in input && input.action === "check" && !next.lastError && !next.pending)
					notifications.show({ message: t("catalog.upToDate") });
			},
			onError: (error) => notifications.show({ message: error.message, color: "red" }),
		});
	const data = status.data;
	if (!data) return status.isLoading ? <Loader size="sm" /> : null;
	return (
		<Card withBorder padding="md">
			<Stack gap="xs">
				<Group justify="space-between" wrap="wrap" gap="xs">
					<Group gap={6}>
						<Text size="sm">
							{t("catalog.version", {
								version: data.version,
								date: formatLocaleDate(data.publishedAt, { dateStyle: "medium" }),
								count: data.models,
							})}
						</Text>
						<Badge size="xs" variant="light" color={data.source === "builtin" ? "gray" : "blue"}>
							{t(`catalog.source.${data.source}`)}
						</Badge>
					</Group>
					<Group gap="xs">
						<Switch
							size="sm"
							label={t("catalog.autoUpdate")}
							checked={data.autoUpdate}
							disabled={!isAdmin || update.isPending}
							onChange={(event) => run({ autoUpdate: event.currentTarget.checked })}
						/>
						{isAdmin && (
							<Button
								size="xs"
								variant="light"
								loading={update.isPending}
								onClick={() => run({ action: "check" })}
							>
								{t("catalog.checkNow")}
							</Button>
						)}
					</Group>
				</Group>
				{data.lastCheckedAt && (
					<Text size="xs" c="dimmed">
						{t("catalog.lastChecked", {
							time: formatLocaleDateTime(data.lastCheckedAt, {
								dateStyle: "medium",
								timeStyle: "short",
							}),
						})}
					</Text>
				)}
				{data.pending && (
					<Alert color="blue" variant="light">
						<Group justify="space-between" gap="xs">
							<Text size="sm">
								{t("catalog.pending", {
									added: data.pending.added,
									changed: data.pending.changed,
								})}
							</Text>
							{isAdmin && (
								<Button size="xs" onClick={() => run({ action: "apply" })}>
									{t("catalog.apply")}
								</Button>
							)}
						</Group>
					</Alert>
				)}
				{data.lastError && (
					<Text size="xs" c="red">
						{t("catalog.updateFailed", { error: data.lastError })}
					</Text>
				)}
				{isAdmin && data.source === "downloaded" && (
					<Group>
						<Button
							size="xs"
							variant="subtle"
							color="gray"
							onClick={() => run({ action: "restore-builtin" })}
						>
							{t("catalog.restoreBuiltin")}
						</Button>
					</Group>
				)}
			</Stack>
		</Card>
	);
}

function tokens(value: number | undefined): string {
	return value === undefined ? "—" : formatCompactNumber(value).compact;
}

function customized(info: ModelDescription | undefined): boolean {
	return !!info && (!!info.connectionOverride || !!info.modelOverride);
}

/** The catalog's state, and every configured model with what is in effect for it. */
export function ModelCatalogSection() {
	const { t } = useTranslation("settings");
	const { visibleModels } = useAllModels();
	const [search, setSearch] = useState("");
	const [onlyCustomized, setOnlyCustomized] = useState(false);
	const [editing, setEditing] = useState<string>();
	const values = useMemo(
		() => [...new Set(visibleModels.map((model) => model.value).filter((v) => v.includes(":")))],
		[visibleModels],
	);
	const descriptions = useModelDescriptions(values);
	const query = search.trim().toLowerCase();
	const rows = values
		.map((value, index) => ({ value, info: descriptions[index]?.data }))
		.filter(
			({ value, info }) =>
				(!query ||
					value.toLowerCase().includes(query) ||
					info?.catalogName?.toLowerCase().includes(query)) &&
				(!onlyCustomized || customized(info)),
		);
	return (
		<Stack gap="md">
			<Stack gap={4}>
				<Title order={4}>{t("catalog.title")}</Title>
				<Text size="sm" c="dimmed">
					{t("catalog.description")}
				</Text>
			</Stack>
			<CatalogStatusCard />
			<Group justify="space-between" gap="xs">
				<TextInput
					size="xs"
					leftSection={<IconSearch size={14} />}
					placeholder={t("catalog.search")}
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
					w={260}
				/>
				<Switch
					size="xs"
					label={t("catalog.onlyCustomized")}
					checked={onlyCustomized}
					onChange={(event) => setOnlyCustomized(event.currentTarget.checked)}
				/>
			</Group>
			{values.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("catalog.noModels")}
				</Text>
			) : (
				<ScrollArea type="auto">
					<Table striped highlightOnHover verticalSpacing={6} miw={720}>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("catalog.col.model")}</Table.Th>
								<Table.Th>{t("catalog.col.context")}</Table.Th>
								<Table.Th>{t("catalog.col.output")}</Table.Th>
								<Table.Th>{t("catalog.col.reasoning")}</Table.Th>
								<Table.Th>{t("catalog.col.price")}</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{rows.map(({ value, info }) => {
								const window = info?.effective.contextWindow;
								const prices = info?.effective.prices?.value;
								return (
									<Table.Tr
										key={value}
										style={{ cursor: "pointer" }}
										onClick={() => setEditing(value)}
									>
										<Table.Td>
											<Stack gap={0}>
												<Text size="sm" ff="monospace">
													{value}
												</Text>
												<Group gap={4}>
													<Text size="xs" c="dimmed">
														{info
															? (info.catalogName ?? info.catalogModelId ?? t("catalog.unmatched"))
															: "…"}
													</Text>
													{customized(info) && (
														<Badge size="xs" variant="light" color="blue">
															{t("catalog.customized")}
														</Badge>
													)}
												</Group>
											</Stack>
										</Table.Td>
										<Table.Td>
											<Group gap={4} wrap="nowrap">
												<Text size="sm">{tokens(window?.value)}</Text>
												{window && window.origin !== "catalog" && (
													<OriginBadge origin={window.origin} />
												)}
											</Group>
										</Table.Td>
										<Table.Td>
											<Text size="sm">{tokens(info?.effective.maxOutputTokens?.value)}</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">
												{info?.effective.reasoningLevels?.value.join(" · ") || "—"}
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">
												{prices?.input !== undefined || prices?.output !== undefined
													? `$${prices?.input ?? "—"} / $${prices?.output ?? "—"}`
													: "—"}
											</Text>
										</Table.Td>
										<Table.Td>
											<Tooltip label={t("catalog.edit")}>
												<IconPencil size={14} />
											</Tooltip>
										</Table.Td>
									</Table.Tr>
								);
							})}
						</Table.Tbody>
					</Table>
				</ScrollArea>
			)}
			<ModelOverrideEditor
				model={editing}
				opened={editing !== undefined}
				onClose={() => setEditing(undefined)}
			/>
		</Stack>
	);
}
