import {
	Accordion,
	Alert,
	Badge,
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import type {
	FieldSource,
	ModelBinding,
	ModelCatalogSnapshot,
	ModelQuery,
	ResolvedModelMetadata,
} from "@shared/model-catalog";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	invalidateModelCatalog,
	useCatalogMutation,
	useResolvedModelCard,
} from "../../hooks/useModelCatalog";
import { ApiError } from "../../lib/api/client";
import { Z } from "../../lib/z-index";
import { ModelCardDetails } from "./ModelCardDetails";
import {
	buildCatalogPatch,
	type CatalogEdits,
	catalogFields,
	fieldText,
	metadataFromPatch,
	metadataValue,
} from "./model-catalog-form";

export interface CatalogEditorTarget {
	kind: "model" | "variant" | "binding";
	id: string;
	isNew?: boolean;
	modelId?: string;
	variantId?: string;
	query?: ModelQuery;
	resolved?: ResolvedModelMetadata;
}

export function CatalogMetadataFields({
	resolved,
	edits,
	onChange,
	readOnly,
}: {
	resolved?: ResolvedModelMetadata;
	edits: CatalogEdits;
	onChange: (edits: CatalogEdits) => void;
	readOnly: boolean;
}) {
	const { t } = useTranslation("settings");
	return (
		<Accordion multiple defaultValue={["capabilities"]}>
			{["capabilities", "prices"].map((section) => (
				<Accordion.Item key={section} value={section}>
					<Accordion.Control>{t(`catalog.${section}`)}</Accordion.Control>
					<Accordion.Panel>
						<Stack gap="md">
							{section === "prices" && (
								<Text size="xs" c="dimmed">
									{t("catalog.priceNote")}
								</Text>
							)}
							{catalogFields
								.filter((field) => field.section === section)
								.map((field) => {
									const edit = edits[field.path];
									const effective = metadataValue(resolved?.metadata ?? {}, field.path);
									const source: FieldSource | undefined = resolved?.provenance[field.path];
									const value = edit?.mode === "set" ? edit.value : fieldText(effective);
									const setValue = (next: string) =>
										onChange({ ...edits, [field.path]: { mode: "set", value: next } });
									const options =
										field.kind === "boolean"
											? ["true", "false"]
											: field.kind === "mode"
												? ["levels", "fixed", "budget", "unknown"]
												: field.kind === "longMode"
													? ["full", "marginal"]
													: null;
									const label = t(`catalog.fields.${field.path.replaceAll(".", "_")}`);
									return (
										<Stack key={field.path} gap={4} data-catalog-field={field.path}>
											<Group justify="space-between">
												<Text size="sm">{label}</Text>
												{edit && <Badge size="xs">{t(`catalog.${edit.mode}`)}</Badge>}
											</Group>
											<Text size="xs" c="dimmed">
												{t("catalog.effective")}:{" "}
												{effective === undefined
													? t("catalog.unreported")
													: effective === null
														? t("catalog.unknown")
														: typeof effective === "boolean"
															? t(`catalog.values.${effective}`)
															: Array.isArray(effective) && !effective.length
																? t("catalog.emptyList")
																: effective === "0" && field.kind === "price"
																	? t("catalog.free")
																	: fieldText(effective)}{" "}
												·{" "}
												{source
													? `${t(`catalog.layers.${source.layer}`)}${source.id ? ` · ${source.id}` : ""}`
													: t("catalog.unreported")}
												{source?.legacy ? ` · ${t("catalog.legacy")}` : ""}
											</Text>
											{options ? (
												<Select
													aria-label={label}
													data={options.map((v) => ({ value: v, label: t(`catalog.values.${v}`) }))}
													value={value || null}
													disabled={readOnly || (!!edit && edit.mode !== "set")}
													onChange={(next) => {
														if (next !== null) setValue(next);
													}}
												/>
											) : (
												<TextInput
													aria-label={label}
													value={value}
													placeholder={
														field.kind === "list" || field.kind === "modalities"
															? t("catalog.listHint")
															: t("catalog.valueHint")
													}
													disabled={readOnly || (!!edit && edit.mode !== "set")}
													onChange={(event) => setValue(event.currentTarget.value)}
												/>
											)}
											{!readOnly && (
												<Group gap="xs">
													<Button
														size="compact-xs"
														variant="subtle"
														onClick={() =>
															onChange({ ...edits, [field.path]: { mode: "unknown" } })
														}
													>
														{t("catalog.unknown")}
													</Button>
													<Button
														size="compact-xs"
														variant="subtle"
														onClick={() => onChange({ ...edits, [field.path]: { mode: "reset" } })}
													>
														{t("catalog.reset")}
													</Button>
													{edit && (
														<Button
															size="compact-xs"
															variant="subtle"
															onClick={() => {
																const next = { ...edits };
																delete next[field.path];
																onChange(next);
															}}
														>
															{t("catalog.undo")}
														</Button>
													)}
												</Group>
											)}
										</Stack>
									);
								})}
						</Stack>
					</Accordion.Panel>
				</Accordion.Item>
			))}
		</Accordion>
	);
}

