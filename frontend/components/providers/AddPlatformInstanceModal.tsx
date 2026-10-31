import { Button, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
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

export interface NewPlatformInstance {
	platform: PlatformInstanceKindValue;
	name: string;
	suffix: string;
	prefix: string;
}

export function AddPlatformInstanceModal({
	opened,
	onClose,
	existingPrefixes,
	existingNames,
	onSubmit,
}: {
	opened: boolean;
	onClose: () => void;
	existingPrefixes: readonly string[];
	existingNames: readonly string[];
	onSubmit: (instance: NewPlatformInstance) => void;
}) {
	const { t } = useTranslation("settings");
	const [platform, setPlatform] = useState<PlatformInstanceKindValue>("codex");
	const [suffix, setSuffix] = useState("");
	const option = PLATFORM_OPTIONS.find((entry) => entry.value === platform) ?? PLATFORM_OPTIONS[0];

	// 每打开一次都重新给默认后缀：用户在别处删过实例时，默认值要跟着变。
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
	const canSubmit = suffixValid && !prefixTaken;

	const hint = useMemo(() => {
		if (!suffixValid) return t("platformInstanceSuffixInvalid");
		if (prefixTaken) return t("platformInstancePrefixTaken", { prefix });
		return t("platformInstancePrefixPreview", { prefix, name });
	}, [suffixValid, prefixTaken, prefix, name, t]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("platformInstanceModalTitle")} size="sm">
			<Stack gap="sm">
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
				<Text size="xs" c={canSubmit ? "dimmed" : "red"}>
					{hint}
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={!canSubmit}
						onClick={() => {
							onSubmit({ platform, name, suffix, prefix });
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
