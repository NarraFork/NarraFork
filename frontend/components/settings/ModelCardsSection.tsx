import {
	Accordion,
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Pagination,
	Paper,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
} from "@mantine/core";
import {
	type ModelDefinition,
	type ModelVariant,
	type ResolvedModelMetadata,
	resolveModelMetadata,
} from "@shared/model-catalog";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useCatalogMutation, useCatalogUpdate, useModelCatalog } from "../../hooks/useModelCatalog";
import { resolveCatalogEntry } from "../../lib/model-catalog-view";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { type CatalogEditorTarget, ModelCatalogEditor } from "./ModelCatalogEditor";

export function ModelCardsSection() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const readOnly = user?.role !== "admin";
	const query = useModelCatalog();
	const mutation = useCatalogMutation();
	const update = useCatalogUpdate();
	const confirm = useConfirmDialog();
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const [source, setSource] = useState<string | null>(null);
	const [provider, setProvider] = useState<string | null>(null);
	const [configured, setConfigured] = useState(false);
	const [editor, setEditor] = useState<CatalogEditorTarget | null>(null);
	const [rollbackVersion, setRollbackVersion] = useState<string | null>(null);
	const data = query.data;
	const resolvedCache = useMemo(
		() => ({ data, entries: new Map<string, ResolvedModelMetadata | undefined>() }),
		[data],
	);
	const models = useMemo(
		() => [
			...new Map(
				[...(data?.catalog.models ?? []), ...(data?.local.models ?? [])].map((m) => [m.id, m]),
			).values(),
		],
		[data],
	);
	const variants = useMemo(
		() => [
			...new Map(
				[...(data?.catalog.variants ?? []), ...(data?.local.variants ?? [])].map((v) => [v.id, v]),
			).values(),
		],
		[data],
	);
	const providers = [...new Set(variants.map((v) => v.providerKey))].sort();
	const isLocal = (kind: "model" | "variant", id: string) =>
		(kind === "model" ? data?.local.models : data?.local.variants)?.some(
			(entry) => entry.id === id,
		) ?? false;
	const isHidden = (entry: ModelDefinition | ModelVariant) =>
		"modelId" in entry
			? !!data?.local.hiddenVariantIds?.includes(entry.id) ||
				!!data?.local.hiddenModelIds?.includes(entry.modelId)
			: !!data?.local.hiddenModelIds?.includes(entry.id);
	const hasBinding = (entry: ModelDefinition | ModelVariant) =>
		data?.local.bindings?.some((b) =>
			"modelId" in entry
				? b.variantId === entry.id
				: b.modelId === entry.id ||
					variants.some((v) => v.modelId === entry.id && v.id === b.variantId),
		);
	const matches = (entry: ModelDefinition | ModelVariant) => {
		const kind = "modelId" in entry ? "variant" : "model";
		if (source === "hidden" ? !isHidden(entry) : isHidden(entry)) return false;
		if (source === "local" && !isLocal(kind, entry.id)) return false;
		if (source === "preset" && isLocal(kind, entry.id)) return false;
		if (configured && !hasBinding(entry)) return false;
		if (provider && (!("providerKey" in entry) || entry.providerKey !== provider)) return false;
		return (
			!search.trim() || JSON.stringify(entry).toLowerCase().includes(search.trim().toLowerCase())
		);
	};
	const groups = models
		.map((model) => ({
			model,
			children: variants.filter((v) => v.modelId === model.id && matches(v)),
		}))
		.filter(({ model, children }) => matches(model) || children.length);
	const totalPages = Math.max(1, Math.ceil(groups.length / 30));
	const currentPage = Math.min(page, totalPages);
	const safeResolved = (entry: ModelDefinition | ModelVariant) => {
		if (!resolvedCache.data) return undefined;
		const key = `${"modelId" in entry ? "variant" : "model"}:${entry.id}`;
		if (resolvedCache.entries.has(key)) return resolvedCache.entries.get(key);
		let resolved: ResolvedModelMetadata | undefined;
		try {
			resolved = resolveCatalogEntry(resolvedCache.data, entry);
		} catch {
			/* Keep malformed/archived records inspectable. */
		}
		resolvedCache.entries.set(key, resolved);
		return resolved;
	};
	const openEntry = (entry: ModelDefinition | ModelVariant) =>
		setEditor({
			kind: "modelId" in entry ? "variant" : "model",
			id: entry.id,
			resolved: safeResolved(entry),
		});
	async function remove(entry: ModelDefinition | ModelVariant) {
		if (!data) return;
		const target = "modelId" in entry ? "variant" : "model";
		const action = isLocal(target, entry.id) ? "delete" : isHidden(entry) ? "restore" : "hide";
		if (
			action !== "restore" &&
			!(await confirm({
				message: t("catalog.deleteConfirm", { id: entry.id }),
				confirmLabel: t(`catalog.${action}`),
				confirmColor: "red",
			}))
		)
			return;
		mutation.mutate({ baseRevision: data.local.revision, action, target, targetId: entry.id });
	}
	const display = (value: unknown) =>
		value === undefined
			? t("catalog.unreported")
			: value === null
				? t("catalog.unknown")
				: typeof value === "boolean"
					? t(`catalog.values.${value}`)
					: Array.isArray(value)
						? value.join(", ") || t("catalog.emptyList")
						: value === "0"
							? t("catalog.free")
							: String(value);
	function row(entry: ModelDefinition | ModelVariant) {
		const variant = "modelId" in entry;
		const resolved = safeResolved(entry);
		const metadata = resolved?.metadata;
		const hiddenByParent =
			variant &&
			!!data?.local.hiddenModelIds?.includes(entry.modelId) &&
			!isLocal("variant", entry.id);
		return (
			<Table.Tr key={entry.id}>
				<Table.Td>
					<Button
						variant="subtle"
						size="compact-sm"
						onClick={() => openEntry(entry)}
						styles={{
							label: { whiteSpace: "normal", textAlign: "left" },
							root: { height: "auto", padding: 4 },
						}}
					>
						{variant ? "↳ " : ""}
						{entry.name ?? entry.id}
					</Button>
					<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
						{variant ? entry.providerKey : entry.id}
					</Text>
					{!hasBinding(entry) && (
						<Text size="xs" c="dimmed">
							{t("catalog.metadataOnly")}
						</Text>
					)}
				</Table.Td>
				<Table.Td>
					<Badge size="xs" variant="light">
						{isLocal(variant ? "variant" : "model", entry.id)
							? t("catalog.local")
							: t("catalog.preset")}
					</Badge>
					{data?.local.overrides?.some(
						(override) =>
							override.target === (variant ? "variant" : "model") && override.targetId === entry.id,
					) && (
						<Badge size="xs" variant="outline">
							{t("catalog.localPatch")}
						</Badge>
					)}
					{!resolved && (
						<Text size="xs" c="red">
							{t("catalog.invalid")}
						</Text>
					)}
					<Text size="xs" c="dimmed">
						{entry.status === "verified" ? t("catalog.verified") : t("catalog.unverified")}
					</Text>
				</Table.Td>
				<Table.Td>{display(metadata?.limits?.contextWindow)}</Table.Td>
				<Table.Td>{display(metadata?.modalities?.input)}</Table.Td>
				<Table.Td>{display(metadata?.nativeSearch?.supported)}</Table.Td>
				<Table.Td>
					{metadata?.reasoning?.supported === false
						? display(false)
						: metadata?.reasoning?.levels
							? display(metadata.reasoning.levels)
							: display(metadata?.reasoning?.mode)}
				</Table.Td>
				<Table.Td>
					{display(metadata?.referencePricing?.input)} /{" "}
					{display(metadata?.referencePricing?.output)}
				</Table.Td>
				<Table.Td>
					{!readOnly && (
						<Button
							variant="subtle"
							color={isHidden(entry) ? "blue" : "red"}
							size="compact-xs"
							loading={mutation.isPending}
							disabled={hiddenByParent}
							onClick={() => void remove(entry)}
						>
							{hiddenByParent
								? t("catalog.hiddenByModel")
								: t(
										`catalog.${isLocal(variant ? "variant" : "model", entry.id) ? "delete" : isHidden(entry) ? "restore" : "hide"}`,
									)}
						</Button>
					)}
				</Table.Td>
			</Table.Tr>
		);
	}
	return (
		<Stack>
			<Group justify="space-between">
				<div>
					<Text fw={600}>{t("catalog.title")}</Text>
					<Text size="sm" c="dimmed">
						{t("catalog.description")}
					</Text>
				</div>
				{!readOnly && (
					<Group gap="xs">
						{(["model", "variant", "binding"] as const).map((kind) => (
							<Button
								key={kind}
								variant="light"
								size="xs"
								disabled={!data}
								onClick={() => setEditor({ kind, id: "", isNew: true })}
							>
								{t(`catalog.new_${kind}`)}
							</Button>
						))}
					</Group>
				)}
			</Group>
			{readOnly && <Alert>{t("catalog.readOnly")}</Alert>}
			{query.isPending && <Loader size="sm" />}
			{query.error && (
				<Alert color="red">
					{query.error.message}
					<Button onClick={() => void query.refetch()} variant="subtle">
						{t("catalog.reload")}
					</Button>
				</Alert>
			)}
			{mutation.error && (
				<Alert color="red">
					{t("catalog.operationFailed")}: {mutation.error.message}
				</Alert>
			)}
			{data && (
				<>
					<Accordion>
						<Accordion.Item value="updates">
							<Accordion.Control>
								{t("catalog.updates")} · {data.update.activeVersion}
							</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="sm">
									<Text size="sm">
										{t("catalog.version", {
											active: data.update.activeVersion,
											bundled: data.update.bundledVersion,
										})}
									</Text>
									<Text size="xs" c="dimmed">
										{t("catalog.checked")}: {data.update.lastCheckedAt ?? t("catalog.unknown")}
									</Text>
									<Text size="xs">
										{t("catalog.protected", { count: data.local.overrides?.length ?? 0 })}
									</Text>
									{(data.update.lastError || update.error) && (
										<Alert color="red">{update.error?.message ?? data.update.lastError}</Alert>
									)}
									{data.update.pendingVersion && (
										<Alert>
											{t("catalog.pending")}: {data.update.pendingVersion}
										</Alert>
									)}
									{data.update.pendingDiff &&
										(["added", "changed", "removed"] as const).map((kind) => (
											<Text key={kind} size="xs" style={{ overflowWrap: "anywhere" }}>
												{t(`catalog.${kind}`)} ({data.update.pendingDiff?.[kind].length}):{" "}
												{data.update.pendingDiff?.[kind].join(", ") || "—"}
											</Text>
										))}
									{!!data.update.pendingDiff?.fields?.length && (
										<Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
											<Text size="sm" fw={500}>
												{t("catalog.fieldDiff")}
											</Text>
											{data.update.pendingDiff.fields.map((change) => (
												<Text
													key={`${change.target}:${change.id}:${change.path}`}
													size="xs"
													style={{ overflowWrap: "anywhere" }}
												>
													{change.id} ·{" "}
													{t(`catalog.fields.${change.path.replaceAll(".", "_")}`, {
														defaultValue: change.path,
													})}
													: {display(change.before)} → {display(change.after)}
												</Text>
											))}
										</Stack>
									)}
									<Group>
										<Button
											disabled={readOnly}
											loading={update.isPending}
											onClick={() => update.mutate({ action: "check" })}
										>
											{t("catalog.check")}
										</Button>
										<Button
											disabled={readOnly || !data.update.pendingVersion}
											loading={update.isPending}
											onClick={() =>
												update.mutate({ action: "apply", version: data.update.pendingVersion })
											}
										>
											{t("catalog.apply")}
										</Button>
									</Group>
									<Checkbox
										label={t("catalog.autoApply")}
										checked={data.update.autoApply}
										disabled={readOnly || update.isPending}
										onChange={(e) =>
											update.mutate({ settings: { autoApply: e.currentTarget.checked } })
										}
									/>
									<Checkbox
										label={`${t("catalog.pin")} · ${data.update.pinnedVersion ?? data.update.activeVersion}`}
										checked={data.update.pinnedVersion !== null}
										disabled={readOnly || update.isPending}
										onChange={(e) =>
											update.mutate({
												settings: {
													pinnedVersion: e.currentTarget.checked ? data.update.activeVersion : null,
												},
											})
										}
									/>
									<Group align="end">
										<Select
											label={t("catalog.history")}
											data={[...new Set(data.update.history.map((h) => h.catalogVersion))]}
											value={rollbackVersion}
											onChange={setRollbackVersion}
										/>
										<Button
											disabled={readOnly || !rollbackVersion}
											loading={update.isPending}
											onClick={() => {
												if (rollbackVersion)
													update.mutate({ action: "rollback", version: rollbackVersion });
											}}
										>
											{t("catalog.rollback")}
										</Button>
									</Group>
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>
					<Group align="end">
						<TextInput
							label={t("catalog.search")}
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
							style={{ flex: "1 1 200px" }}
						/>
						<Select
							label={t("catalog.source")}
							clearable
							data={["preset", "local", "hidden"].map((value) => ({
								value,
								label: t(`catalog.${value}`),
							}))}
							value={source}
							onChange={setSource}
						/>
						<Select
							label={t("catalog.providerKey")}
							clearable
							searchable
							data={providers}
							value={provider}
							onChange={setProvider}
						/>
						<Checkbox
							label={t("catalog.configured")}
							checked={configured}
							onChange={(e) => setConfigured(e.currentTarget.checked)}
						/>
					</Group>
					{!groups.length ? (
						<Text c="dimmed">{t("catalog.empty")}</Text>
					) : (
						<Paper withBorder p="xs">
							<Table.ScrollContainer minWidth={750}>
								<Table verticalSpacing="xs">
									<Table.Thead>
										<Table.Tr>
											{[
												"name",
												"source",
												"window",
												"inputModalities",
												"searchSupport",
												"reasoning",
												"reference",
												"actions",
											].map((key) => (
												<Table.Th key={key}>{t(`catalog.${key}`)}</Table.Th>
											))}
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{groups
											.slice((currentPage - 1) * 30, currentPage * 30)
											.map(({ model, children }) => (
												<CatalogGroup
													key={model.id}
													model={model}
													variants={children}
													renderRow={row}
													forceExpanded={!!search.trim() || !!provider || source === "hidden"}
												/>
											))}
									</Table.Tbody>
								</Table>
							</Table.ScrollContainer>
						</Paper>
					)}
					{totalPages > 1 && (
						<Pagination total={totalPages} value={currentPage} onChange={setPage} size="sm" />
					)}
					{!!data.local.bindings?.length && (
						<Accordion>
							<Accordion.Item value="bindings">
								<Accordion.Control>
									{t("catalog.bindings")} ({data.local.bindings.length})
								</Accordion.Control>
								<Accordion.Panel>
									<Stack gap="xs">
										{data.local.bindings.map((binding) => (
											<Group key={binding.id} justify="space-between">
												<Button
													variant="subtle"
													onClick={() => {
														let resolved: ResolvedModelMetadata | undefined;
														try {
															resolved = resolveModelMetadata({
																catalog: data.catalog,
																local: data.local,
																query: binding,
															});
														} catch {
															/* Archived/hidden identities remain inspectable. */
														}
														setEditor({
															kind: "binding",
															id: binding.id,
															resolved,
															query: binding,
														});
													}}
												>
													{binding.id} · {binding.providerId ?? binding.channelId} ·{" "}
													{binding.upstreamModelId}
												</Button>
												{!readOnly && (
													<Button
														color="red"
														variant="subtle"
														size="compact-xs"
														onClick={async () => {
															if (
																await confirm({
																	message: t("catalog.deleteConfirm", { id: binding.id }),
																	confirmLabel: t("catalog.delete"),
																	confirmColor: "red",
																})
															)
																mutation.mutate({
																	baseRevision: data.local.revision,
																	action: "delete",
																	target: "binding",
																	targetId: binding.id,
																});
														}}
													>
														{t("catalog.delete")}
													</Button>
												)}
											</Group>
										))}
									</Stack>
								</Accordion.Panel>
							</Accordion.Item>
						</Accordion>
					)}
				</>
			)}
			{editor && data && (
				<ModelCatalogEditor
					key={`${editor.kind}:${editor.id}:${editor.isNew}`}
					target={editor}
					snapshot={data}
					readOnly={readOnly}
					onClose={() => setEditor(null)}
				/>
			)}
		</Stack>
	);
}

function CatalogGroup({
	model,
	variants,
	renderRow,
	forceExpanded,
}: {
	model: ModelDefinition;
	variants: ModelVariant[];
	renderRow: (entry: ModelDefinition | ModelVariant) => React.ReactNode;
	forceExpanded: boolean;
}) {
	const { t } = useTranslation("settings");
	const [expanded, setExpanded] = useState(false);
	return (
		<>
			{renderRow(model)}
			{variants.length > 0 && (
				<Table.Tr>
					<Table.Td colSpan={8}>
						<Button
							size="compact-xs"
							variant="subtle"
							disabled={forceExpanded}
							onClick={() => setExpanded(!expanded)}
						>
							{expanded || forceExpanded ? "−" : "+"}{" "}
							{t("catalog.variants", { count: variants.length })}
						</Button>
					</Table.Td>
				</Table.Tr>
			)}
			{(expanded || forceExpanded) && variants.map(renderRow)}
		</>
	);
}
