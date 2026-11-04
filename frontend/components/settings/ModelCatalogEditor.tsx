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
import type { ModelCard } from "@shared/model-catalog/card";
import type { ModelCardSnapshot } from "@shared/model-catalog/schema/api";
import type { FieldSource, ModelQuery, RawBinding } from "@shared/model-catalog/schema/catalog";
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
import { ProviderWindowOverrides } from "../providers/ContextWindowField";
import {
	COMMAND_CODE_PROTOCOL_OPTIONS,
	ModelProtocolSelect,
	modelProtocolLabel,
} from "../providers/ModelProtocolSelect";
import type { CustomApiProtocol } from "../providers/types";
import { ModelCardDetails } from "./ModelCardDetails";
import {
	buildCatalogPatch,
	type CatalogEdits,
	catalogFields,
	fieldOptions,
	fieldText,
	metadataFromPatch,
} from "./model-catalog-form";

export interface CatalogEditorTarget {
	kind: "model" | "variant" | "binding";
	id: string;
	isNew?: boolean;
	modelId?: string;
	variantId?: string;
	query?: ModelQuery;
	/** The resolved card the editor opened on; its revision authorizes the write. */
	card?: ModelCard;
}

/**
 * 模型级协议覆盖的读写入口。
 *
 * 协议分两层：provider 层（`settings.agent.modelProtocols`，设置页模型行写的）与本地覆盖层
 * （`settings.agent.modelProtocolOverrides`，本对话框单独保存的，优先级更高）。两层都不在
 * catalog 快照里、也不参与 revision 校验，因此由调用方负责读写；不传该项时编辑器不显示协议字段。
 */
export interface ModelProtocolDraft {
	/** 作用对象：带前缀的完整模型 ID，例如 `CommandCode:deepseek/deepseek-v4.1-flash`。 */
	modelValue: string;
	/** 本层已保存的覆盖；`null` 表示本层没有覆盖，跟随继承。 */
	value: CustomApiProtocol | null;
	/** 继承来的值（provider 层写的协议）；本层覆盖被删除后由它生效。 */
	inheritedValue: CustomApiProtocol | null;
	/** `null` 表示删除本层覆盖（恢复继承），否则写入本层。 */
	onSave: (protocol: CustomApiProtocol | null) => Promise<void>;
}

