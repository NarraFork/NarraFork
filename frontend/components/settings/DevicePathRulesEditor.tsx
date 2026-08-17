import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	Modal,
	Paper,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { type ExecutorPathRule, validateExecutorPathRules } from "@shared/executor-path-rules";
import {
	IconAlertTriangle,
	IconArrowDown,
	IconArrowUp,
	IconFolderOpen,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { RemoteDevice } from "../../lib/api/devices";
import { CopyButton } from "../common/CopyButton";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "../common/directory-browser-modal";

const RemoteDirectoryBrowser = lazy(() =>
	import("../permissions/RemoteDirectoryBrowser").then((module) => ({
		default: module.RemoteDirectoryBrowser,
	})),
);

/** Same-length, same-order comparison; used to detect unsaved and drifted state. */
function rulesEqual(left: readonly ExecutorPathRule[], right: readonly ExecutorPathRule[]) {
	if (left.length !== right.length) return false;
	return left.every(
		(rule, index) => rule.action === right[index].action && rule.path === right[index].path,
	);
}

/**
 * Ordered path guard editor for a remote executor device.
 *
 * Two things this UI must not misrepresent:
 *
 * 1. **Order is the policy.** The last matching rule wins, so the list is
 *    explicitly ordered with move up/down controls rather than being sorted for
 *    tidiness. Sorting would silently change which rule decides.
 * 2. **Saving here does not enforce anything.** The executor reads its rules from
 *    its own config file on the target machine — that is what makes the guard
 *    survive a compromised server. So the UI shows the config snippet, says a
 *    restart is required, and flags drift against what the device reports.
 */
export function DevicePathRulesEditor({ device }: { device: RemoteDevice }) {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const queryClient = useQueryClient();
	const [rules, setRules] = useState<ExecutorPathRule[]>([]);
	const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);
	const [browserOpened, browser] = useDisclosure(false);

	const queryKey = ["devicePathRules", device.id];
	const { data, isLoading } = useQuery({
		queryKey,
		queryFn: () => api.getDevicePathRules(device.id),
	});

	// Reset local edits whenever the server state changes identity, so a saved or
	// externally-changed list is not silently overwritten by a stale draft.
	useEffect(() => {
		if (data) setRules(data.rules);
	}, [data]);

	const saveMut = useMutation({
		mutationFn: () => api.updateDevicePathRules(device.id, rules),
		onSuccess: (result) => {
			queryClient.setQueryData(queryKey, result);
			queryClient.invalidateQueries({ queryKey: ["devices"] });
			notifications.show({ message: t("devicePathRulesSaved"), color: "green" });
		},
		onError: (error) =>
			notifications.show({
				message: error instanceof Error ? error.message : String(error),
				color: "red",
			}),
	});

	const validation = validateExecutorPathRules(rules);
	const problemIndexes = new Set(validation.problems.map((problem) => problem.index));
	const dirty = data ? !rulesEqual(rules, data.rules) : false;
	// Drift is only meaningful once the device has actually reported its rules.
	const drifted =
		data?.reportedRules != null && !rulesEqual(data.rules, data.reportedRules) && !dirty;

	const update = (index: number, patch: Partial<ExecutorPathRule>) =>
		setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

	const move = (index: number, delta: number) =>
		setRules((current) => {
			const target = index + delta;
			if (target < 0 || target >= current.length) return current;
			const next = [...current];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		});

	if (isLoading) return <Loader size="sm" />;

	return (
		<Stack gap="xs">
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<Text fw={500}>{t("devicePathRules")}</Text>
					{drifted ? (
						<Tooltip label={t("devicePathRulesDriftHelp")} multiline w={320}>
							<Badge color="orange" variant="light">
								{t("devicePathRulesDrift")}
							</Badge>
						</Tooltip>
					) : null}
				</Group>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={() => setRules((current) => [...current, { action: "allow", path: "" }])}
				>
					{t("devicePathRulesAdd")}
				</Button>
			</Group>

			<Text size="xs" c="dimmed">
				{t("devicePathRulesHelp")}
			</Text>

			{rules.length === 0 ? (
				<Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
					{t("devicePathRulesUnrestricted")}
				</Alert>
			) : (
				<Stack gap={6}>
					{rules.map((rule, index) => (
						// Index is the identity here: rules are an ordered list where
						// duplicates are legal, so no stabler key exists.
						// biome-ignore lint/suspicious/noArrayIndexKey: order IS the identity
						<Paper key={index} withBorder p="xs">
							<Group gap="xs" wrap="nowrap">
								<Text size="xs" c="dimmed" w={18} ta="right">
									{index + 1}
								</Text>
								<SegmentedControl
									size="xs"
									value={rule.action}
									onChange={(value) =>
										update(index, { action: value as ExecutorPathRule["action"] })
									}
									data={[
										{ value: "allow", label: t("devicePathRuleAllow") },
										{ value: "deny", label: t("devicePathRuleDeny") },
									]}
								/>
								<TextInput
									style={{ flex: 1 }}
									size="xs"
									error={problemIndexes.has(index)}
									placeholder={
										device.platformOs === "windows" ? "C:\\work\\projects" : "/home/you/projects"
									}
									value={rule.path}
									onChange={(event) => update(index, { path: event.currentTarget.value })}
								/>
								<Tooltip label={t("devicePathRulesBrowse")}>
									<ActionIcon
										variant="subtle"
										size="sm"
										disabled={device.status !== "online"}
										onClick={() => {
											setBrowsingIndex(index);
											browser.open();
										}}
									>
										<IconFolderOpen size={16} />
									</ActionIcon>
								</Tooltip>
								<ActionIcon
									variant="subtle"
									size="sm"
									disabled={index === 0}
									onClick={() => move(index, -1)}
									aria-label={t("devicePathRulesMoveUp")}
								>
									<IconArrowUp size={16} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									size="sm"
									disabled={index === rules.length - 1}
									onClick={() => move(index, 1)}
									aria-label={t("devicePathRulesMoveDown")}
								>
									<IconArrowDown size={16} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
									aria-label={tc("delete")}
								>
									<IconTrash size={16} />
								</ActionIcon>
							</Group>
						</Paper>
					))}
					<Text size="xs" c="dimmed">
						{t("devicePathRulesOrderHelp")}
					</Text>
				</Stack>
			)}

			{validation.problems.length > 0 ? (
				<Alert color="red" variant="light">
					{validation.problems
						.map((problem) => `#${problem.index + 1}: ${problem.message}`)
						.join(" · ")}
				</Alert>
			) : null}

			<Group justify="space-between" align="center">
				<Text size="xs" c="dimmed">
					{dirty ? t("devicePathRulesUnsaved") : ""}
				</Text>
				<Button
					size="xs"
					loading={saveMut.isPending}
					disabled={!validation.ok || !dirty}
					onClick={() => saveMut.mutate()}
				>
					{tc("save")}
				</Button>
			</Group>

			{data?.configSnippet ? (
				<Paper withBorder p="xs">
					<Stack gap={6}>
						<Text size="xs" fw={500}>
							{t("devicePathRulesApplyTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("devicePathRulesApplyHelp")}
						</Text>
						<Code block style={{ fontSize: 11, maxHeight: 180, overflow: "auto" }}>
							{data.configSnippet}
						</Code>
						<Group>
							<CopyButton value={data.configSnippet}>
								{({ copied, copy }) => (
									<Button size="xs" variant="light" onClick={copy}>
										{copied ? tc("copied") : t("devicePathRulesCopyConfig")}
									</Button>
								)}
							</CopyButton>
						</Group>
					</Stack>
				</Paper>
			) : null}

			<Modal
				opened={browserOpened}
				onClose={browser.close}
				title={t("devicePathRulesBrowse")}
				size="lg"
				styles={DIRECTORY_BROWSER_MODAL_STYLES}
			>
				{browserOpened && browsingIndex !== null ? (
					<Suspense fallback={<Loader size="sm" />}>
						<RemoteDirectoryBrowser
							deviceLabel={device.name}
							initialPath={rules[browsingIndex]?.path.trim() || undefined}
							listDirectory={(path, opts) => api.browseDevicePath(device.id, path, opts)}
							queryKey={["deviceBrowse", device.id]}
							onSelect={(path) => {
								update(browsingIndex, { path });
								browser.close();
							}}
							onCancel={browser.close}
						/>
					</Suspense>
				) : null}
			</Modal>
		</Stack>
	);
}
