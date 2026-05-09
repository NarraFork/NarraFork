import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";

const MODEL_SELECT_OPTION_LIMIT = 100;

export interface CommandParamDef {
	name: string;
	description?: string;
	required?: boolean;
	defaultValue?: string;
}

export interface CommandModelOverrideDef {
	model: string;
	mode: "temporary" | "permanent";
}

export interface CommandDef {
	name: string;
	prompt: string;
	description?: string;
	runBashFirst?: boolean;
	bashCommand?: string;
	params?: CommandParamDef[];
	modelOverride?: CommandModelOverrideDef;
}

interface CommandsEditorProps {
	commands: CommandDef[];
	onChange: (commands: CommandDef[]) => void;
	/** i18n namespace to use for labels */
	ns?: string;
}

export function CommandsEditor({ commands, onChange, ns = "settings" }: CommandsEditorProps) {
	const { t } = useTranslation(ns);
	const { groupedModels } = useAllModels();
	const [editIndex, setEditIndex] = useState<number | null>(null);
	const [draft, setDraft] = useState<CommandDef>({ name: "", prompt: "" });
	const [error, setError] = useState("");

	const validateName = useCallback(
		(name: string, excludeIndex?: number): "ok" | "invalid" | "duplicate" => {
			if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "invalid";
			const duplicate = commands.some(
				(c, i) => i !== excludeIndex && c.name.toLowerCase() === name.toLowerCase(),
			);
			return duplicate ? "duplicate" : "ok";
		},
		[commands],
	);

	const handleAdd = () => {
		setEditIndex(-1); // -1 = new
		setDraft({ name: "", prompt: "" });
		setError("");
	};

	const handleEdit = (index: number) => {
		setEditIndex(index);
		setDraft({
			...commands[index],
			params: commands[index].params?.map((p) => ({ ...p })),
			modelOverride: commands[index].modelOverride
				? { ...commands[index].modelOverride }
				: undefined,
		});
		setError("");
	};

	const handleSave = () => {
		const name = draft.name.trim().replace(/^\/+/, "");
		const prompt = draft.prompt.trim();
		if (!name || !prompt) return;

		const result = validateName(name, editIndex === -1 ? undefined : (editIndex as number));
		if (result !== "ok") {
			setError(t(result === "duplicate" ? "commandDuplicateName" : "commandInvalidName"));
			return;
		}

		const updated = [...commands];
		const cleanParams = (draft.params ?? []).filter((p) => p.name.trim());
		const bashCommand = draft.bashCommand?.trim();
		const entry: CommandDef = {
			name,
			prompt,
			...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
			...(draft.runBashFirst && bashCommand ? { runBashFirst: true, bashCommand } : {}),
			...(cleanParams.length > 0
				? {
						params: cleanParams.map((p) => ({
							name: p.name.trim(),
							...(p.description?.trim() ? { description: p.description.trim() } : {}),
							...(p.defaultValue?.trim() ? { defaultValue: p.defaultValue.trim() } : {}),
						})),
					}
				: {}),
			...(draft.modelOverride?.model
				? { modelOverride: { model: draft.modelOverride.model, mode: draft.modelOverride.mode } }
				: {}),
		};

		if (editIndex === -1) {
			updated.push(entry);
		} else if (editIndex != null) {
			updated[editIndex] = entry;
		}

		onChange(updated);
		setEditIndex(null);
		setDraft({ name: "", prompt: "" });
		setError("");
	};

	const handleDelete = (index: number) => {
		onChange(commands.filter((_, i) => i !== index));
		if (editIndex === index) {
			setEditIndex(null);
		}
	};

	const handleCancel = () => {
		setEditIndex(null);
		setDraft({ name: "", prompt: "" });
		setError("");
	};

	return (
		<Stack gap="xs">
			{commands.length === 0 && editIndex === null && (
				<Text size="sm" c="dimmed">
					{t("commandEmpty")}
				</Text>
			)}

			{commands.map((cmd, i) =>
				editIndex === i ? null : (
					<Paper key={cmd.name} withBorder p="xs">
						<Group justify="space-between" wrap="nowrap">
							<div style={{ flex: 1, minWidth: 0 }}>
								<Text size="sm" fw={600} c="indigo.4">
									/{cmd.name}
								</Text>
								{cmd.description && (
									<Text size="xs" c="dimmed" truncate="end">
										{cmd.description}
									</Text>
								)}
								<Text size="xs" c="dimmed" truncate="end" mt={2}>
									{cmd.prompt.slice(0, 100)}
									{cmd.prompt.length > 100 ? "…" : ""}
								</Text>
								{((cmd.params && cmd.params.length > 0) ||
									(cmd.runBashFirst && cmd.bashCommand)) && (
									<Group gap={4} mt={4}>
										{cmd.runBashFirst && cmd.bashCommand && (
											<Badge size="xs" variant="light" color="yellow">
												{t("commandRunBashFirstBadge")}
											</Badge>
										)}
										{cmd.params?.map((p) => (
											<Badge key={p.name} size="xs" variant="light" color="indigo">
												{p.name}
											</Badge>
										))}
									</Group>
								)}
								{cmd.modelOverride && (
									<Badge
										size="xs"
										variant="light"
										color={cmd.modelOverride.mode === "temporary" ? "teal" : "orange"}
										mt={4}
									>
										{cmd.modelOverride.mode === "temporary"
											? t("commandModelTemporary")
											: t("commandModelPermanent")}
										: {cmd.modelOverride.model}
									</Badge>
								)}
							</div>
							<Group gap={4}>
								<Button variant="subtle" size="compact-xs" onClick={() => handleEdit(i)}>
									{t("commandEdit")}
								</Button>
								<ActionIcon variant="subtle" color="red" size="sm" onClick={() => handleDelete(i)}>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Group>
					</Paper>
				),
			)}

			{editIndex != null && (
				<Paper withBorder p="sm">
					<Stack gap="xs">
						<TextInput
							label={t("commandName")}
							placeholder={t("commandNamePlaceholder")}
							value={draft.name}
							onChange={(e) => {
								const val = e.currentTarget.value.replace(/^\/+/, "");
								setDraft((d) => ({ ...d, name: val }));
								setError("");
							}}
							error={error || undefined}
							size="xs"
						/>
						<Textarea
							label={t("commandPrompt")}
							placeholder={t("commandPromptPlaceholder")}
							value={draft.prompt}
							onChange={(e) => {
								const val = e.currentTarget.value;
								setDraft((d) => ({ ...d, prompt: val }));
							}}
							autosize
							minRows={2}
							maxRows={8}
							size="xs"
						/>
						<TextInput
							label={t("commandDescription")}
							placeholder={t("commandDescriptionPlaceholder")}
							value={draft.description ?? ""}
							onChange={(e) => {
								const val = e.currentTarget.value;
								setDraft((d) => ({ ...d, description: val }));
							}}
							size="xs"
						/>

						<Stack gap={4}>
							<Switch
								label={t("commandRunBashFirst")}
								description={t("commandRunBashFirstDesc")}
								size="xs"
								checked={!!draft.runBashFirst}
								onChange={(e) => {
									const checked = e.currentTarget.checked;
									setDraft((d) => ({ ...d, runBashFirst: checked }));
								}}
							/>
							{draft.runBashFirst && (
								<Textarea
									label={t("commandBashCommand")}
									placeholder={t("commandBashCommandPlaceholder")}
									value={draft.bashCommand ?? ""}
									onChange={(e) => {
										const val = e.currentTarget.value;
										setDraft((d) => ({ ...d, bashCommand: val }));
									}}
									autosize
									minRows={2}
									maxRows={8}
									size="xs"
									styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
								/>
							)}
						</Stack>

						{/* Parameters editor */}
						<Stack gap={4}>
							<Text size="xs" fw={600}>
								{t("commandParamsLabel")}
							</Text>
							{(draft.params ?? []).map((param, pi) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: params are reordered by index
								<Group key={pi} gap={4} wrap="nowrap" align="flex-end">
									<TextInput
										placeholder={t("commandParamNamePlaceholder")}
										value={param.name}
										onChange={(e) => {
											const val = e.currentTarget.value;
											setDraft((d) => {
												const params = [...(d.params ?? [])];
												params[pi] = { ...params[pi], name: val };
												return { ...d, params };
											});
										}}
										size="xs"
										style={{ flex: 1 }}
									/>
									<TextInput
										placeholder={t("commandParamDescPlaceholder")}
										value={param.description ?? ""}
										onChange={(e) => {
											const val = e.currentTarget.value;
											setDraft((d) => {
												const params = [...(d.params ?? [])];
												params[pi] = { ...params[pi], description: val };
												return { ...d, params };
											});
										}}
										size="xs"
										style={{ flex: 2 }}
									/>
									<TextInput
										placeholder={t("commandParamDefaultPlaceholder")}
										value={param.defaultValue ?? ""}
										onChange={(e) => {
											const val = e.currentTarget.value;
											setDraft((d) => {
												const params = [...(d.params ?? [])];
												params[pi] = { ...params[pi], defaultValue: val };
												return { ...d, params };
											});
										}}
										size="xs"
										style={{ flex: 1 }}
									/>
									<ActionIcon
										variant="subtle"
										color="red"
										size="sm"
										onClick={() => {
											setDraft((d) => ({
												...d,
												params: (d.params ?? []).filter((_, j) => j !== pi),
											}));
										}}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							))}
							<Button
								variant="subtle"
								size="compact-xs"
								leftSection={<IconPlus size={12} />}
								onClick={() => {
									setDraft((d) => ({
										...d,
										params: [...(d.params ?? []), { name: "" }],
									}));
								}}
								style={{ alignSelf: "flex-start" }}
							>
								{t("commandAddParam")}
							</Button>
						</Stack>

						{/* Model override */}
						<Stack gap={4}>
							<Switch
								label={t("commandModelOverride")}
								description={t("commandModelOverrideDesc")}
								size="xs"
								checked={!!draft.modelOverride}
								onChange={(e) => {
									const checked = e.currentTarget.checked;
									setDraft((d) => ({
										...d,
										modelOverride: checked ? { model: "", mode: "temporary" as const } : undefined,
									}));
								}}
							/>
							{draft.modelOverride && (
								<Stack gap={4} ml="md">
									<Select
										label={t("commandModelSelect")}
										placeholder={t("commandModelSelectPlaceholder")}
										data={groupedModels}
										value={draft.modelOverride.model || null}
										onChange={(val) => {
											setDraft((d) => ({
												...d,
												modelOverride: d.modelOverride
													? { ...d.modelOverride, model: val ?? "" }
													: undefined,
											}));
										}}
										searchable
										limit={MODEL_SELECT_OPTION_LIMIT}
										size="xs"
									/>
									<SegmentedControl
										size="xs"
										data={[
											{
												value: "temporary",
												label: t("commandModelTemporary"),
											},
											{
												value: "permanent",
												label: t("commandModelPermanent"),
											},
										]}
										value={draft.modelOverride.mode}
										onChange={(val) => {
											setDraft((d) => ({
												...d,
												modelOverride: d.modelOverride
													? {
															...d.modelOverride,
															mode: val as "temporary" | "permanent",
														}
													: undefined,
											}));
										}}
									/>
								</Stack>
							)}
						</Stack>

						<Group gap="xs">
							<Button
								size="xs"
								onClick={handleSave}
								disabled={
									!draft.name.trim() ||
									!draft.prompt.trim() ||
									(!!draft.runBashFirst && !draft.bashCommand?.trim())
								}
							>
								{t("commandSave")}
							</Button>
							<Button size="xs" variant="subtle" onClick={handleCancel}>
								{t("commandCancel")}
							</Button>
						</Group>
					</Stack>
				</Paper>
			)}

			{editIndex === null && (
				<Button
					variant="light"
					size="xs"
					leftSection={<IconPlus size={14} />}
					onClick={handleAdd}
					style={{ alignSelf: "flex-start" }}
				>
					{t("commandAdd")}
				</Button>
			)}
		</Stack>
	);
}
