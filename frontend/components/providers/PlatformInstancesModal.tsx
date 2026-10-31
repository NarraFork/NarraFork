import {
	ActionIcon,
	Button,
	Divider,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	composeInstancePrefix,
	defaultInstanceNaming,
	isValidInstanceSuffix,
} from "../../../shared/platform-instances";

/** 平台集成的三个内置平台；名称与默认前缀要和 server 侧 PLATFORM_DEFAULTS 保持一致。 */
const PLATFORM_OPTIONS = [
	{ value: "codex", label: "Codex", basePrefix: "codex", baseName: "Codex" },
	{
		value: "CommandCode",
		label: "Command Code",
		basePrefix: "CommandCode",
		baseName: "Command Code",
	},
	{ value: "tokendance", label: "TokenDance", basePrefix: "tokendance", baseName: "TokenDance" },
] as const;

export type PlatformInstanceKindValue = (typeof PLATFORM_OPTIONS)[number]["value"];

export interface PlatformInstanceRow {
	id: string;
	platform: PlatformInstanceKindValue;
	name: string;
	suffix: string;
	prefix: string;
	disabled: boolean;
	config: Record<string, unknown>;
}

export interface NewPlatformInstance {
	platform: PlatformInstanceKindValue;
	name: string;
	suffix: string;
	prefix: string;
}

/**
 * 平台实例管理：上半部分是已有实例（改名 / 删除），下半部分添加同平台的另一个实例。
 *
 * 后缀与前缀在创建时确定、之后不可改：前缀是模型 ID 的一部分，改了会让已选中的模型失效。
 */
export function PlatformInstancesModal({
	opened,
	onClose,
	instances,
	reservedPrefixes,
	onAdd,
	onRename,
	onDelete,
}: {
	opened: boolean;
	onClose: () => void;
	instances: readonly PlatformInstanceRow[];
	reservedPrefixes: readonly string[];
	onAdd: (instance: NewPlatformInstance) => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [platform, setPlatform] = useState<PlatformInstanceKindValue>("codex");
	const [suffix, setSuffix] = useState("");
	const option = PLATFORM_OPTIONS.find((entry) => entry.value === platform) ?? PLATFORM_OPTIONS[0];

	const existingPrefixes = useMemo(
		() => [...reservedPrefixes, ...instances.map((instance) => instance.prefix)],
		[reservedPrefixes, instances],
	);
	const existingNames = useMemo(() => instances.map((instance) => instance.name), [instances]);

	// 每次打开或切换平台都重新给默认后缀：删过实例后，默认值要跟着变。
	useEffect(() => {
		if (!opened) return;
		const naming = defaultInstanceNaming({
			basePrefix: option.basePrefix,
			baseName: option.baseName,
			takenPrefixes: existingPrefixes,
			takenNames: existingNames,
		});
		setSuffix(naming.suffix);
	}, [opened, option.basePrefix, option.baseName, existingPrefixes, existingNames]);

	const prefix = composeInstancePrefix(option.basePrefix, suffix);
	const name = suffix ? `${option.baseName}-${suffix}` : option.baseName;
	const suffixValid = suffix === "" || isValidInstanceSuffix(suffix);
	const prefixTaken = existingPrefixes.includes(prefix);
	const canAdd = suffixValid && !prefixTaken;

	const hint = useMemo(() => {
		if (!suffixValid) return t("platformInstanceSuffixInvalid");
		if (prefixTaken) return t("platformInstancePrefixTaken", { prefix });
		return t("platformInstancePrefixPreview", { prefix, name });
	}, [suffixValid, prefixTaken, prefix, name, t]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("platformInstanceModalTitle")} size="md">
			<Stack gap="sm">
				{instances.length > 0 && (
					<>
						<Text size="xs" c="dimmed">
							{t("platformInstanceExistingHint")}
						</Text>
						{instances.map((instance) => (
							<Group key={instance.id} gap="xs" wrap="nowrap">
								<Text size="xs" c="dimmed" w={140} style={{ flexShrink: 0 }}>
									{instance.prefix}
								</Text>
								<TextInput
									size="xs"
									style={{ flex: 1 }}
									defaultValue={instance.name}
									onBlur={(event) => {
										const next = event.currentTarget.value.trim();
										if (next && next !== instance.name) onRename(instance.id, next);
									}}
								/>
								<ActionIcon
									size="sm"
									color="red"
									variant="subtle"
									aria-label={t("platformInstanceDelete")}
									onClick={() => onDelete(instance.id)}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						))}
						<Divider my="xs" />
					</>
				)}
				<Select
					label={t("platformInstancePlatform")}
					data={PLATFORM_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
					value={platform}
					onChange={(value) => value && setPlatform(value as PlatformInstanceKindValue)}
					allowDeselect={false}
				/>
				<TextInput
					label={t("platformInstanceSuffix")}
					description={t("platformInstanceSuffixHint")}
					value={suffix}
					onChange={(event) => setSuffix(event.currentTarget.value.trim())}
					error={!suffixValid}
				/>
				<Text size="xs" c={canAdd ? "dimmed" : "red"}>
					{hint}
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={!canAdd}
						onClick={() => {
							onAdd({ platform, name, suffix, prefix });
							onClose();
						}}
					>
						{t("platformInstanceAdd")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
