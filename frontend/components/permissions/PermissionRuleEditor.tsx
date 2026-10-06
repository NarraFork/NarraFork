import {
	ActionIcon,
	Anchor,
	Collapse,
	Group,
	Paper,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
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

/** One-line summary of where a new rule will apply, shown instead of a picker. */
function describeSelector(
	selector: RuleTargetSelector,
	devices: readonly PermissionTargetDevice[],
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	switch (selector.kind) {
		case "all":
			return t("permissionTargetSummaryAll");
		case "host":
			return t("permissionTargetSummaryHost");
		case "device":
			return t("permissionTargetSummaryDevice", {
				device:
					devices.find((device) => device.id === selector.deviceId)?.name ?? selector.deviceId,
			});
		case "oauthGroup":
			return t("permissionTargetSummaryOauth");
	}
}

function RuleRow({
	rule,
	index,
	kind,
	devices,
	showOauthGroups,
	serverPathFlavor,
	narratorId,
	placeholder,
	onUpdate,
	onDelete,
}: {
	rule: PermissionRuleValue;
	index: number;
	kind: PermissionRuleKind;
	devices: readonly PermissionTargetDevice[];
	showOauthGroups: boolean;
	serverPathFlavor: PathFlavor;
	narratorId?: string;
	placeholder: string;
	onUpdate: (index: number, value: PermissionRuleValue) => void;
	onDelete: (index: number, value: PermissionRuleValue) => void;
}) {
	const { t } = useTranslation("narrator");
	const [text, setText] = useState(rule.path ?? rule.pattern ?? "");
	const [targetOpen, setTargetOpen] = useState(false);
	const [denyPrompt, setDenyPrompt] = useState(rule.denyPrompt ?? "");
	useEffect(() => setText(rule.path ?? rule.pattern ?? ""), [rule.path, rule.pattern]);
	useEffect(() => setDenyPrompt(rule.denyPrompt ?? ""), [rule.denyPrompt]);

	const patch = (next: Partial<PermissionRuleValue>) => onUpdate(index, { ...rule, ...next });
	// `next` lets a directory-browser selection commit the path it just chose,
	// which lands in the same tick as its onChange and so isn't in `text` yet.
	const commitText = (next?: string) => {
		const value = (next ?? text).trim();
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
					{isDirectory(kind) ? (
						// Existing rules get the same autocomplete + browser as new ones;
						// editing a saved path used to be a bare text box.
						<TargetPathInput
							value={text}
							onChange={setText}
							onCommit={commitText}
							selector={rule.selector}
							pathFlavor={rule.pathFlavor ?? null}
							onPathFlavorChange={(flavor) => patch({ pathFlavor: flavor })}
							devices={devices}
							narratorId={narratorId}
							placeholder={placeholder}
							error={!rule.pathFlavor ? t("permissionPathFlavorRequired") : undefined}
							showFlavorSelect={false}
							showHint={false}
						/>
					) : (
						<TextInput
							size="xs"
							value={text}
							onChange={(event) => setText(event.currentTarget.value)}
							onBlur={() => commitText()}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
							style={{ flex: 1 }}
						/>
					)}
					<ActionIcon
						variant="subtle"
						color="red"
						size="sm"
						mt={4}
						onClick={() => onDelete(index, rule)}
					>
						<IconTrash size={15} />
					</ActionIcon>
				</Group>
				{/* The target is a summary line by default; most rules never change it. */}
				<Group gap={6} wrap="nowrap" justify="space-between">
					<Text size="xs" c="dimmed" truncate>
						{describeSelector(rule.selector, devices, t)}
					</Text>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						onClick={() => setTargetOpen((open) => !open)}
					>
						{targetOpen ? t("permissionTargetHide") : t("permissionTargetChange")}
					</Anchor>
				</Group>
				<Collapse expanded={targetOpen}>
					<Stack gap="xs" pt={4}>
						<TargetSelectorInput
							value={rule.selector}
							onChange={updateSelector}
							devices={devices}
							showOauthGroups={showOauthGroups}
							label={t("permissionTargetLabel")}
						/>
						{isDirectory(kind) && (
							<Select
								size="xs"
								label={t("permissionPathFlavorLabel")}
								value={rule.pathFlavor ?? null}
								onChange={(value) => value && patch({ pathFlavor: value as PathFlavor })}
								data={[
									{ value: "posix", label: t("permissionPathFlavorPosix") },
									{ value: "windows", label: t("permissionPathFlavorWindows") },
								]}
								placeholder={t("permissionPathFlavorSelect")}
								allowDeselect={false}
								comboboxProps={{ withinPortal: true }}
							/>
						)}
					</Stack>
				</Collapse>
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
	narratorId,
	defaultDeviceId,
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
	/**
	 * Authorizes remote device browsing through this narrator instead of the
	 * admin-only device API. Omit in admin contexts (global/project settings).
	 */
	narratorId?: string;
	/**
	 * The session's current execution target. New rules default to it, so the
	 * usual "allow this directory here" flow needs no target selection.
	 */
	defaultDeviceId?: string | null;
	emptyLabel: string;
	placeholder: string;
	onCreate: (value: PermissionRuleValue) => void;
	onUpdate: (index: number, value: PermissionRuleValue) => void;
	onDelete: (index: number, value: PermissionRuleValue) => void;
}) {
	const { t } = useTranslation("narrator");
	const directory = isDirectory(kind);
	const [text, setText] = useState("");
	// New rules target whatever the session currently runs on, so the common case
	// ("whitelist this directory") needs no target picking at all. Anything more
	// specific stays available behind the advanced toggle below.
	const defaultSelector = useMemo<RuleTargetSelector>(
		() =>
			defaultDeviceId && devices.some((device) => device.id === defaultDeviceId)
				? { kind: "device", deviceId: defaultDeviceId }
				: { kind: "host" },
		[defaultDeviceId, devices],
	);
	const [selectorOverride, setSelectorOverride] = useState<RuleTargetSelector | null>(null);
	const selector = selectorOverride ?? defaultSelector;
	const [flavorOverride, setFlavorOverride] = useState<PathFlavor | null>(null);
	// Derived from the target unless explicitly overridden, so switching devices
	// keeps the flavor correct without the user re-picking it.
	const pathFlavor =
		flavorOverride ?? defaultFlavorForSelector(selector, devices, serverPathFlavor);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const canAdd = text.trim().length > 0 && (!directory || pathFlavor != null);

	const changeSelector = (next: RuleTargetSelector) => {
		setSelectorOverride(next);
		// Drop a stale manual flavor so it re-derives from the new target.
		setFlavorOverride(null);
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
		// Keep the chosen target for the next rule — users usually add several in
		// a row for the same machine.
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
					narratorId={narratorId}
					placeholder={placeholder}
					onUpdate={onUpdate}
					onDelete={onDelete}
				/>
			))}
			<Paper withBorder p="xs" radius="sm">
				<Stack gap={6}>
					<Group gap="xs" wrap="nowrap" align="flex-start">
						{directory ? (
							<TargetPathInput
								value={text}
								onChange={setText}
								onSubmit={add}
								selector={selector}
								pathFlavor={pathFlavor}
								onPathFlavorChange={setFlavorOverride}
								devices={devices}
								narratorId={narratorId}
								placeholder={placeholder}
								// The flavor is derived, so it can only be missing when the
								// target spans machines and the user hasn't chosen one.
								error={text.trim() && !pathFlavor ? t("permissionPathFlavorRequired") : undefined}
								showFlavorSelect={false}
								showHint={false}
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
								style={{ flex: 1 }}
							/>
						)}
						<Tooltip label={t("permissionRuleAdd")}>
							<ActionIcon
								variant="light"
								size="lg"
								disabled={!canAdd}
								onClick={add}
								aria-label={t("permissionRuleAdd")}
							>
								<IconPlus size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
					<Group gap={6} wrap="nowrap" justify="space-between">
						<Text size="xs" c="dimmed" truncate>
							{describeSelector(selector, devices, t)}
						</Text>
						<Anchor
							component="button"
							type="button"
							size="xs"
							c="dimmed"
							onClick={() => setAdvancedOpen((open) => !open)}
						>
							{advancedOpen ? t("permissionTargetHide") : t("permissionTargetChange")}
						</Anchor>
					</Group>
					<Collapse expanded={advancedOpen}>
						<Stack gap="xs" pt={4}>
							<TargetSelectorInput
								value={selector}
								onChange={changeSelector}
								devices={devices}
								showOauthGroups={showOauthGroups}
								label={t("permissionTargetLabel")}
							/>
							{directory && (
								<Select
									size="xs"
									label={t("permissionPathFlavorLabel")}
									value={pathFlavor}
									onChange={(next) => next && setFlavorOverride(next as PathFlavor)}
									data={[
										{ value: "posix", label: t("permissionPathFlavorPosix") },
										{ value: "windows", label: t("permissionPathFlavorWindows") },
									]}
									placeholder={t("permissionPathFlavorSelect")}
									allowDeselect={false}
									comboboxProps={{ withinPortal: true }}
								/>
							)}
						</Stack>
					</Collapse>
				</Stack>
			</Paper>
		</Stack>
	);
}
