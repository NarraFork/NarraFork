import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Code,
	CopyButton,
	Divider,
	Group,
	Image,
	Loader,
	Modal,
	PasswordInput,
	PinInput,
	SimpleGrid,
	Stack,
	Stepper,
	Text,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconDownload, IconShieldLock } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import {
	useSecurityStatus,
	useTotpActivate,
	useTotpDisable,
	useTotpSetup,
} from "../../hooks/useAuth";
import type { TotpSetupResult } from "../../lib/api/auth";

export const Route = createFileRoute("/settings/security")({
	component: SettingsSecurityPage,
});

function SettingsSecurityPage() {
	const { t } = useTranslation("settings");
	const { data: status, isLoading } = useSecurityStatus();
	const [enrolling, setEnrolling] = useState(false);

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Title order={3}>{t("securitySection")}</Title>

			<Card withBorder padding="lg">
				<Group justify="space-between" wrap="nowrap" align="flex-start">
					<Group wrap="nowrap" align="flex-start">
						<IconShieldLock size={28} />
						<Box>
							<Group gap="xs">
								<Text fw={600}>{t("totpTitle")}</Text>
								{status?.totpEnabled ? (
									<Badge color="green" variant="light">
										{t("totpEnabled")}
									</Badge>
								) : (
									<Badge color="gray" variant="light">
										{t("totpDisabled")}
									</Badge>
								)}
							</Group>
							<Text size="sm" c="dimmed" mt={4} maw={520}>
								{t("totpDescription")}
							</Text>
							{status?.totpEnabled && (
								<Text size="xs" c="dimmed" mt={6}>
									{t("backupCodesRemaining", { count: status.backupCodesRemaining })}
								</Text>
							)}
						</Box>
					</Group>
					{status?.totpEnabled ? (
						<DisableButton />
					) : (
						<Button onClick={() => setEnrolling(true)}>{t("totpEnable")}</Button>
					)}
				</Group>
			</Card>

			{enrolling && <EnrollModal onClose={() => setEnrolling(false)} />}
		</Stack>
	);
}

