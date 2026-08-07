import {
	Badge,
	Button,
	FileInput,
	Group,
	NumberInput,
	PasswordInput,
	SegmentedControl,
	Select,
	Slider,
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
	DEFAULT_SOUND_MAX_CONCURRENT,
	DEFAULT_SOUND_VOLUME,
	MAX_SOUND_MAX_CONCURRENT,
	MIN_SOUND_MAX_CONCURRENT,
	playBuiltinSound,
	playCustomSound,
} from "../../lib/notification-sound";
import { normalizeUrlProtocol } from "../../lib/url";

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
	// Local slider value so dragging stays smooth. Held until the saved preference
	// catches up (see below) rather than cleared on release: the mutation has no
	// optimistic update, so dropping it at release time would snap the thumb back
	// to the old value for the duration of the request and then jump forward again.
	const [volumeDraft, setVolumeDraft] = useState<number | null>(null);

	useEffect(() => {
		if (userPrefs && !webhookInited) {
			setDingtalkWebhook(userPrefs.notifyDingtalkWebhook ?? "");
			setDingtalkSecret(userPrefs.notifyDingtalkSecret ?? "");
			setFeishuWebhook(userPrefs.notifyFeishuWebhook ?? "");
			setFeishuSecret(userPrefs.notifyFeishuSecret ?? "");
			setWebhookInited(true);
		}
	}, [userPrefs, webhookInited]);

	// Hand control back to the stored value once it agrees with the draft. Keyed on
	// equality rather than on the request finishing, because the hook invalidates
	// without awaiting the refetch — so the fresh value can arrive well after the
	// mutation resolves.
	useEffect(() => {
		if (volumeDraft !== null && userPrefs?.notifySoundVolume === volumeDraft) {
			setVolumeDraft(null);
		}
	}, [userPrefs?.notifySoundVolume, volumeDraft]);

	const soundVolume = volumeDraft ?? userPrefs?.notifySoundVolume ?? DEFAULT_SOUND_VOLUME;
	const soundMaxConcurrent = userPrefs?.notifySoundMaxConcurrent ?? DEFAULT_SOUND_MAX_CONCURRENT;
	// Previews bypass the concurrency limit so repeated clicks always sound.
	const previewOptions = { volume: soundVolume, bypassLimit: true };

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
		const webhook = normalizeUrlProtocol(dingtalkWebhook) ?? "";
		if (webhook !== dingtalkWebhook) setDingtalkWebhook(webhook);
		try {
			const res = await api.testDingtalkWebhook(webhook, dingtalkSecret);
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
		const webhook = normalizeUrlProtocol(feishuWebhook) ?? "";
		if (webhook !== feishuWebhook) setFeishuWebhook(webhook);
		try {
			const res = await api.testFeishuWebhook(webhook, feishuSecret);
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
		const normalizedValue = field.endsWith("Webhook")
			? (normalizeUrlProtocol(value) ?? "")
			: value || "";
		if (field === "notifyDingtalkWebhook") setDingtalkWebhook(normalizedValue);
		if (field === "notifyFeishuWebhook") setFeishuWebhook(normalizedValue);
		updateUserPref.mutate({ [field]: normalizedValue });
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
									onClick={() =>
										playBuiltinSound(userPrefs?.notifySoundBuiltin ?? "gentle", previewOptions)
									}
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
											playCustomSound(
												`/api/notification-sounds/${userPrefs.notifySoundFileId}`,
												previewOptions,
											)
										}
									>
										{t("notifySoundPreview")}
									</Button>
								)}
							</Group>
						)}
						<Stack gap={4} mt="xs">
							<Text size="xs" fw={500}>
								{t("notifySoundVolume")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("notifySoundVolumeDesc")}
							</Text>
							<Slider
								min={0}
								max={100}
								step={5}
								value={soundVolume}
								label={(v) => `${v}%`}
								marks={[
									{ value: 0, label: "0%" },
									{ value: 50, label: "50%" },
									{ value: 100, label: "100%" },
								]}
								onChange={setVolumeDraft}
								onChangeEnd={(v) => {
									// Keep the draft: the effect above releases it once the saved
									// value matches, so the thumb never snaps back mid-request.
									setVolumeDraft(v);
									updateUserPref.mutate(
										{ notifySoundVolume: v },
										// A rejected save must not leave the thumb parked on a value
										// the server never accepted.
										{ onError: () => setVolumeDraft(null) },
									);
								}}
								mb="md"
							/>
						</Stack>
						<NumberInput
							label={t("notifySoundMaxConcurrent")}
							description={t("notifySoundMaxConcurrentDesc")}
							min={MIN_SOUND_MAX_CONCURRENT}
							max={MAX_SOUND_MAX_CONCURRENT}
							step={1}
							clampBehavior="strict"
							allowDecimal={false}
							value={soundMaxConcurrent}
							onChange={(v) => {
								const next = typeof v === "number" ? v : Number.parseInt(String(v), 10);
								if (!Number.isFinite(next)) return;
								if (next < MIN_SOUND_MAX_CONCURRENT || next > MAX_SOUND_MAX_CONCURRENT) return;
								if (next === soundMaxConcurrent) return;
								updateUserPref.mutate({ notifySoundMaxConcurrent: next });
							}}
							size="xs"
							w={200}
						/>
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
