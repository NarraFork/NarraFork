import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	MultiSelect,
	NumberInput,
	SegmentedControl,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	isEmptyOverride,
	MODALITIES,
	type ModelOverride,
	type OverrideField,
	PRICE_FIELDS,
	REASONING_LEVELS,
	TOOL_LOADING_MODES,
} from "@shared/model-catalog/override";
import type { FieldOrigin, ModelDescription } from "@shared/model-catalog/schema/api";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useModelDescription, useSetModelOverride } from "../../hooks/useModelCatalog";
import { ApiError } from "../../lib/api/client";
import { formatLocaleNumber } from "../../lib/intl-format";
import { Z } from "../../lib/z-index";

type Scope = "connection" | "model";

const ORIGIN_COLOR: Record<FieldOrigin, string> = {
	catalog: "gray",
	upstream: "cyan",
	provider: "grape",
	model: "indigo",
	connection: "blue",
	default: "yellow",
};

export function OriginBadge({ origin }: { origin: FieldOrigin }) {
	const { t } = useTranslation("settings");
	return (
		<Badge size="xs" variant="light" color={ORIGIN_COLOR[origin]}>
			{t(`catalog.origin.${origin}`)}
		</Badge>
	);
}

/** How an effective value reads in the editor and the models table. */
export function formatFieldValue(
	field: OverrideField,
	value: unknown,
	t: (key: string) => string,
): string {
	if (value === undefined || value === null) return t("catalog.notSet");
	if (typeof value === "number") return formatLocaleNumber(value);
	if (typeof value === "boolean") return value ? t("catalog.yes") : t("catalog.no");
	if (Array.isArray(value)) {
		if (!value.length) return t("catalog.none");
		return field === "inputModalities"
			? value.map((m) => t(`catalog.modality.${m}`)).join(" · ")
			: value.join(" · ");
	}
	if (field === "prices" && typeof value === "object")
		return PRICE_FIELDS.filter((f) => (value as Record<string, string>)[f] !== undefined)
			.map((f) => `${t(`catalog.price.${f}`)} $${(value as Record<string, string>)[f]}`)
			.join(" · ");
	return String(value);
}

