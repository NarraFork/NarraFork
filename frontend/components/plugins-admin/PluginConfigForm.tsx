/**
 * Renders provider config from a plugin-supplied JSON Schema.
 *
 * Hand-written rather than delegated to a library: the only schema subset worth
 * rendering is the one the backend validator actually enforces (see `config-schema.ts`),
 * and a general-purpose renderer would both pull in a second validation engine and
 * present controls for keywords the server ignores. Anything outside that subset falls
 * back to a JSON editor for that field, so an exotic schema stays configurable instead
 * of becoming unreachable.
 *
 * Secrets are masked and never round-tripped in the clear: the server sends a
 * placeholder, and the form distinguishes keep / replace / clear explicitly. See
 * `config-form-state.ts` for why that distinction is modelled rather than inferred.
 */

import {
	Alert,
	Badge,
	Button,
	Group,
	JsonInput,
	NumberInput,
	PasswordInput,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	buildConfigPayload,
	type ConfigDraft,
	type ConfigViewInput,
	draftFromView,
	isDraftDirty,
	listTextFor,
	secretDisplayValue,
	setFieldValue,
	setListValue,
	setRawText,
	setSecretValue,
} from "./config-form-state";
import {
	buildConfigFormModel,
	type ConfigField,
	type JsonValue,
	type SchemaNode,
} from "./config-schema";

export interface PluginConfigFormProps {
	/** Provider `configSchema` exactly as the registry reported it. */
	schema: SchemaNode | undefined;
	/** Current server-side view: values (secrets already masked), plus secret metadata. */
	view: ConfigViewInput;
	/** Submit handler; receives the request body for the config endpoint. */
	onSubmit: (config: Record<string, JsonValue>) => Promise<void> | void;
	submitting?: boolean;
	/** Server-side error from the last submit, shown verbatim above the fields. */
	submitError?: string;
	disabled?: boolean;
}

function fieldDescription(field: ConfigField): string | undefined {
	return field.description;
}

