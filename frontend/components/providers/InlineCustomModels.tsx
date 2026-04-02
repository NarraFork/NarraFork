import {
	ActionIcon,
	Badge,
	Divider,
	Group,
	NumberInput,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconEye, IconEyeOff, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { modelValue } from "../../lib/constants";

export interface CustomModelEntry {
	value: string;
	label: string;
	provider?: string;
}

interface InlineCustomModelsProps {
	prefix: string;
	/** All custom models (component filters by prefix internally) */
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	hiddenModels: string[];
	onToggleHidden: (modelVal: string) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	onTestModel?: (model: string) => void;
}

export function InlineCustomModels({
	prefix,
	customModels,
	onCustomModelsChange,
	hiddenModels,
	onToggleHidden,
	modelContextWindows,
	onContextWindowChange,
	onTestModel,
}: InlineCustomModelsProps) {
	const { t } = useTranslation("settings");
	const [newModelValue, setNewModelValue] = useState("");
	const [newModelLabel, setNewModelLabel] = useState("");

	const myModels = customModels.filter((m) => m.value.startsWith(`${prefix}:`));

	const handleAdd = useCallback(() => {
		const v = newModelValue.trim();
		const l = newModelLabel.trim();
		if (!v || !l) return;
		const fullValue = modelValue(prefix, v);
		if (customModels.some((m) => m.value === fullValue)) return;
		onCustomModelsChange([...customModels, { value: fullValue, label: l, provider: prefix }]);
		setNewModelValue("");
		setNewModelLabel("");
	}, [newModelValue, newModelLabel, prefix, customModels, onCustomModelsChange]);

	const handleRemove = useCallback(
		(value: string) => {
			onCustomModelsChange(customModels.filter((m) => m.value !== value));
		},
		[customModels, onCustomModelsChange],
	);

	return (
		<Stack gap="xs">
			<Divider
				label={
					<Group gap={4}>
						<Text size="xs" fw={500}>
							{t("inlineCustomModelsTitle")}
						</Text>
						{myModels.length > 0 && (
							<Badge size="xs" variant="light" color="gray">
								{myModels.length}
							</Badge>
						)}
					</Group>
				}
				labelPosition="left"
			/>
			{myModels.map((m) => {
				const isHidden = hiddenModels.includes(m.value);
				return (
					<Group key={m.value} gap="xs" wrap="wrap" style={isHidden ? { opacity: 0.5 } : undefined}>
						<TextInput value={m.value} disabled style={{ flex: 1, minWidth: 120 }} />
						<TextInput value={m.label} disabled style={{ flex: 1, minWidth: 120 }} />
						<NumberInput
							placeholder={t("contextWindowPlaceholder")}
							value={modelContextWindows[m.value] || ""}
							onChange={(v) => onContextWindowChange(m.value, typeof v === "number" ? v : null)}
							min={1}
							step={1000}
							suffix={` ${t("contextWindowSuffix")}`}
							w={180}
							size="xs"
						/>
						<ActionIcon
							variant="subtle"
							color={isHidden ? "gray" : "blue"}
							onClick={() => onToggleHidden(m.value)}
						>
							{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
						</ActionIcon>
						{onTestModel && (
							<Tooltip label={t("modelTestBtn")}>
								<ActionIcon variant="subtle" color="teal" onClick={() => onTestModel(m.value)}>
									<IconPlayerPlay size={16} />
								</ActionIcon>
							</Tooltip>
						)}
						<ActionIcon color="red" variant="subtle" onClick={() => handleRemove(m.value)}>
							<IconTrash size={14} />
						</ActionIcon>
					</Group>
				);
			})}
			<Group gap="xs" wrap="wrap">
				<TextInput
					placeholder={t("modelValuePlaceholder")}
					value={newModelValue}
					onChange={(e) => setNewModelValue(e.currentTarget.value)}
					style={{ flex: 1, minWidth: 120 }}
					size="xs"
				/>
				<TextInput
					placeholder={t("modelLabelPlaceholder")}
					value={newModelLabel}
					onChange={(e) => setNewModelLabel(e.currentTarget.value)}
					style={{ flex: 1, minWidth: 120 }}
					size="xs"
				/>
				<ActionIcon
					variant="light"
					onClick={handleAdd}
					disabled={!newModelValue.trim() || !newModelLabel.trim()}
				>
					<IconPlus size={14} />
				</ActionIcon>
			</Group>
		</Stack>
	);
}
