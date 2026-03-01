import { ActionIcon, Button, Group, Paper, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

export interface CommandDef {
	name: string;
	prompt: string;
	description?: string;
}

interface CommandsEditorProps {
	commands: CommandDef[];
	onChange: (commands: CommandDef[]) => void;
	/** i18n namespace to use for labels */
	ns?: string;
}

export function CommandsEditor({ commands, onChange, ns = "settings" }: CommandsEditorProps) {
	const { t } = useTranslation(ns);
	const [editIndex, setEditIndex] = useState<number | null>(null);
	const [draft, setDraft] = useState<CommandDef>({ name: "", prompt: "" });
	const [error, setError] = useState("");

	const validateName = useCallback(
		(name: string, excludeIndex?: number) => {
			if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
			const duplicate = commands.some(
				(c, i) => i !== excludeIndex && c.name.toLowerCase() === name.toLowerCase(),
			);
			return !duplicate;
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
		setDraft({ ...commands[index] });
		setError("");
	};

	const handleSave = () => {
		const name = draft.name.trim();
		const prompt = draft.prompt.trim();
		if (!name || !prompt) return;

		if (!validateName(name, editIndex === -1 ? undefined : (editIndex as number))) {
			setError(t("commandDuplicateName"));
			return;
		}

		const updated = [...commands];
		const entry: CommandDef = {
			name,
			prompt,
			...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
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
								const val = e.currentTarget.value;
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
						<Group gap="xs">
							<Button
								size="xs"
								onClick={handleSave}
								disabled={!draft.name.trim() || !draft.prompt.trim()}
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
