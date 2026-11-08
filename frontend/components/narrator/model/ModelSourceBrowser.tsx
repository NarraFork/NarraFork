import { Badge, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAutoModelOptionValue, type ModelOption } from "../../../lib/constants";
import { familyLabel } from "./model-menu-selection";

/**
 * Two-column model/source browser ("by model"): models on the left, the focused model's
 * sources on the right. Clicking a model on the left selects it as `auto:` immediately;
 * clicking a source on the right pins that provider (`prefix:model`). The right column also
 * says which source auto would use right now, so an auto session's actual provider is visible
 * without expanding anything.
 *
 * Each column shows about five rows and scrolls, instead of one long mixed list.
 */

export interface ModelSourceBrowserProps {
	/** Auto rows (with `autoSources`) AND models only a service offers (no auto row). */
	allModels: ModelOption[];
	/** The model value in effect now (`auto:x`, `prefix:model`, …). */
	currentModel: string | null | undefined;
	providerLabels?: Record<string, string>;
	onSelect: (value: string) => void;
	/** Search text shared with the menu footer. */
	filter?: string;
}

const COLUMN_MAX_HEIGHT = 5 * 46;

function familyOf(option: ModelOption): string {
	return option.family ?? "";
}

/** Sources of one option: an auto row's own list, or just the service a pinned model is on. */
function sourcesOf(option: ModelOption) {
	return (
		option.autoSources ?? [
			{
				value: option.value,
				provider: option.provider ?? "",
				available: option.available !== false,
				subscription: false,
			},
		]
	);
}