/** TOTP enrollment wizard: scan QR → verify code → save backup codes. */
function EnrollModal({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("settings");
	const setup = useTotpSetup();
	const activate = useTotpActivate();
	const [step, setStep] = useState(0);
	const [setupData, setSetupData] = useState<TotpSetupResult | null>(null);
	const [code, setCode] = useState("");
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [error, setError] = useState("");

	// Kick off setup when the modal first opens.
	const startSetup = async () => {
		setError("");
		try {
			const data = await setup.mutateAsync();
			setSetupData(data);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setError(e?.message || t("totpSetupFailed"));
		}
	};

	// Start enrollment once, on mount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run exactly once on mount
	useEffect(() => {
		void startSetup();
	}, []);

	const handleActivate = async (codeOverride?: string) => {
		setError("");
		const value = (codeOverride ?? code).trim();
		if (!value) return;
		try {
			const res = await activate.mutateAsync(value);
			setBackupCodes(res.backupCodes);
			setStep(2);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setError(e?.message || t("totpCodeInvalid"));
			setCode("");
		}
	};

	const finish = () => {
		notifications.show({ color: "green", message: t("totpEnabledSuccess") });
		onClose();
	};

	return (
		<Modal
			opened
			onClose={step === 2 ? () => {} : onClose}
			title={t("totpEnable")}
			size="lg"
			closeOnClickOutside={step !== 2}
			closeOnEscape={step !== 2}
			withCloseButton={step !== 2}
		>
			<Stepper active={step} size="sm" mb="md">
				<Stepper.Step label={t("totpStepScan")} />
				<Stepper.Step label={t("totpStepVerify")} />
				<Stepper.Step label={t("totpStepBackup")} />
			</Stepper>

			{error && (
				<Alert color="red" mb="md">
					{error}
				</Alert>
			)}

			{step === 0 && (
				<Stack align="center">
					{setup.isPending || !setupData ? (
						<Loader />
					) : (
						<>
							<Text size="sm" c="dimmed" ta="center">
								{t("totpScanInstruction")}
							</Text>
							<Image src={setupData.qrDataUrl} w={220} h={220} alt="TOTP QR code" />
							<Text size="xs" c="dimmed">
								{t("totpManualEntry")}
							</Text>
							<Group gap="xs">
								<Code>{setupData.secret}</Code>
								<CopyButton value={setupData.secret}>
									{({ copied, copy }) => (
										<Button
											size="compact-xs"
											variant="light"
											leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
											onClick={copy}
										>
											{copied ? t("copied") : t("copy")}
										</Button>
									)}
								</CopyButton>
							</Group>
							<Button fullWidth mt="sm" onClick={() => setStep(1)}>
								{t("next")}
							</Button>
						</>
					)}
				</Stack>
			)}

			{step === 1 && (
				<Stack align="center">
					<Text size="sm" c="dimmed" ta="center">
						{t("totpVerifyInstruction")}
					</Text>
					<PinInput
						length={6}
						type="number"
						inputMode="numeric"
						oneTimeCode
						value={code}
						onChange={setCode}
						onComplete={(v) => handleActivate(v)}
						autoFocus
					/>
					<Group justify="space-between" w="100%" mt="sm">
						<Button variant="default" onClick={() => setStep(0)}>
							{t("back")}
						</Button>
						<Button
							onClick={() => handleActivate()}
							loading={activate.isPending}
							disabled={code.trim().length !== 6}
						>
							{t("totpActivate")}
						</Button>
					</Group>
				</Stack>
			)}

			{step === 2 && (
				<Stack>
					<Alert color="yellow" variant="light" title={t("backupCodesTitle")}>
						{t("backupCodesWarning")}
					</Alert>
					<SimpleGrid cols={2} spacing="xs">
						{backupCodes.map((bc) => (
							<Code key={bc} block ta="center">
								{bc}
							</Code>
						))}
					</SimpleGrid>
					<Group>
						<CopyButton value={backupCodes.join("\n")}>
							{({ copied, copy }) => (
								<Button
									variant="light"
									leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
									onClick={copy}
								>
									{copied ? t("copied") : t("backupCodesCopy")}
								</Button>
							)}
						</CopyButton>
						<Button
							variant="light"
							leftSection={<IconDownload size={16} />}
							onClick={() => downloadBackupCodes(backupCodes)}
						>
							{t("backupCodesDownload")}
						</Button>
					</Group>
					<Divider />
					<Button onClick={finish}>{t("backupCodesDone")}</Button>
				</Stack>
			)}
		</Modal>
	);
}

function DisableButton() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const disable = useTotpDisable();
	const [opened, setOpened] = useState(false);
	const [code, setCode] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	const handleDisable = async () => {
		setError("");
		try {
			await disable.mutateAsync({
				code: code.trim() || undefined,
				password: password || undefined,
			});
			notifications.show({ color: "green", message: t("totpDisabledSuccess") });
			setOpened(false);
			setCode("");
			setPassword("");
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setError(e?.message || t("totpDisableFailed"));
		}
	};

	const openDialog = async () => {
		if (await confirm({ message: t("totpDisableConfirm"), confirmColor: "red" })) {
			setOpened(true);
		}
	};

	return (
		<>
			<Button color="red" variant="light" onClick={openDialog}>
				{t("totpDisable")}
			</Button>
			<Modal opened={opened} onClose={() => setOpened(false)} title={t("totpDisable")} size="md">
				<Stack>
					<Text size="sm" c="dimmed">
						{t("totpDisableInstruction")}
					</Text>
					{error && <Alert color="red">{error}</Alert>}
					<PasswordInput
						label={t("totpDisableCodeOrBackup")}
						placeholder="123456"
						value={code}
						onChange={(e) => setCode(e.currentTarget.value)}
						visibilityToggleButtonProps={{ tabIndex: -1 }}
					/>
					<Divider label={t("or")} labelPosition="center" />
					<PasswordInput
						label={t("totpDisablePassword")}
						value={password}
						onChange={(e) => setPassword(e.currentTarget.value)}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setOpened(false)}>
							{t("cancel")}
						</Button>
						<Button
							color="red"
							onClick={handleDisable}
							loading={disable.isPending}
							disabled={!code.trim() && !password}
						>
							{t("totpDisable")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}

function downloadBackupCodes(codes: string[]) {
	const blob = new Blob([`NarraFork backup codes\n\n${codes.join("\n")}\n`], {
		type: "text/plain",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "narrafork-backup-codes.txt";
	a.click();
	URL.revokeObjectURL(url);
}