function FieldRow({
	field,
	description,
	draft,
	onToggle,
	error,
	disabled,
	children,
}: {
	field: OverrideField;
	description: ModelDescription;
	draft: ModelOverride;
	onToggle: (on: boolean) => void;
	error?: string;
	disabled: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation("settings");
	const effective = description.effective[field];
	const customized = draft[field] !== undefined;
	return (
		<Stack gap={4} data-model-field={field}>
			<Group justify="space-between" wrap="nowrap" gap="xs">
				<Text size="sm" fw={500}>
					{t(`catalog.field.${field}`)}
				</Text>
				<Switch
					size="xs"
					label={t("catalog.customize")}
					checked={customized}
					disabled={disabled}
					onChange={(event) => onToggle(event.currentTarget.checked)}
				/>
			</Group>
			<Group gap={6} wrap="nowrap">
				<Text size="xs" c="dimmed" style={{ minWidth: 0 }} truncate>
					{t("catalog.effective")}: {formatFieldValue(field, effective?.value, t)}
				</Text>
				{effective && <OriginBadge origin={effective.origin} />}
			</Group>
			{customized && children}
			{error && (
				<Text size="xs" c="red">
					{error}
				</Text>
			)}
		</Stack>
	);
}

/** Sensible starting value when a field is switched to customized. */
function seed(field: OverrideField, description: ModelDescription): ModelOverride[OverrideField] {
	const current = description.effective[field]?.value;
	if (current !== undefined) return structuredClone(current) as ModelOverride[OverrideField];
	switch (field) {
		case "inputModalities":
			return ["text"];
		case "nativeSearch":
		case "canDisableReasoning":
			return false;
		case "reasoningLevels":
		case "toolLoadingModes":
			return [];
		case "defaultReasoningLevel":
			return "medium";
		case "prices":
			return {};
		default:
			return undefined;
	}
}

/**
 * Edit one model's metadata for one provider entry, or model-wide when the entry is a
 * catalog model. Every field shows what is in effect and where it comes from; switching
 * "Customize" on is what makes a field this scope's own.
 */
export function ModelOverrideEditor({
	model,
	opened,
	onClose,
}: {
	/** Full model value, `provider:model`. */
	model: string | undefined;
	opened: boolean;
	onClose: () => void;
}) {
	const { t, i18n } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const readOnly = user?.role !== "admin";
	const description = useModelDescription(model, opened);
	const save = useSetModelOverride();
	const [scope, setScope] = useState<Scope>("connection");
	const [draft, setDraft] = useState<ModelOverride>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const info = description.data;

	// Load the chosen scope's override when the entry or the scope changes. A background
	// refetch of the same entry must not wipe what is being typed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on identity, not on refetches
	useEffect(() => {
		if (!info) return;
		const usable = scope === "model" && info.modelWideEditable ? "model" : "connection";
		if (usable !== scope) setScope(usable);
		setDraft(
			structuredClone((usable === "model" ? info.modelOverride : info.connectionOverride) ?? {}),
		);
		setErrors({});
	}, [info?.model, info !== undefined, scope]);

	const set = <K extends OverrideField>(field: K, value: ModelOverride[K] | undefined) => {
		setDraft((previous) => {
			const next = { ...previous };
			if (value === undefined) delete next[field];
			else next[field] = value;
			return next;
		});
		setErrors(({ [field]: _removed, ...rest }) => rest);
	};
	const toggle = (field: OverrideField) => (on: boolean) =>
		set(field, on && info ? (seed(field, info) as never) : undefined);

	const submit = async (fields: ModelOverride | null) => {
		if (!info || !model) return;
		try {
			await save.mutateAsync({
				scope,
				key: scope === "model" ? (info.catalogModelId ?? "") : model,
				fields: fields && !isEmptyOverride(fields) ? fields : null,
				model,
			});
			notifications.show({ message: t("catalog.saved"), color: "green" });
			onClose();
		} catch (error) {
			const field =
				error instanceof ApiError && typeof error.data?.field === "string"
					? (error.data.field.split(".")[0] ?? "")
					: "";
			const message = error instanceof Error ? error.message : String(error);
			const key = `catalog.invalid.${field}`;
			setErrors({ [field]: field && i18n.exists(key, { ns: "settings" }) ? t(key) : message });
		}
	};

	const levelOptions = REASONING_LEVELS.map((level) => ({ value: level, label: level }));
	const row = (field: OverrideField, input: ReactNode) =>
		info && (
			<FieldRow
				key={field}
				field={field}
				description={info}
				draft={draft}
				onToggle={toggle(field)}
				error={errors[field]}
				disabled={readOnly}
			>
				{input}
			</FieldRow>
		);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("catalog.editorTitle", { model: model ?? "" })}
			size="lg"
			centered
			zIndex={Z.modal + 1}
		>
			{description.isLoading && <Loader size="sm" />}
			{description.error && <Alert color="red">{description.error.message}</Alert>}
			{info && (
				<Stack gap="md">
					<Text size="sm" c="dimmed">
						{info.catalogModelId
							? t("catalog.matched", { name: info.catalogName ?? info.catalogModelId })
							: t("catalog.unmatched")}
					</Text>
					<Stack gap={4}>
						<SegmentedControl
							value={scope}
							onChange={(value) => setScope(value as Scope)}
							data={[
								{ value: "connection", label: t("catalog.scope.connection") },
								{
									value: "model",
									label: t("catalog.scope.model", {
										name: info.catalogName ?? info.catalogModelId ?? "",
									}),
									disabled: !info.modelWideEditable,
								},
							]}
						/>
						{info.catalogModelId && !info.modelWideEditable && (
							<Text size="xs" c="dimmed">
								{t("catalog.scope.weakHint")}
							</Text>
						)}
					</Stack>
					{readOnly && <Alert color="gray">{t("catalog.readOnly")}</Alert>}
					{errors[""] && <Alert color="red">{errors[""]}</Alert>}
					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="md">
						{row(
							"contextWindow",
							<NumberInput
								size="xs"
								min={1}
								thousandSeparator=","
								disabled={readOnly}
								value={draft.contextWindow ?? ""}
								onChange={(value) =>
									set("contextWindow", typeof value === "number" ? value : undefined)
								}
							/>,
						)}
						{row(
							"maxOutputTokens",
							<NumberInput
								size="xs"
								min={1}
								thousandSeparator=","
								disabled={readOnly}
								value={draft.maxOutputTokens ?? ""}
								onChange={(value) =>
									set("maxOutputTokens", typeof value === "number" ? value : undefined)
								}
							/>,
						)}
						{row(
							"inputModalities",
							<MultiSelect
								size="xs"
								disabled={readOnly}
								comboboxProps={{ zIndex: Z.modal + 2 }}
								data={MODALITIES.map((m) => ({ value: m, label: t(`catalog.modality.${m}`) }))}
								value={draft.inputModalities ?? []}
								onChange={(value) =>
									set("inputModalities", value as ModelOverride["inputModalities"])
								}
							/>,
						)}
						{row(
							"nativeSearch",
							<Switch
								size="sm"
								disabled={readOnly}
								label={t("catalog.supported")}
								checked={draft.nativeSearch ?? false}
								onChange={(event) => set("nativeSearch", event.currentTarget.checked)}
							/>,
						)}
						{row(
							"reasoningLevels",
							<MultiSelect
								size="xs"
								disabled={readOnly}
								comboboxProps={{ zIndex: Z.modal + 2 }}
								data={levelOptions}
								value={draft.reasoningLevels ?? []}
								onChange={(value) =>
									set("reasoningLevels", value as ModelOverride["reasoningLevels"])
								}
							/>,
						)}
						{row(
							"defaultReasoningLevel",
							<Select
								size="xs"
								disabled={readOnly}
								allowDeselect={false}
								comboboxProps={{ zIndex: Z.modal + 2 }}
								data={levelOptions}
								value={draft.defaultReasoningLevel ?? null}
								onChange={(value) =>
									set(
										"defaultReasoningLevel",
										(value ?? undefined) as ModelOverride["defaultReasoningLevel"],
									)
								}
							/>,
						)}
						{row(
							"canDisableReasoning",
							<Switch
								size="sm"
								disabled={readOnly}
								label={t("catalog.supported")}
								checked={draft.canDisableReasoning ?? false}
								onChange={(event) => set("canDisableReasoning", event.currentTarget.checked)}
							/>,
						)}
						{row(
							"toolLoadingModes",
							<Stack gap={2}>
								<MultiSelect
									size="xs"
									disabled={readOnly}
									comboboxProps={{ zIndex: Z.modal + 2 }}
									data={TOOL_LOADING_MODES.map((mode) => ({ value: mode, label: mode }))}
									value={draft.toolLoadingModes ?? []}
									onChange={(value) =>
										set("toolLoadingModes", value as ModelOverride["toolLoadingModes"])
									}
								/>
								<Text size="xs" c="dimmed">
									{t("catalog.toolLoadingHint")}
								</Text>
							</Stack>,
						)}
					</SimpleGrid>
					{row(
						"prices",
						<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
							{PRICE_FIELDS.map((field) => (
								<TextInput
									key={field}
									size="xs"
									label={t(`catalog.price.${field}`)}
									leftSection="$"
									inputMode="decimal"
									disabled={readOnly}
									value={draft.prices?.[field] ?? ""}
									onChange={(event) => {
										const value = event.currentTarget.value.trim();
										const prices = { ...draft.prices };
										if (value) prices[field] = value;
										else delete prices[field];
										set("prices", prices);
									}}
								/>
							))}
						</SimpleGrid>,
					)}
					{!readOnly && (
						<Group justify="space-between">
							<Button
								variant="subtle"
								color="red"
								size="xs"
								disabled={isEmptyOverride(
									scope === "model" ? info.modelOverride : info.connectionOverride,
								)}
								loading={save.isPending}
								onClick={() => void submit(null)}
							>
								{t("catalog.clearAll")}
							</Button>
							<Group gap="xs">
								<Button variant="default" size="xs" onClick={onClose}>
									{t("catalog.cancel")}
								</Button>
								<Button size="xs" loading={save.isPending} onClick={() => void submit(draft)}>
									{t("catalog.save")}
								</Button>
							</Group>
						</Group>
					)}
				</Stack>
			)}
		</Modal>
	);
}