export function ModelSourceBrowser({
	allModels,
	currentModel,
	providerLabels = {},
	onSelect,
	filter = "",
}: ModelSourceBrowserProps) {
	const { t } = useTranslation("narrator");
	const currentValue = currentModel ?? "";
	const autoRowOfSource = useMemo(() => {
		const map = new Map<string, string>();
		for (const option of allModels) {
			for (const source of option.autoSources ?? []) {
				if (!map.has(source.value)) map.set(source.value, option.value);
			}
		}
		return map;
	}, [allModels]);

	const initialFocus = isAutoModelOptionValue(currentValue)
		? currentValue
		: (autoRowOfSource.get(currentValue) ?? (currentValue || allModels[0]?.value));
	const [focused, setFocused] = useState<string | undefined>(initialFocus);

	const needle = filter.trim().toLowerCase();
	const visible = useMemo(() => {
		if (!needle) return allModels;
		return allModels.filter((option) => {
			const haystack = [
				option.label,
				option.value,
				familyOf(option),
				providerLabels[option.provider ?? ""] ?? option.provider ?? "",
				...(option.autoSources ?? []).flatMap((s) => [
					s.value,
					providerLabels[s.provider] ?? s.provider,
				]),
			]
				.join(" ")
				.toLowerCase();
			return haystack.includes(needle);
		});
	}, [allModels, needle, providerLabels]);
	const focusedOption =
		visible.find((o) => o.value === focused) ??
		allModels.find((o) => o.value === focused) ??
		visible[0];

	const groups = useMemo(() => {
		const byFamily = new Map<string, ModelOption[]>();
		for (const option of visible) {
			const family = familyOf(option);
			const list = byFamily.get(family);
			if (list) list.push(option);
			else byFamily.set(family, [option]);
		}
		return [...byFamily.entries()].sort((a, b) => {
			if (!a[0]) return 1;
			if (!b[0]) return -1;
			return familyLabel(a[0]).localeCompare(familyLabel(b[0]));
		});
	}, [visible]);

	const sources = focusedOption ? sourcesOf(focusedOption) : [];
	const autoChoice = sources.find((s) => s.available) ?? sources[0];
	const isAutoSelected = focusedOption ? currentValue === focusedOption.value : false;

	return (
		<Group align="flex-start" gap={0} wrap="nowrap" grow>
			<Stack
				gap={2}
				style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--mantine-color-dark-4)" }}
			>
				<div style={{ maxHeight: COLUMN_MAX_HEIGHT, overflowY: "auto" }}>
					{groups.length === 0 && (
						<Text size="xs" c="dimmed" p="xs">
							{t("noModelMatches")}
						</Text>
					)}
					{groups.map(([family, options]) => (
						<div key={family || "__other__"}>
							<Text size="xs" c="dimmed" px="xs" pt={6} pb={2}>
								{family ? familyLabel(family) : t("modelGroupFamilyOther")}
							</Text>
							{options.map((option) => {
								const active = focusedOption?.value === option.value;
								return (
									<UnstyledButton
										key={option.value}
										onClick={() => {
											setFocused(option.value);
											// Left click = this model on auto, right away.
											onSelect(option.value);
										}}
										data-model-left={option.value}
										px="xs"
										py={5}
										style={{
											display: "block",
											width: "100%",
											textAlign: "left",
											borderRadius: 4,
											backgroundColor: active ? "var(--mantine-color-dark-5)" : undefined,
										}}
									>
										<Group justify="space-between" wrap="nowrap" gap={4}>
											<Text size="sm" truncate fw={currentValue === option.value ? 600 : 400}>
												{option.label}
											</Text>
											<IconCheck
												size={13}
												style={{
													visibility: currentValue === option.value ? "visible" : "hidden",
													flexShrink: 0,
												}}
											/>
										</Group>
									</UnstyledButton>
								);
							})}
						</div>
					))}
				</div>
			</Stack>

			<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
				<div style={{ maxHeight: COLUMN_MAX_HEIGHT, overflowY: "auto" }}>
					{focusedOption && (
						<>
							{focusedOption.autoSources && (
								<UnstyledButton
									onClick={() => onSelect(focusedOption.value)}
									data-model-auto={focusedOption.value}
									px="xs"
									py={5}
									style={{
										display: "block",
										width: "100%",
										textAlign: "left",
										borderRadius: 4,
										backgroundColor: isAutoSelected ? "var(--mantine-color-dark-5)" : undefined,
									}}
								>
									<Group justify="space-between" wrap="nowrap" gap={4}>
										<Text size="sm" fw={isAutoSelected ? 600 : 400}>
											{t("autoSourceAuto")}
										</Text>
										<IconCheck
											size={13}
											style={{ visibility: isAutoSelected ? "visible" : "hidden" }}
										/>
									</Group>
									{autoChoice && (
										<Text size="xs" c="dimmed" lh={1.3} truncate>
											{t("autoCurrentSource", {
												provider: providerLabels[autoChoice.provider] ?? autoChoice.provider,
											})}
										</Text>
									)}
								</UnstyledButton>
							)}
							{sources.map((source) => {
								const selected = currentValue === source.value;
								return (
									<Tooltip
										key={source.value}
										label={source.credentialLabel}
										disabled={!source.credentialLabel}
										withinPortal
									>
										<UnstyledButton
											onClick={() => onSelect(source.value)}
											data-model-source={source.value}
											px="xs"
											py={5}
											style={{
												display: "block",
												width: "100%",
												textAlign: "left",
												borderRadius: 4,
												backgroundColor: selected ? "var(--mantine-color-dark-5)" : undefined,
											}}
										>
											<Group justify="space-between" wrap="nowrap" gap={4}>
												<Text size="sm" c={source.available ? undefined : "dimmed"} truncate>
													{providerLabels[source.provider] ?? source.provider}
												</Text>
												<Group gap={4} wrap="nowrap">
													{source.subscription && (
														<Badge size="xs" variant="light" color="teal">
															{t("autoSourceSubscription")}
														</Badge>
													)}
													{!source.available && (
														<Badge size="xs" variant="light" color="yellow">
															{t("modelTemporarilyUnavailable")}
														</Badge>
													)}
													<IconCheck
														size={13}
														style={{ visibility: selected ? "visible" : "hidden" }}
													/>
												</Group>
											</Group>
										</UnstyledButton>
									</Tooltip>
								);
							})}
						</>
					)}
				</div>
			</Stack>
		</Group>
	);
}
