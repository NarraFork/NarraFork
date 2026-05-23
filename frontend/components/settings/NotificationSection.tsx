import {
	Badge,
	Button,
	FileInput,
	Group,
	PasswordInput,
	SegmentedControl,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import {
	BUILTIN_SOUND_NAMES,
	playBuiltinSound,
	playCustomSound,
} from "../../lib/notification-sound";

// biome-ignore lint/suspicious/noExplicitAny: dynamic prefs type
type AnyPrefs = any;
// biome-ignore lint/suspicious/noExplicitAny: mutation hook type
type AnyMutation = UseMutationResult<any, any, any, any>;

export interface NotificationSectionProps {
	userPrefs: AnyPrefs;
	updateUserPref: AnyMutation;
}

export function NotificationSection({ userPrefs, updateUserPref }: NotificationSectionProps) {
	const { t } = useTranslation("settings");
	const [pwaPermission, setPwaPermission] = useState(
		"Notification" in window ? Notification.permission : "denied",
	);
	const [testingDingtalk, setTestingDingtalk] = useState(false);
	const [testingFeishu, setTestingFeishu] = useState(false);
	const [testResult, setTestResult] = useState<{
		type: string;
		ok: boolean;
		error?: string;
	} | null>(null);
	const [dingtalkWebhook, setDingtalkWebhook] = useState("");
	const [dingtalkSecret, setDingtalkSecret] = useState("");
	const [feishuWebhook, setFeishuWebhook] = useState("");
	const [feishuSecret, setFeishuSecret] = useState("");
	const [webhookInited, setWebhookInited] = useState(false);

	useEffect(() => {
		if (userPrefs && !webhookInited) {
			setDingtalkWebhook(userPrefs.notifyDingtalkWebhook ?? "");
			setDingtalkSecret(userPrefs.notifyDingtalkSecret ?? "");
			setFeishuWebhook(userPrefs.notifyFeishuWebhook ?? "");
			setFeishuSecret(userPrefs.notifyFeishuSecret ?? "");
			setWebhookInited(true);
		}
	}, [userPrefs, webhookInited]);

	const soundOptions = BUILTIN_SOUND_NAMES.map((name) => ({
		value: name,
		label: t(`notifySound${name.charAt(0).toUpperCase()}${name.slice(1)}`),
	}));

	const handleRequestPwaPermission = async () => {
		if (!("Notification" in window)) return;
		const result = await Notification.requestPermission();
		setPwaPermission(result);
		if (result === "granted") {
			updateUserPref.mutate({ notifyPwaEnabled: true });
		}
	};

	const handleSoundUpload = async (file: File | null) => {
		if (!file) return;
		try {
			const result = await api.uploadNotificationSound(file);
			updateUserPref.mutate({
				notifySoundType: "custom",
				notifySoundFileId: result.id,
			});
		} catch {
			// upload failed — ignore
		}
	};

	const handleTestDingtalk = async () => {
		setTestingDingtalk(true);
		setTestResult(null);
		try {
			const res = await api.testDingtalkWebhook(dingtalkWebhook, dingtalkSecret);
			setTestResult({
				type: "dingtalk",
				ok: res.ok,
				error: res.message ?? res.reason ?? res.error ?? res.code,
			});
		} catch (err) {
			setTestResult({
				type: "dingtalk",
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		setTestingDingtalk(false);
	};

	const handleTestFeishu = async () => {
		setTestingFeishu(true);
		setTestResult(null);
		try {
			const res = await api.testFeishuWebhook(feishuWebhook, feishuSecret);
			setTestResult({
				type: "feishu",
				ok: res.ok,
				error: res.message ?? res.reason ?? res.error ?? res.code,
			});
		} catch (err) {
			setTestResult({
				type: "feishu",
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		setTestingFeishu(false);
	};

	const saveWebhookField = (field: string, value: string) => {
		if (value.startsWith("*")) return;
		updateUserPref.mutate({ [field]: value || "" });
	};

	return (
		<Stack>
			{/* Trigger toggles */}
			<Switch
				label={t("notifyOnDone")}
				description={t("notifyOnDoneDesc")}
				checked={userPrefs?.notifyOnDone ?? true}
				onChange={(e) => updateUserPref.mutate({ notifyOnDone: e.currentTarget.checked })}
			/>
			<Switch
				label={t("notifyOnWaiting")}
				description={t("notifyOnWaitingDesc")}
				checked={userPrefs?.notifyOnWaiting ?? true}
				onChange={(e) =>
					updateUserPref.mutate({
						notifyOnWaiting: e.currentTarget.checked,
					})
				}
			/>

			{/* PWA notifications */}
			<Stack gap="xs" mt="sm">
				<Text size="sm" fw={600}>
					{t("notifyPwaEnabled")}
				</Text>
				<Switch
					label={t("notifyPwaEnabledDesc")}
					checked={userPrefs?.notifyPwaEnabled ?? false}
					onChange={(e) =>
						updateUserPref.mutate({
							notifyPwaEnabled: e.currentTarget.checked,
						})
					}
					disabled={pwaPermission === "denied"}
				/>
				{pwaPermission === "default" && (
					<Button variant="light" size="xs" onClick={handleRequestPwaPermission}>
						{t("notifyPwaRequestPermission")}
					</Button>
				)}
				{pwaPermission === "granted" && (
					<Badge color="green" variant="light" size="sm">
						{t("notifyPwaPermissionGranted")}
					</Badge>
				)}
				{pwaPermission === "denied" && (
					<Text size="xs" c="dimmed">
						{t("notifyPwaPermissionDenied")}
					</Text>
				)}
			</Stack>

			{/* Sound notifications */}
			<Stack gap="xs" mt="sm">
				<Text size="sm" fw={600}>
					{t("notifySoundEnabled")}
				</Text>
				<Switch
					label={t("notifySoundEnabled")}
					checked={userPrefs?.notifySoundEnabled ?? true}
					onChange={(e) =>
						updateUserPref.mutate({
							notifySoundEnabled: e.currentTarget.checked,
						})
					}
				/>
				{(userPrefs?.notifySoundEnabled ?? true) && (
					<>
						<SegmentedControl
							value={userPrefs?.notifySoundType ?? "builtin"}
							onChange={(v) =>
								updateUserPref.mutate({
									notifySoundType: v as "builtin" | "custom",
								})
							}
							data={[
								{ value: "builtin", label: t("notifySoundBuiltin") },
								{ value: "custom", label: t("notifySoundCustom") },
							]}
							size="xs"
						/>
						{(userPrefs?.notifySoundType ?? "builtin") === "builtin" ? (
							<Group>
								<Select
									data={soundOptions}
									value={userPrefs?.notifySoundBuiltin ?? "gentle"}
									onChange={(v) =>
										updateUserPref.mutate({
											notifySoundBuiltin: v ?? "gentle",
										})
									}
									size="xs"
									style={{ flex: 1 }}
								/>
								<Button
									variant="subtle"
									size="xs"
									leftSection={<IconPlayerPlay size={14} />}
									onClick={() => playBuiltinSound(userPrefs?.notifySoundBuiltin ?? "gentle")}
								>
									{t("notifySoundPreview")}
								</Button>
							</Group>
						) : (
							<Group>
								<FileInput
									placeholder={t("notifySoundUpload")}
									description={t("notifySoundUploadDesc")}
									accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/webm"
									onChange={handleSoundUpload}
									size="xs"
									style={{ flex: 1 }}
								/>
								{userPrefs?.notifySoundFileId && (
									<Button
										variant="subtle"
										size="xs"
										leftSection={<IconPlayerPlay size={14} />}
										onClick={() =>
											playCustomSound(`/api/notification-sounds/${userPrefs.notifySoundFileId}`)
										}
									>
										{t("notifySoundPreview")}
									</Button>
								)}
							</Group>
						)}
					</>
				)}
			</Stack>

			{/* DingTalk */}
			<Stack gap="xs" mt="sm">
				<Text size="sm" fw={600}>
					{t("notifyDingtalkSection")}
				</Text>
				<Switch
					label={t("notifyDingtalkEnabled")}
					checked={userPrefs?.notifyDingtalkEnabled ?? false}
					onChange={(e) =>
						updateUserPref.mutate({
							notifyDingtalkEnabled: e.currentTarget.checked,
						})
					}
				/>
				{(userPrefs?.notifyDingtalkEnabled ?? false) && (
					<>
						<TextInput
							label={t("notifyDingtalkWebhook")}
							placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
							value={dingtalkWebhook}
							onChange={(e) => setDingtalkWebhook(e.currentTarget.value)}
							onBlur={() => saveWebhookField("notifyDingtalkWebhook", dingtalkWebhook)}
							size="xs"
						/>
						<PasswordInput
							label={t("notifyDingtalkSecret")}
							description={t("notifyDingtalkSecretDesc")}
							placeholder="SEC..."
							value={dingtalkSecret}
							autoComplete="off"
							onChange={(e) => setDingtalkSecret(e.currentTarget.value)}
							onBlur={() => saveWebhookField("notifyDingtalkSecret", dingtalkSecret)}
							size="xs"
						/>
						<Group>
							<Button
								variant="light"
								size="xs"
								loading={testingDingtalk}
								onClick={handleTestDingtalk}
								disabled={!dingtalkWebhook || dingtalkWebhook.startsWith("*")}
							>
								{t("notifyTestConnection")}
							</Button>
							{testResult?.type === "dingtalk" && (
								<Text size="xs" c={testResult.ok ? "green" : "red"}>
									{testResult.ok
										? t("notifyTestSuccess")
										: t("notifyTestFailed", { error: testResult.error })}
								</Text>
							)}
						</Group>
					</>
				)}
			</Stack>

			{/* Feishu */}
			<Stack gap="xs" mt="sm">
				<Text size="sm" fw={600}>
					{t("notifyFeishuSection")}
				</Text>
				<Switch
					label={t("notifyFeishuEnabled")}
					checked={userPrefs?.notifyFeishuEnabled ?? false}
					onChange={(e) =>
						updateUserPref.mutate({
							notifyFeishuEnabled: e.currentTarget.checked,
						})
					}
				/>
				{(userPrefs?.notifyFeishuEnabled ?? false) && (
					<>
						<TextInput
							label={t("notifyFeishuWebhook")}
							placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
							value={feishuWebhook}
							onChange={(e) => setFeishuWebhook(e.currentTarget.value)}
							onBlur={() => saveWebhookField("notifyFeishuWebhook", feishuWebhook)}
							size="xs"
						/>
						<PasswordInput
							label={t("notifyFeishuSecret")}
							description={t("notifyFeishuSecretDesc")}
							value={feishuSecret}
							autoComplete="off"
							onChange={(e) => setFeishuSecret(e.currentTarget.value)}
							onBlur={() => saveWebhookField("notifyFeishuSecret", feishuSecret)}
							size="xs"
						/>
						<Group>
							<Button
								variant="light"
								size="xs"
								loading={testingFeishu}
								onClick={handleTestFeishu}
								disabled={!feishuWebhook || feishuWebhook.startsWith("*")}
							>
								{t("notifyTestConnection")}
							</Button>
							{testResult?.type === "feishu" && (
								<Text size="xs" c={testResult.ok ? "green" : "red"}>
									{testResult.ok
										? t("notifyTestSuccess")
										: t("notifyTestFailed", { error: testResult.error })}
								</Text>
							)}
						</Group>
					</>
				)}
			</Stack>
		</Stack>
	);
}
