import {
	ActionIcon,
	Button,
	Group,
	Paper,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PathFlavor, RuleTargetSelector } from "../../lib/api/types";
import {
	devicePathFlavor,
	type PermissionTargetDevice,
	RuleTargetSelector as TargetSelectorInput,
} from "./RuleTargetSelector";
import { TargetPathInput } from "./TargetPathInput";

export type PermissionRuleKind =
	| "directoryWhitelist"
	| "directoryBlacklist"
	| "commandWhitelist"
	| "commandBlacklist";

export interface PermissionRuleValue {
	id?: string;
	path?: string;
	pathFlavor?: PathFlavor | null;
	pattern?: string;
	accessLevel?: "readOnly" | "readWrite" | "full";
	denyLevel?: "denyWrite" | "denyAll";
	denyPrompt?: string | null;
	enabled?: boolean;
	selector: RuleTargetSelector;
}

function isDirectory(kind: PermissionRuleKind): boolean {
	return kind === "directoryWhitelist" || kind === "directoryBlacklist";
}

function defaultFlavorForSelector(
	selector: RuleTargetSelector,
	devices: readonly PermissionTargetDevice[],
	serverPathFlavor: PathFlavor,
): PathFlavor | null {
	if (selector.kind === "host") return serverPathFlavor;
	if (selector.kind === "device") {
		return devicePathFlavor(devices.find((device) => device.id === selector.deviceId));
	}
	return null;
}

function RuleRow({
	rule,
	index,
	kind,
	devices,
	showOauthGroups,
	serverPathFlavor,
	onUpdate,
	onDelete,
}: {
	rule: PermissionRuleValue;
	index: number;
	kind: PermissionRuleKind;
	devices: readonly PermissionTargetDevice[];
	showOauthGroups: boolean;
	serverPathFlavor: PathFlavor;
	onUpdate: (index: number, value: PermissionRuleValue) => void;
	onDelete: (index: number, value: PermissionRuleValue) => void;
}) {
	const { t } = useTranslation("narrator");
	const [text, setText] = useState(rule.path ?? rule.pattern ?? "");
	const [denyPrompt, setDenyPrompt] = useState(rule.denyPrompt ?? "");
	useEffect(() => setText(rule.path ?? rule.pattern ?? ""), [rule.path, rule.pattern]);
	useEffect(() => setDenyPrompt(rule.denyPrompt ?? ""), [rule.denyPrompt]);

	const patch = (next: Partial<PermissionRuleValue>) => onUpdate(index, { ...rule, ...next });
	const commitText = () => {
		const value = text.trim();
		if (!value || value === (rule.path ?? rule.pattern ?? "")) return;
		patch(isDirectory(kind) ? { path: value } : { pattern: value });
	};
	const updateSelector = (selector: RuleTargetSelector) => {
		patch({
			selector,
			...(isDirectory(kind)
				? { pathFlavor: defaultFlavorForSelector(selector, devices, serverPathFlavor) }
				: {}),
		});
	};

	return (
		<Paper withBorder p="xs" radius="sm">
			<Stack gap="xs">
				<Group gap="xs" wrap="nowrap" align="flex-start">
					<Switch
						size="xs"
						checked={rule.enabled !== false}
						onChange={(event) => patch({ enabled: event.currentTarget.checked })}
						mt={6}
					/>
					<TextInput
						size="xs"
						value={text}
						onChange={(event) => setText(event.currentTarget.value)}
						onBlur={commitText}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}}
						styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
						style={{ flex: 1 }}
					/>
					<ActionIcon variant="subtle" color="red" size="sm" onClick={() => onDelete(index, rule)}>
						<IconTrash size={15} />
					</ActionIcon>
				</Group>
				<TargetSelectorInput
					value={rule.selector}
					onChange={updateSelector}
					devices={devices}
					showOauthGroups={showOauthGroups}
				/>
				{isDirectory(kind) && (
					<Group gap="xs" wrap="wrap">
						<SegmentedControl
							size="xs"
							value={rule.pathFlavor ?? ""}
							onChange={(value) => patch({ pathFlavor: value as PathFlavor })}
							data={[
								{ value: "posix", label: t("permissionPathFlavorPosix") },
								{ value: "windows", label: t("permissionPathFlavorWindows") },
							]}
						/>
						{!rule.pathFlavor && (
							<Text size="xs" c="orange">
								{t("permissionPathFlavorRequired")}
							</Text>
						)}
					</Group>
				)}
				{kind === "directoryWhitelist" && (
					<SegmentedControl
						size="xs"
						value={rule.accessLevel ?? "readOnly"}
						onChange={(value) =>
							patch({ accessLevel: value as PermissionRuleValue["accessLevel"] })
						}
						data={[
							{ value: "readOnly", label: t("whitelist_access_readOnly") },
							{ value: "readWrite", label: t("whitelist_access_readWrite") },
							{ value: "full", label: t("whitelist_access_full") },
						]}
					/>
				)}
				{kind === "directoryBlacklist" && (
					<SegmentedControl
						size="xs"
						value={rule.denyLevel ?? "denyAll"}
						onChange={(value) => patch({ denyLevel: value as PermissionRuleValue["denyLevel"] })}
						data={[
							{ value: "denyWrite", label: t("blacklist_deny_denyWrite") },
							{ value: "denyAll", label: t("blacklist_deny_denyAll") },
						]}
					/>
				)}
				{kind === "commandBlacklist" && (
					<Textarea
						size="xs"
						autosize
						minRows={1}
						maxRows={3}
						placeholder={t("cmd_deny_prompt_placeholder")}
						value={denyPrompt}
						onChange={(event) => setDenyPrompt(event.currentTarget.value)}
						onBlur={() => {
							const value = denyPrompt.trim();
							if (value !== (rule.denyPrompt ?? "")) patch({ denyPrompt: value || null });
						}}
					/>
				)}
			</Stack>
		</Paper>
	);
}