/** Snapshot revision is captured on open, not silently rebased after a background refetch. */
export function ModelCatalogEditor({
	target,
	snapshot,
	readOnly,
	onClose,
}: {
	target: CatalogEditorTarget;
	snapshot: ModelCatalogSnapshot;
	readOnly: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const mutation = useCatalogMutation();
	const qc = useQueryClient();
	// Snapshot and actual-resolution queries may finish in either order. Never authorize
	// a stale effective view with the newer revision from the other query.
	const [baseRevision] = useState(
		Math.min(snapshot.local.revision, target.resolved?.localRevision ?? snapshot.local.revision),
	);
	// A new entry has no stored identity to resolve a card for yet.
	const card = useResolvedModelCard(
		target.isNew
			? undefined
			: (target.query ??
					(target.kind === "variant"
						? { upstreamModelId: target.id, variantId: target.id, modelId: target.modelId }
						: { upstreamModelId: target.id, modelId: target.id })),
	);
	const [edits, setEdits] = useState<CatalogEdits>({});
	const [id, setId] = useState(target.id);
	const [name, setName] = useState("");
	const [modelId, setModelId] = useState(target.modelId ?? target.resolved?.modelId ?? "");
	const [variantId, setVariantId] = useState(target.variantId ?? target.resolved?.variantId ?? "");
	const [providerKey, setProviderKey] = useState(target.query?.providerKey ?? "");
	const [providerId, setProviderId] = useState(target.query?.providerId ?? "");
	const [channelId, setChannelId] = useState(target.query?.channelId ?? "");
	const [upstream, setUpstream] = useState(target.query?.upstreamModelId ?? "");
	const [validationError, setValidationError] = useState("");
	const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
	const models = [
		...new Map(
			[...snapshot.catalog.models, ...(snapshot.local.models ?? [])].map((m) => [m.id, m]),
		).values(),
	];
	const variants = [
		...new Map(
			[...snapshot.catalog.variants, ...(snapshot.local.variants ?? [])].map((v) => [v.id, v]),
		).values(),
	];
	const localBinding = snapshot.local.bindings?.find((b) => b.id === target.id);
	const record =
		target.kind === "model"
			? models.find((m) => m.id === target.id)
			: target.kind === "variant"
				? variants.find((v) => v.id === target.id)
				: localBinding;
	const affected = variants.filter((v) => v.modelId === target.id).length;
	async function save() {
		setValidationError("");
		try {
			const patch = buildCatalogPatch(edits);
			if (!target.isNew) {
				if (!patch) {
					onClose();
					return;
				}
				await mutation.mutateAsync({
					baseRevision,
					action: "patch",
					target: target.kind,
					targetId: target.id,
					patch,
				});
			} else {
				if (!id.trim()) throw new Error(t("catalog.id"));
				const existingIds =
					target.kind === "model"
						? models
						: target.kind === "variant"
							? variants
							: (snapshot.local.bindings ?? []);
				if (existingIds.some((entry) => entry.id === id.trim()))
					throw new Error(t("catalog.duplicateId"));
				const metadata = metadataFromPatch(patch);
				if (target.kind === "model")
					await mutation.mutateAsync({
						baseRevision,
						action: "upsert-model",
						model: { id: id.trim(), name: name.trim() || undefined, metadata },
					});
				else if (target.kind === "variant") {
					if (!modelId || !providerKey.trim() || !upstream.trim())
						throw new Error(t("catalog.bindingRequired"));
					await mutation.mutateAsync({
						baseRevision,
						action: "upsert-variant",
						variant: {
							id: id.trim(),
							modelId,
							providerKey: providerKey.trim(),
							upstreamModelIds: upstream
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
							name: name.trim() || undefined,
							metadata,
						},
					});
				} else {
					if (!upstream.trim() || (!providerId.trim() && !channelId.trim()))
						throw new Error(t("catalog.bindingRequired"));
					const binding: ModelBinding = {
						id: id.trim(),
						upstreamModelId: upstream.trim(),
						...(providerId.trim() ? { providerId: providerId.trim() } : {}),
						...(channelId.trim() ? { channelId: channelId.trim() } : {}),
						...(variantId ? { variantId } : modelId ? { modelId } : {}),
						overrides: metadata,
					};
					await mutation.mutateAsync({ baseRevision, action: "upsert-binding", binding });
				}
			}
			onClose();
		} catch (error) {
			if (!(error instanceof ApiError))
				setValidationError(
					`${t("catalog.invalid")}: ${error instanceof Error ? error.message : String(error)}`,
				);
		}
	}
	return (
		<Modal
			opened
			onClose={onClose}
			title={`${t(`catalog.${target.kind}`)} · ${target.isNew ? t("catalog.create") : target.id}`}
			size="lg"
			centered
			zIndex={Z.modal + 1}
		>
			<Stack>
				{readOnly && <Alert>{t("catalog.readOnly")}</Alert>}
				{target.kind === "model" && !target.isNew && (
					<Alert>{t("catalog.affects", { count: affected })}</Alert>
				)}
				{target.isNew ? (
					<Stack gap="xs">
						<TextInput
							label={t("catalog.id")}
							value={id}
							onChange={(e) => setId(e.currentTarget.value)}
							required
							disabled={readOnly}
						/>
						{target.kind !== "binding" && (
							<TextInput
								label={t("catalog.name")}
								value={name}
								onChange={(e) => setName(e.currentTarget.value)}
								disabled={readOnly}
							/>
						)}
						{target.kind !== "model" && (
							<Select
								label={t("catalog.model")}
								searchable
								clearable
								data={models.map((m) => ({ value: m.id, label: m.name ?? m.id }))}
								value={modelId || null}
								onChange={(value) => {
									setModelId(value ?? "");
									setVariantId("");
								}}
								disabled={readOnly}
							/>
						)}
						{target.kind === "binding" && (
							<Select
								label={t("catalog.variant")}
								searchable
								clearable
								data={variants
									.filter((v) => !modelId || v.modelId === modelId)
									.map((v) => ({ value: v.id, label: v.name ?? v.id }))}
								value={variantId || null}
								onChange={(value) => setVariantId(value ?? "")}
								disabled={readOnly}
							/>
						)}
						{target.kind === "variant" && (
							<TextInput
								label={t("catalog.providerKey")}
								value={providerKey}
								onChange={(e) => setProviderKey(e.currentTarget.value)}
								required
								disabled={readOnly}
							/>
						)}
						{target.kind !== "model" && (
							<TextInput
								label={t("catalog.upstream")}
								value={upstream}
								onChange={(e) => setUpstream(e.currentTarget.value)}
								required
								disabled={readOnly}
							/>
						)}
						{target.kind === "binding" && (
							<>
								<TextInput
									label={t("catalog.providerId")}
									value={providerId}
									onChange={(e) => setProviderId(e.currentTarget.value)}
									disabled={readOnly}
								/>
								<TextInput
									label={t("catalog.channelId")}
									value={channelId}
									onChange={(e) => setChannelId(e.currentTarget.value)}
									disabled={readOnly}
								/>
							</>
						)}
					</Stack>
				) : (
					<Text size="sm" c="dimmed">
						{t("catalog.patchHint")}
					</Text>
				)}
				<CatalogMetadataFields
					resolved={target.resolved}
					edits={edits}
					onChange={setEdits}
					readOnly={readOnly || mutation.isPending || conflict}
				/>
				{/* Read-only complete card next to the editable v1 fields: the editor writes
				    only what v1 can express, so the full source view must not look editable. */}
				{card.data && (
					<Accordion>
						<Accordion.Item value="card">
							<Accordion.Control>{t("catalog.details")}</Accordion.Control>
							<Accordion.Panel>
								<ModelCardDetails card={card.data} />
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>
				)}
				<Accordion>
					<Accordion.Item value="advanced">
						<Accordion.Control>{t("catalog.advanced")}</Accordion.Control>
						<Accordion.Panel>
							<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
								{JSON.stringify(record ?? target.query ?? {}, null, 2)}
							</Text>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
				{validationError && <Alert color="red">{validationError}</Alert>}
				{mutation.error && (
					<Alert color="red">
						{conflict ? t("catalog.conflict") : mutation.error.message}
						{conflict && (
							<Button
								variant="subtle"
								onClick={() => {
									void invalidateModelCatalog(qc);
								}}
							>
								{t("catalog.reload")}
							</Button>
						)}
					</Alert>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("catalog.close")}
					</Button>
					{!readOnly && (
						<Button onClick={() => void save()} loading={mutation.isPending} disabled={conflict}>
							{t("catalog.save")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
