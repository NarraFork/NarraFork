import { api } from "@frontend/lib/api";
import {
	ActionIcon,
	Button,
	Divider,
	Group,
	Modal,
	MultiSelect,
	PasswordInput,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
	/** 只包含本实例自己的配置；绝不合并任何已存在平台的配置。 */
	config: Record<string, unknown>;
}

/** 各平台的空白配置：新建实例一律从空白开始。 */
function emptyConfig(platform: PlatformInstanceKindValue): Record<string, unknown> {
	switch (platform) {
		case "codex":
			return {
				useWebSocket: true,
				useWebSearch: true,
				useImageGeneration: true,
				credentialIds: [],
			};
		case "CommandCode":
			return { apiKey: "", baseUrl: "" };
		case "tokendance":
			return { apiKey: "" };
	}
}

/**
 * 平台实例管理：上半部分是已有实例（改名 / 删除），下半部分先填配置再添加同平台的另一个实例。
 *
 * 后缀与前缀在创建时确定、之后不可改：前缀是模型 ID 的一部分，改了会让已选中的模型失效。
 * 新实例的配置只来自这里的表单，空着就是空着——不会复制已有平台的凭据。
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
	const [config, setConfig] = useState<Record<string, unknown>>(() => emptyConfig("codex"));
	const option = PLATFORM_OPTIONS.find((entry) => entry.value === platform) ?? PLATFORM_OPTIONS[0];

	// Codex 实例只能使用自己选中的凭据，所以这里要列出凭据池供选择。
	const { data: codexStatus } = useQuery({
		queryKey: ["codex", "status", "platform-instance"],
		queryFn: () => api.codexStatus(),
		enabled: opened && platform === "codex",
		staleTime: 30_000,
	});
	const credentialOptions = useMemo(
		() =>
			(codexStatus?.entries ?? [])
				.filter((entry) => !entry.archivedAt)
				.map((entry) => ({
					value: entry.id,
					label: entry.displayName ?? entry.email ?? entry.id,
				})),
		[codexStatus?.entries],
	);

	const existingPrefixes = useMemo(
		() => [...reservedPrefixes, ...instances.map((instance) => instance.prefix)],
		[reservedPrefixes, instances],
	);
	const existingNames = useMemo(() => instances.map((instance) => instance.name), [instances]);

	// 每次打开、切换平台或增删实例都重置表单：默认后缀要跟着变，配置也要换成该平台的空白值。
	useEffect(() => {
		if (!opened) return;
		const naming = defaultInstanceNaming({
			basePrefix: option.basePrefix,
			baseName: option.baseName,
			takenPrefixes: existingPrefixes,
			takenNames: existingNames,
		});
		setSuffix(naming.suffix);
		setConfig(emptyConfig(option.value));
	}, [opened, option.basePrefix, option.baseName, option.value, existingPrefixes, existingNames]);

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

	const setConfigValue = (key: string, value: unknown) =>
		setConfig((current) => ({ ...current, [key]: value }));

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
				{platform === "CommandCode" && (
					<>
						<PasswordInput
							label={t("platformInstanceApiKey")}
							value={String(config.apiKey ?? "")}
							onChange={(event) => setConfigValue("apiKey", event.currentTarget.value)}
						/>
						<TextInput
							label={t("platformInstanceBaseUrl")}
							value={String(config.baseUrl ?? "")}
							onChange={(event) => setConfigValue("baseUrl", event.currentTarget.value)}
						/>
					</>
				)}
				{platform === "codex" && (
					<>
						<Switch
							label={t("platformInstanceWebSocket")}
							checked={config.useWebSocket !== false}
							onChange={(event) => setConfigValue("useWebSocket", event.currentTarget.checked)}
						/>
						<Switch
							label={t("platformInstanceWebSearch")}
							checked={config.useWebSearch !== false}
							onChange={(event) => setConfigValue("useWebSearch", event.currentTarget.checked)}
						/>
						<Switch
							label={t("platformInstanceImageGeneration")}
							checked={config.useImageGeneration !== false}
							onChange={(event) =>
								setConfigValue("useImageGeneration", event.currentTarget.checked)
							}
						/>
						<MultiSelect
							label={t("platformInstanceCodexCredentials")}
							description={t("platformInstanceCodexCredentialsHint")}
							data={credentialOptions}
							value={(config.credentialIds as string[] | undefined) ?? []}
							onChange={(value) => setConfigValue("credentialIds", value)}
							searchable
							clearable
						/>
					</>
				)}
				{platform === "tokendance" && (
					<PasswordInput
						label={t("platformInstanceApiKey")}
						value={String(config.apiKey ?? "")}
						onChange={(event) => setConfigValue("apiKey", event.currentTarget.value)}
					/>
				)}
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
							onAdd({ platform, name, suffix, prefix, config });
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