export function PermissionRuleEditor({
	rules,
	kind,
	devices,
	showOauthGroups = true,
	serverPathFlavor,
	emptyLabel,
	placeholder,
	onCreate,
	onUpdate,
	onDelete,
}: {
	rules: readonly PermissionRuleValue[];
	kind: PermissionRuleKind;
	devices: readonly PermissionTargetDevice[];
	showOauthGroups?: boolean;
	serverPathFlavor: PathFlavor;
	emptyLabel: string;
	placeholder: string;
	onCreate: (value: PermissionRuleValue) => void;
	onUpdate: (index: number, value: PermissionRuleValue) => void;
	onDelete: (index: number, value: PermissionRuleValue) => void;
}) {
	const { t } = useTranslation("narrator");
	const directory = isDirectory(kind);
	const [text, setText] = useState("");
	const [selector, setSelector] = useState<RuleTargetSelector>({ kind: "all" });
	const [pathFlavor, setPathFlavor] = useState<PathFlavor | null>(null);
	const canAdd = text.trim().length > 0 && (!directory || pathFlavor != null);

	const changeSelector = (next: RuleTargetSelector) => {
		setSelector(next);
		if (directory) setPathFlavor(defaultFlavorForSelector(next, devices, serverPathFlavor));
	};
	const add = () => {
		if (!canAdd) return;
		const value: PermissionRuleValue = {
			enabled: true,
			selector,
			...(directory ? { path: text.trim(), pathFlavor } : { pattern: text.trim() }),
			...(kind === "directoryWhitelist" ? { accessLevel: "readOnly" as const } : {}),
			...(kind === "directoryBlacklist" ? { denyLevel: "denyAll" as const } : {}),
		};
		onCreate(value);
		setText("");
	};

	return (
		<Stack gap="xs">
			{rules.length === 0 && (
				<Text size="xs" c="dimmed">
					{emptyLabel}
				</Text>
			)}
			{rules.map((rule, index) => (
				<RuleRow
					key={rule.id ?? `${rule.path ?? rule.pattern}-${index}`}
					rule={rule}
					index={index}
					kind={kind}
					devices={devices}
					showOauthGroups={showOauthGroups}
					serverPathFlavor={serverPathFlavor}
					onUpdate={onUpdate}
					onDelete={onDelete}
				/>
			))}
			<Paper withBorder p="xs" radius="sm">
				<Stack gap="xs">
					<TargetSelectorInput
						value={selector}
						onChange={changeSelector}
						devices={devices}
						showOauthGroups={showOauthGroups}
						label={t("permissionTargetLabel")}
					/>
					{directory ? (
						<TargetPathInput
							value={text}
							onChange={setText}
							selector={selector}
							pathFlavor={pathFlavor}
							onPathFlavorChange={setPathFlavor}
							devices={devices}
							placeholder={placeholder}
							error={text.trim() && !pathFlavor ? t("permissionPathFlavorRequired") : undefined}
						/>
					) : (
						<TextInput
							size="xs"
							value={text}
							onChange={(event) => setText(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") add();
							}}
							placeholder={placeholder}
						/>
					)}
					<Group justify="flex-end">
						<Button
							size="xs"
							variant="light"
							leftSection={<IconPlus size={14} />}
							disabled={!canAdd}
							onClick={add}
						>
							{t("permissionRuleAdd")}
						</Button>
					</Group>
				</Stack>
			</Paper>
		</Stack>
	);
}