/** Numeric inputs return `""` when cleared; normalize that to "absent". */
function normalizeNumber(value: string | number): JsonValue | undefined {
	if (value === "" || value === null) return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function PluginConfigForm({
	schema,
	view,
	onSubmit,
	submitting = false,
	submitError,
	disabled = false,
}: PluginConfigFormProps) {
	const { t } = useTranslation("plugins");
	const model = useMemo(() => buildConfigFormModel(schema), [schema]);
	// Re-seed whenever the server view changes identity, so a successful save or an
	// external change is reflected instead of leaving a stale draft on screen.
	const [draft, setDraft] = useState<ConfigDraft>(() => draftFromView(model.fields, view));
	const [seededFor, setSeededFor] = useState(() => JSON.stringify(view));
	const viewKey = JSON.stringify(view);
	if (viewKey !== seededFor) {
		setSeededFor(viewKey);
		setDraft(draftFromView(model.fields, view));
	}

	const [rawAll, setRawAll] = useState<string>(() => JSON.stringify(view.config, null, 2));
	const [issues, setIssues] = useState<Record<string, string>>({});
	const [rawError, setRawError] = useState<string | undefined>();

	const dirty = model.rawOnly
		? rawAll.trim() !== JSON.stringify(view.config, null, 2).trim()
		: isDraftDirty(model.fields, draft, view);

	const handleSubmit = useCallback(async () => {
		if (model.rawOnly) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawAll.trim().length === 0 ? "{}" : rawAll);
			} catch {
				setRawError(t("admin.detail.config.invalidJson"));
				return;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				setRawError(t("admin.detail.config.mustBeObject"));
				return;
			}
			setRawError(undefined);
			await onSubmit(parsed as Record<string, JsonValue>);
			return;
		}
		const built = buildConfigPayload(model.fields, draft, view);
		if (!built.payload) {
			setIssues(Object.fromEntries(built.issues.map((issue) => [issue.name, issue.message])));
			return;
		}
		setIssues({});
		await onSubmit(built.payload);
	}, [draft, model, onSubmit, rawAll, t, view]);

	const controlsDisabled = disabled || submitting;

	if (model.rawOnly) {
		return (
			<Stack gap="md">
				<Alert
					variant="light"
					color="blue"
					icon={<IconInfoCircle size={16} />}
					title={t("admin.detail.config.rawOnlyTitle")}
				>
					{t("admin.detail.config.rawOnlyMessage")}
				</Alert>
				{submitError ? (
					<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
						{submitError}
					</Alert>
				) : null}
				<JsonInput
					label={t("admin.detail.config.rawLabel")}
					value={rawAll}
					onChange={(value) => {
						setRawAll(value);
						setRawError(undefined);
					}}
					error={rawError}
					autosize
					minRows={6}
					formatOnBlur
					disabled={controlsDisabled}
				/>
				<Group justify="flex-end">
					<Button onClick={handleSubmit} loading={submitting} disabled={disabled || !dirty}>
						{t("admin.detail.config.save")}
					</Button>
				</Group>
			</Stack>
		);
	}

	return (
		<Stack gap="md">
			{submitError ? (
				<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
					{submitError}
				</Alert>
			) : null}
			{model.fields.map((field) => {
				const issue = issues[field.name];
				const description = fieldDescription(field);
				const commonProps = {
					label: field.label,
					description,
					error: issue,
					withAsterisk: field.required,
					disabled: controlsDisabled,
				} as const;

				if (field.constValue !== undefined) {
					return (
						<TextInput
							key={field.name}
							{...commonProps}
							value={JSON.stringify(field.constValue)}
							readOnly
							description={t("admin.detail.config.fixedValue")}
						/>
					);
				}

				if (field.kind === "password") {
					return (
						<PasswordInput
							key={field.name}
							{...commonProps}
							value={secretDisplayValue(field, draft, view)}
							onChange={(event) =>
								setDraft((current) =>
									setSecretValue(current, field.name, event.currentTarget.value),
								)
							}
							description={
								description ??
								(view.secretsSet.includes(field.name)
									? t("admin.detail.config.secretStored")
									: t("admin.detail.config.secretUnset"))
							}
						/>
					);
				}

				if (field.kind === "select") {
					const options = field.options ?? [];
					const currentValue = draft.values[field.name];
					return (
						<Select
							key={field.name}
							{...commonProps}
							data={options.map((option) => ({ value: option.value, label: option.value }))}
							value={
								options.find(
									(option) => JSON.stringify(option.json) === JSON.stringify(currentValue),
								)?.value ?? null
							}
							onChange={(value) =>
								setDraft((current) => {
									const match = options.find((option) => option.value === value);
									return match
										? setFieldValue(current, field.name, match.json)
										: setFieldValue(current, field.name, null);
								})
							}
							clearable={!field.required}
						/>
					);
				}

				if (field.kind === "boolean") {
					return (
						<Switch
							key={field.name}
							label={field.label}
							description={description}
							checked={draft.values[field.name] === true}
							onChange={(event) =>
								setDraft((current) =>
									setFieldValue(current, field.name, event.currentTarget.checked),
								)
							}
							disabled={controlsDisabled}
						/>
					);
				}

				if (field.kind === "number" || field.kind === "integer") {
					const value = draft.values[field.name];
					return (
						<NumberInput
							key={field.name}
							{...commonProps}
							value={typeof value === "number" ? value : ""}
							onChange={(next) =>
								setDraft((current) => {
									const parsed = normalizeNumber(next);
									return parsed === undefined
										? setFieldValue(current, field.name, null)
										: setFieldValue(current, field.name, parsed);
								})
							}
							min={field.minimum}
							max={field.maximum}
							allowDecimal={field.kind === "number"}
						/>
					);
				}

				if (field.kind === "multiline-list") {
					return (
						<Textarea
							key={field.name}
							{...commonProps}
							description={description ?? t("admin.detail.config.onePerLine")}
							value={listTextFor(draft, field.name)}
							onChange={(event) =>
								setDraft((current) => setListValue(current, field.name, event.currentTarget.value))
							}
							autosize
							minRows={3}
						/>
					);
				}

				if (field.kind === "textarea") {
					return (
						<Textarea
							key={field.name}
							{...commonProps}
							value={
								typeof draft.values[field.name] === "string" ? String(draft.values[field.name]) : ""
							}
							onChange={(event) =>
								setDraft((current) => setFieldValue(current, field.name, event.currentTarget.value))
							}
							autosize
							minRows={3}
							maxLength={field.maxLength}
						/>
					);
				}

				if (field.kind === "json") {
					return (
						<Stack key={field.name} gap={4}>
							<JsonInput
								{...commonProps}
								value={draft.rawText[field.name] ?? ""}
								onChange={(value) => setDraft((current) => setRawText(current, field.name, value))}
								autosize
								minRows={3}
								formatOnBlur
							/>
							{field.unsupportedReason ? (
								<Group gap={6}>
									<Tooltip label={field.unsupportedReason} withArrow>
										<Badge size="xs" variant="light" color="gray">
											{t("admin.detail.config.jsonFallback")}
										</Badge>
									</Tooltip>
								</Group>
							) : null}
						</Stack>
					);
				}

				return (
					<TextInput
						key={field.name}
						{...commonProps}
						value={
							typeof draft.values[field.name] === "string" ? String(draft.values[field.name]) : ""
						}
						onChange={(event) =>
							setDraft((current) => setFieldValue(current, field.name, event.currentTarget.value))
						}
						maxLength={field.maxLength}
					/>
				);
			})}
			{!model.additionalPropertiesAllowed ? (
				<Text size="xs" c="dimmed">
					{t("admin.detail.config.closedSchema")}
				</Text>
			) : null}
			<Group justify="flex-end">
				<Button onClick={handleSubmit} loading={submitting} disabled={disabled || !dirty}>
					{t("admin.detail.config.save")}
				</Button>
			</Group>
		</Stack>
	);
}
