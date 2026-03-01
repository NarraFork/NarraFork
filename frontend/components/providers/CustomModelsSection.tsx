import {
	ActionIcon,
	Badge,
	Group,
	NativeSelect,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconEye, IconEyeOff, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { modelValue } from "../../lib/constants";

interface CustomModelsSectionProps {
	customModels: Array<{ value: string; label: string; provider?: string }>;
	onCustomModelsChange: (
		models: Array<{ value: string; label: string; provider?: string }>,
	) => void;
	hiddenModels: string[];
	onToggleHidden: (modelVal: string) => void;
	prefixOptions: Array<{ value: string; label: string }>;
}

export function CustomModelsSection({
	customModels,
	onCustomModelsChange,
	hiddenModels,
	onToggleHidden,
	prefixOptions,
}: CustomModelsSectionProps) {
	const { t } = useTranslation("settings");
	const [newModelValue, setNewModelValue] = useState("");
	const [newModelLabel, setNewModelLabel] = useState("");
	const [newModelProvider, setNewModelProvider] = useState("openai");

	const handleAddModel = useCallback(() => {
		const v = newModelValue.trim();
		const l = newModelLabel.trim();
		if (!v || !l) return;
		const fullValue = modelValue(newModelProvider, v);
		if (customModels.some((m) => m.value === fullValue)) return;
		onCustomModelsChange([
			...customModels,
			{ value: fullValue, label: l, provider: newModelProvider },
		]);
		setNewModelValue("");
		setNewModelLabel("");
	}, [newModelValue, newModelLabel, newModelProvider, customModels, onCustomModelsChange]);

	const handleRemoveModel = useCallback(
		(value: string) => {
			onCustomModelsChange(customModels.filter((m) => m.value !== value));
		},
		[customModels, onCustomModelsChange],
	);

	return (
		<Paper withBorder p="md">
			<Stack>
				<div>
					<Title order={4}>{t("customModelsSection", { defaultValue: "Custom Models" })}</Title>
					<Text size="xs" c="dimmed">
						{t("customModelsDesc")}
					</Text>
				</div>
				{customModels.map((m) => {
					const isHidden = hiddenModels.includes(m.value);
					return (
						<Group key={m.value} gap="xs" style={isHidden ? { opacity: 0.5 } : undefined}>
							<TextInput value={m.value} disabled style={{ flex: 1 }} />
							<TextInput value={m.label} disabled style={{ flex: 1 }} />
							<Badge
								size="sm"
								variant="light"
								w={70}
							>
								{m.provider ?? "openai"}
							</Badge>
							<ActionIcon
								variant="subtle"
								color={isHidden ? "gray" : "blue"}
								onClick={() => onToggleHidden(m.value)}
							>
								{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
							</ActionIcon>
							<ActionIcon color="red" variant="subtle" onClick={() => handleRemoveModel(m.value)}>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					);
				})}
				<Group gap="xs">
					<TextInput
						placeholder={t("modelValuePlaceholder")}
						value={newModelValue}
						onChange={(e) => setNewModelValue(e.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<TextInput
						placeholder={t("modelLabelPlaceholder")}
						value={newModelLabel}
						onChange={(e) => setNewModelLabel(e.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<NativeSelect
						size="xs"
						data={prefixOptions}
						value={newModelProvider}
						onChange={(e) => setNewModelProvider(e.currentTarget.value)}
						w={100}
					/>
					<ActionIcon
						variant="light"
						onClick={handleAddModel}
						disabled={!newModelValue.trim() || !newModelLabel.trim()}
					>
						<IconPlus size={14} />
					</ActionIcon>
				</Group>
			</Stack>
		</Paper>
	);
}
