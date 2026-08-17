import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Divider,
	Group,
	Loader,
	MultiSelect,
	Select,
	Stack,
	Switch,
	TagsInput,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { LayerDeviceInjection, TraitLayer } from "../../lib/api/trait-layers";

/**
 * Editor for one trait layer (project or user).
 *
 * The same payload shapes back all three layers, so this component covers the two
 * upper ones and the narrator panel keeps its own inline editor.
 *
 * Two concepts the UI has to make legible:
 *
 * - **Enforced vs default.** A restriction can be a boundary that lower-priority
 *   layers may not relax, or merely a default they may override. That is a real
 *   distinction in the resolver, so it gets an explicit switch rather than being
 *   hidden behind wording.
 * - **Device injection is tri-state.** "Inherit" is not the same as "off": the
 *   former defers to the layer below, the latter actively suppresses.
 */
export function TraitLayerEditor({
	layer,
	ownerId,
	/** Devices to offer per-device injection overrides for. */
	devices,
}: {
	layer: TraitLayer;
	ownerId: string;
	devices?: Array<{ id: string; name: string }>;
}) {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const qc = useQueryClient();
	const queryKey = ["traitLayer", layer, ownerId];

	const { data, isLoading } = useQuery({
		queryKey,
		queryFn: () => api.getLayerTraits(layer, ownerId),
		enabled: !!ownerId,
	});

	const [tools, setTools] = useState<string[]>([]);
	const [toolsEnforced, setToolsEnforced] = useState(false);
	const [skillNames, setSkillNames] = useState<string[]>([]);
	const [allSkillsBlocked, setAllSkillsBlocked] = useState(false);
	const [skillsEnforced, setSkillsEnforced] = useState(false);
	const [injectionMode, setInjectionMode] = useState<LayerDeviceInjection["defaultMode"]>("global");
	const [deviceOverrides, setDeviceOverrides] = useState<Record<string, "on" | "off">>({});

	// Reset local edit state whenever the server view changes, so a save or a
	// layer switch never leaves stale values in the form.
	useEffect(() => {
		if (!data) return;
		setTools(data.customTraits.disabledTools?.tools ?? []);
		setToolsEnforced(data.enforced.disabledTools);
		setSkillNames(data.customTraits.blockedSkills?.names ?? []);
		setAllSkillsBlocked(data.customTraits.blockedSkills?.all ?? false);
		setSkillsEnforced(data.enforced.blockedSkills);
		setInjectionMode(data.deviceInjection?.defaultMode ?? "global");
		setDeviceOverrides(data.deviceInjection?.devices ?? {});
	}, [data]);

	const toolOptions = useMemo(
		() =>
			(data?.customTraits.availableTools ?? []).map((tool) => ({
				value: tool.name,
				label: tool.description ? `${tool.name} — ${tool.description}` : tool.name,
			})),
		[data?.customTraits.availableTools],
	);

	function onError(error: unknown) {
		notifications.show({
			color: "red",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	function onSaved() {
		qc.invalidateQueries({ queryKey });
		notifications.show({ color: "green", message: t("traitLayerSaved") });
	}

	const saveTools = useMutation({
		mutationFn: () =>
			api.updateLayerDisabledTools(layer, ownerId, { tools, enforced: toolsEnforced }),
		onSuccess: onSaved,
		onError,
	});
	const clearTools = useMutation({
		mutationFn: () => api.clearLayerDisabledTools(layer, ownerId),
		onSuccess: onSaved,
		onError,
	});
	const saveSkills = useMutation({
		mutationFn: () =>
			api.updateLayerBlockedSkills(layer, ownerId, {
				all: allSkillsBlocked,
				names: skillNames,
				enforced: skillsEnforced,
			}),
		onSuccess: onSaved,
		onError,
	});
	const clearSkills = useMutation({
		mutationFn: () => api.clearLayerBlockedSkills(layer, ownerId),
		onSuccess: onSaved,
		onError,
	});
	const saveInjection = useMutation({
		mutationFn: () =>
			api.updateLayerDeviceInjection(layer, ownerId, {
				defaultMode: injectionMode,
				devices: deviceOverrides,
			}),
		onSuccess: onSaved,
		onError,
	});
	const clearInjection = useMutation({
		mutationFn: () => api.clearLayerDeviceInjection(layer, ownerId),
		onSuccess: onSaved,
		onError,
	});

	if (isLoading) return <Loader size="sm" />;

	function deviceToggle(deviceId: string): "inherit" | "on" | "off" {
		return deviceOverrides[deviceId] ?? "inherit";
	}

	function setDeviceToggle(deviceId: string, value: "inherit" | "on" | "off") {
		setDeviceOverrides((current) => {
			const next = { ...current };
			// "inherit" is the absence of an override, so it is stored by removal.
			if (value === "inherit") delete next[deviceId];
			else next[deviceId] = value;
			return next;
		});
	}

	return (
		<Stack gap="md">
			<Alert color="blue" variant="light">
				{layer === "project" ? t("traitLayerProjectIntro") : t("traitLayerUserIntro")}
			</Alert>

			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("traitLayerToolRestriction")}
					</Text>
					{toolsEnforced ? (
						<Badge color="orange" variant="light" size="sm">
							{t("traitLayerEnforcedBadge")}
						</Badge>
					) : null}
				</Group>
				<Text size="xs" c="dimmed">
					{t("traitLayerToolRestrictionDesc")}
				</Text>
				<MultiSelect
					data={toolOptions}
					searchable
					clearable
					value={tools}
					onChange={setTools}
					placeholder={t("traitLayerToolsPlaceholder")}
				/>
				<Tooltip label={t("traitLayerEnforcedHelp")} multiline w={320}>
					<Switch
						checked={toolsEnforced}
						onChange={(event) => setToolsEnforced(event.currentTarget.checked)}
						label={t("traitLayerEnforcedLabel")}
					/>
				</Tooltip>
				<Group justify="flex-end" gap="xs">
					<Button
						variant="default"
						size="xs"
						loading={clearTools.isPending}
						onClick={() => clearTools.mutate()}
					>
						{t("traitLayerClear")}
					</Button>
					<Button size="xs" loading={saveTools.isPending} onClick={() => saveTools.mutate()}>
						{tc("save")}
					</Button>
				</Group>
			</Stack>

			<Divider />

			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("traitLayerSkillRestriction")}
					</Text>
					{skillsEnforced ? (
						<Badge color="orange" variant="light" size="sm">
							{t("traitLayerEnforcedBadge")}
						</Badge>
					) : null}
				</Group>
				<Text size="xs" c="dimmed">
					{t("traitLayerSkillRestrictionDesc")}
				</Text>
				<Checkbox
					checked={allSkillsBlocked}
					onChange={(event) => setAllSkillsBlocked(event.currentTarget.checked)}
					label={t("traitLayerBlockAllSkills")}
				/>
				{/* Skill names are free-form (declared in SKILL.md), so this is a tag input
				    rather than a fixed-option select. */}
				<TagsInput
					value={skillNames}
					onChange={setSkillNames}
					clearable
					disabled={allSkillsBlocked}
					placeholder={t("traitLayerSkillsPlaceholder")}
				/>
				<Tooltip label={t("traitLayerEnforcedHelp")} multiline w={320}>
					<Switch
						checked={skillsEnforced}
						onChange={(event) => setSkillsEnforced(event.currentTarget.checked)}
						label={t("traitLayerEnforcedLabel")}
					/>
				</Tooltip>
				<Group justify="flex-end" gap="xs">
					<Button
						variant="default"
						size="xs"
						loading={clearSkills.isPending}
						onClick={() => clearSkills.mutate()}
					>
						{t("traitLayerClear")}
					</Button>
					<Button size="xs" loading={saveSkills.isPending} onClick={() => saveSkills.mutate()}>
						{tc("save")}
					</Button>
				</Group>
			</Stack>

			<Divider />

			<Stack gap="xs">
				<Text size="sm" fw={600}>
					{t("traitLayerDeviceInjection")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("traitLayerDeviceInjectionDesc")}
				</Text>
				<Select
					label={t("traitLayerInjectionMode")}
					data={[
						{ value: "global", label: t("traitLayerInjectionGlobal") },
						{ value: "all", label: t("traitLayerInjectionAll") },
						{ value: "private", label: t("traitLayerInjectionPrivate") },
						{ value: "none", label: t("traitLayerInjectionNone") },
					]}
					value={injectionMode}
					onChange={(value) =>
						setInjectionMode((value as LayerDeviceInjection["defaultMode"]) ?? "global")
					}
					allowDeselect={false}
				/>
				{devices && devices.length > 0 ? (
					<Stack gap={4}>
						<Text size="xs" c="dimmed">
							{t("traitLayerPerDeviceDesc")}
						</Text>
						{devices.map((device) => (
							<Group key={device.id} justify="space-between" wrap="nowrap">
								<Text size="sm" style={{ minWidth: 0 }}>
									{device.name}
								</Text>
								<Select
									size="xs"
									w={140}
									data={[
										{ value: "inherit", label: t("traitLayerToggleInherit") },
										{ value: "on", label: t("traitLayerToggleOn") },
										{ value: "off", label: t("traitLayerToggleOff") },
									]}
									value={deviceToggle(device.id)}
									onChange={(value) =>
										setDeviceToggle(device.id, (value as "inherit" | "on" | "off") ?? "inherit")
									}
									allowDeselect={false}
								/>
							</Group>
						))}
					</Stack>
				) : null}
				<Group justify="flex-end" gap="xs">
					<Button
						variant="default"
						size="xs"
						loading={clearInjection.isPending}
						onClick={() => clearInjection.mutate()}
					>
						{t("traitLayerClear")}
					</Button>
					<Button
						size="xs"
						loading={saveInjection.isPending}
						onClick={() => saveInjection.mutate()}
					>
						{tc("save")}
					</Button>
				</Group>
			</Stack>
		</Stack>
	);
}
