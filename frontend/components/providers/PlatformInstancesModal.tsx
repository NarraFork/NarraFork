import {
	ActionIcon,
	Button,
	Code,
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
	instanceCardName,
	nextInstanceSuffix,
	PLATFORM_DEFAULTS,
	PLATFORM_INSTANCE_KINDS,
	type PlatformInstanceKind,
	type PlatformInstanceRow,
	resolveInstancePrefix,
} from "../../../shared/platform-instances";
import { emptyInstanceConfig, PlatformInstanceFields } from "./PlatformInstanceSection";

export interface NewPlatformInstance {
	platform: PlatformInstanceKind;
	suffix: string;
	prefix: string;
	config: Record<string, unknown>;
}

/**
 * 添加平台实例。
 *
 * 平台类型是固定的几个；后缀与模型前缀都可以留空——后缀留空自动取第一个空闲数字，模型
 * 前缀留空就等于卡片名（`codex-1:模型`）。两者都不影响已有实例。
 */
export function PlatformInstancesModal({
	opened,
	onClose,
	instances,
	takenPrefixes,
	onAdd,
	onDelete,
}: {
	opened: boolean;
	onClose: () => void;
	instances: readonly PlatformInstanceRow[];
	/** 其它供应商占用的前缀（自定义 API / NUG / 插件），新实例不能撞上。 */
	takenPrefixes: readonly string[];
	onAdd: (instance: NewPlatformInstance) => void;
	onDelete: (id: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [platform, setPlatform] = useState<PlatformInstanceKind>("codex");
	const [suffix, setSuffix] = useState("");
	const [prefix, setPrefix] = useState("");
	const [config, setConfig] = useState<Record<string, unknown>>(() => emptyInstanceConfig("codex"));

	const cardNames = useMemo(
		() => instances.map((instance) => instanceCardName(instance.platform, instance.suffix)),
		[instances],
	);
	const taken = useMemo(
		() => [...instances.map((instance) => instance.prefix), ...cardNames, ...takenPrefixes],
		[instances, cardNames, takenPrefixes],
	);

	// 留空后缀时自动取第一个空闲数字；每次打开或增删实例都重新算一遍。
	const autoSuffix = useMemo(
		() => nextInstanceSuffix({ platform, takenNames: cardNames, takenPrefixes: taken }),
		[platform, cardNames, taken],
	);

	useEffect(() => {
		if (!opened) return;
		setSuffix("");
		setPrefix("");
		setConfig(emptyInstanceConfig(platform));
	}, [opened, platform]);

	const effectiveSuffix = suffix.trim() || autoSuffix;
	const cardName = instanceCardName(platform, effectiveSuffix);
	const effectivePrefix = resolveInstancePrefix(platform, effectiveSuffix, prefix);
	const prefixConflict = taken.includes(effectivePrefix);
	const nameConflict = cardNames.includes(cardName);
	const prefixInvalid = !effectivePrefix || /[\s:]/.test(effectivePrefix);
	const canAdd = !prefixConflict && !nameConflict && !prefixInvalid;

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
									{instanceCardName(instance.platform, instance.suffix)}
								</Text>
								<Text size="xs" style={{ flex: 1 }}>
									{instance.prefix}
								</Text>
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
					data={PLATFORM_INSTANCE_KINDS.map((kind) => ({
						value: kind,
						label: PLATFORM_DEFAULTS[kind].label,
					}))}
					value={platform}
					onChange={(value) => value && setPlatform(value as PlatformInstanceKind)}
					allowDeselect={false}
				/>
				<TextInput
					label={t("platformInstanceSuffix")}
					description={t("platformInstanceSuffixHint")}
					placeholder={autoSuffix}
					value={suffix}
					onChange={(event) => setSuffix(event.currentTarget.value)}
				/>
				<TextInput
					label={t("platformInstancePrefix")}
					description={t("platformInstancePrefixHint")}
					placeholder={cardName}
					value={prefix}
					onChange={(event) => setPrefix(event.currentTarget.value)}
					error={
						prefixInvalid
							? t("platformInstancePrefixInvalid")
							: prefixConflict
								? t("platformInstancePrefixTaken", { prefix: effectivePrefix })
								: undefined
					}
				/>
				<Group gap="xs">
					<Text size="xs" c="dimmed">
						{t("platformInstancePreview", { name: cardName, prefix: effectivePrefix })}
					</Text>
					<Code>{`${effectivePrefix}:model`}</Code>
				</Group>
				<PlatformInstanceFields platform={platform} config={config} onChange={setConfig} />
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={!canAdd}
						onClick={() => {
							onAdd({ platform, suffix: effectiveSuffix, prefix: effectivePrefix, config });
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