export function CatalogMetadataFields({
	card,
	edits,
	onChange,
	readOnly,
}: {
	card?: ModelCard;
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
									const edit = edits[field.key];
									const effective = card?.metadata[field.key];
									const source: FieldSource | undefined = card?.provenance[field.key];
									const value =
										edit?.mode === "set" ? edit.value : fieldText(effective, field.kind);
									const setValue = (next: string) =>
										onChange({ ...edits, [field.key]: { mode: "set", value: next } });
									const options = fieldOptions[field.kind] ?? null;
									const label = t(`catalog.fields.${field.key}`, { defaultValue: field.key });
									return (
										<Stack key={field.key} gap={4} data-catalog-field={field.key}>
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
																: Number(effective) === 0 && field.kind === "price"
																	? t("catalog.free")
																	: fieldText(effective, field.kind)}{" "}
												·{" "}
												{source
													? `${t(`catalog.layers.${source.layer}`)}${source.id ? ` · ${source.id}` : ""}`
													: t("catalog.unreported")}
												{source?.legacy ? ` · ${t("catalog.legacy")}` : ""}
											</Text>
											{options ? (
												<Select
													aria-label={label}
													comboboxProps={EDITOR_COMBOBOX_PROPS}
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
														field.kind === "toolModes"
															? t("catalog.toolModesHint")
															: field.kind === "list" || field.kind === "modalities"
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
														onClick={() => onChange({ ...edits, [field.key]: { mode: "unknown" } })}
													>
														{t("catalog.unknown")}
													</Button>
													<Button
														size="compact-xs"
														variant="subtle"
														onClick={() => onChange({ ...edits, [field.key]: { mode: "reset" } })}
													>
														{t("catalog.reset")}
													</Button>
													{edit && (
														<Button
															size="compact-xs"
															variant="subtle"
															onClick={() => {
																const next = { ...edits };
																delete next[field.key];
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
/**
 * 本编辑器的 Modal 被显式抬到 `Z.modal + 1`（它可能嵌在价格弹窗之类更高的浮层里），
 * 而 Mantine 的 Select 下拉默认停在 popover 层(300) —— 不抬高就会被自己的 Modal 盖住，
 * 表现为「下拉点不开 / 选不了」。这里比 Modal 再高一层；Modal 用默认层级的场景不受影响。
 */
const EDITOR_COMBOBOX_PROPS = { withinPortal: true, zIndex: Z.modal + 2 } as const;

export function ModelCatalogEditor({
	target,
	snapshot,
	readOnly,
	onClose,
	protocol,
}: {
	target: CatalogEditorTarget;
	snapshot: ModelCardSnapshot;
	readOnly: boolean;
	onClose: () => void;
	/** 协议字段（可选）：模型级覆盖，与 catalog 快照分开保存。 */
	protocol?: ModelProtocolDraft;
}) {
	const { t } = useTranslation("settings");
	const mutation = useCatalogMutation();
	const qc = useQueryClient();
	// Snapshot and actual-resolution queries may finish in either order. Never authorize
	// a stale effective view with the newer revision from the other query.
	const [baseRevision] = useState(
		Math.min(snapshot.local.revision, target.card?.localRevision ?? snapshot.local.revision),
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
	const [modelId, setModelId] = useState(target.modelId ?? target.card?.modelId ?? "");
	const [variantId, setVariantId] = useState(target.variantId ?? target.card?.variantId ?? "");
	const [providerKey, setProviderKey] = useState(target.query?.providerKey ?? "");
	// 「编辑此连接覆盖」只剩协议：连接范围与上游标识的输入框已注释，这两个 setter 暂时没有入口。
	const [providerId, _setProviderId] = useState(target.query?.providerId ?? "");
	const [channelId, _setChannelId] = useState(target.query?.channelId ?? "");
	const [upstream, setUpstream] = useState(target.query?.upstreamModelId ?? "");
	const [protocolDraft, setProtocolDraft] = useState<CustomApiProtocol | null>(
		protocol?.value ?? null,
	);
	const protocolChanged = !!protocol && protocolDraft !== (protocol.value ?? null);
	/** 最终生效的协议：本层覆盖优先，其次继承 provider 层。 */
	const effectiveProtocol = protocolDraft ?? protocol?.inheritedValue ?? null;
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
			// 协议不属于 catalog 快照，先单独落库；它没有 revision 冲突语义。
			if (protocol && protocolChanged) await protocol.onSave(protocolDraft);
			// 「编辑此连接覆盖」现在只保留协议：连接标识与模型资料不再从入口编辑，
			// 也就不再需要 id/upstream 那些校验。
			if (target.kind === "binding") {
				onClose();
				return;
			}
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
					const binding: RawBinding = {
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
				{target.isNew && target.kind !== "binding" ? (
					<Stack gap="xs">
						<TextInput
							label={t("catalog.id")}
							value={id}
							onChange={(e) => setId(e.currentTarget.value)}
							required
							disabled={readOnly}
						/>
						<TextInput
							label={t("catalog.name")}
							value={name}
							onChange={(e) => setName(e.currentTarget.value)}
							disabled={readOnly}
						/>
						{target.kind !== "model" && (
							<Select
								label={t("catalog.model")}
								searchable
								clearable
								comboboxProps={EDITOR_COMBOBOX_PROPS}
								data={models.map((m) => ({ value: m.id, label: m.name ?? m.id }))}
								value={modelId || null}
								onChange={(value) => {
									setModelId(value ?? "");
									setVariantId("");
								}}
								disabled={readOnly}
							/>
						)}
						{/*
						{target.kind === "binding" && (
							<Select
								label={t("catalog.variant")}
								searchable
								clearable
								comboboxProps={EDITOR_COMBOBOX_PROPS}
								data={variants
									.filter((v) => !modelId || v.modelId === modelId)
									.map((v) => ({ value: v.id, label: v.name ?? v.id }))}
								value={variantId || null}
								onChange={(value) => setVariantId(value ?? "")}
								disabled={readOnly}
							/>
						)}
						*/}
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
						{/*
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
						*/}
					</Stack>
				) : (
					<Text size="sm" c="dimmed">
						{target.kind === "binding" ? t("catalog.protocolOnlyHint") : t("catalog.patchHint")}
					</Text>
				)}
				{protocol && (
					<Stack gap={4} data-catalog-field="protocol">
						<Group justify="space-between">
							<Text size="sm">{t("catalog.protocol")}</Text>
							{protocolDraft !== null && <Badge size="xs">{t("catalog.set")}</Badge>}
						</Group>
						<Text size="xs" c="dimmed">
							{t("catalog.effective")}:{" "}
							{effectiveProtocol
								? modelProtocolLabel(t, effectiveProtocol)
								: t("modelProtocolInherit")}{" "}
							·{" "}
							{protocolDraft !== null
								? t("catalog.set")
								: protocol.inheritedValue
									? t("catalog.protocolProviderLayer")
									: t("catalog.unreported")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("catalog.protocolHint", { model: protocol.modelValue })}
						</Text>
						{/* 下拉绑定本层草稿。null 显示「跟随默认」；上面的摘要行才展示继承后的有效协议。 */}
						<ModelProtocolSelect
							value={protocolDraft}
							protocols={
								protocol.modelValue.startsWith("CommandCode:")
									? COMMAND_CODE_PROTOCOL_OPTIONS
									: undefined
							}
							onChange={setProtocolDraft}
							size="xs"
							dropdownZIndex={Z.modal + 2}
							disabled={readOnly}
						/>
						{!readOnly && (
							<Group gap="xs">
								<Button
									size="compact-xs"
									variant="subtle"
									disabled={protocolDraft === null}
									onClick={() => setProtocolDraft(null)}
								>
									{t("catalog.reset")}
								</Button>
								{protocolDraft !== protocol.value && (
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={() => setProtocolDraft(protocol.value)}
									>
										{t("catalog.undo")}
									</Button>
								)}
							</Group>
						)}
					</Stack>
				)}
				{target.kind === "model" && !target.isNew && (
					<ProviderWindowOverrides modelId={target.id} />
				)}
				<CatalogMetadataFields
					card={target.card}
					edits={edits}
					onChange={setEdits}
					readOnly={readOnly || mutation.isPending || conflict}
				/>
				{/* Read-only complete card next to the editable fields: attributes without a
				    control stay visible but cannot be edited here. */}
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
