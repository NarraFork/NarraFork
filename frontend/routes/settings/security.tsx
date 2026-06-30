import {
	ActionIcon,
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
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconCheck,
	IconCopy,
	IconDownload,
	IconFingerprint,
	IconKey,
	IconPencil,
	IconShieldLock,
	IconTrash,
} from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import {
	useDeletePasskey,
	useIdentities,
	usePasskeys,
	useRegisterPasskey,
	useRenamePasskey,
	useSecurityStatus,
	useSsoProviders,
	useTotpActivate,
	useTotpDisable,
	useTotpSetup,
	useUnlinkIdentity,
} from "../../hooks/useAuth";
import { api } from "../../lib/api";
import {
	isPasskeySupported,
	isUserCancelledWebAuthn,
	type PasskeySummary,
	type SsoIdentity,
	type TotpSetupResult,
} from "../../lib/api/auth";

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

			<PasskeySection />

			<IdentitiesSection />

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

/** SSO identity management: link new providers, list and unlink existing ones. */
function IdentitiesSection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const { data: providersData } = useSsoProviders();
	const { data: identitiesData, isLoading } = useIdentities();
	const unlink = useUnlinkIdentity();
	const [linkingId, setLinkingId] = useState<string | null>(null);

	const providers = providersData?.providers ?? [];
	const identities = identitiesData?.identities ?? [];

	// SSO is only relevant when at least one provider is configured.
	if (providers.length === 0) return null;

	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

	const handleLink = async (providerId: string) => {
		setLinkingId(providerId);
		try {
			const { authorizeUrl } = await api.ssoLinkStart(providerId);
			// Navigate to the IdP; the callback returns to /settings/security.
			window.location.href = authorizeUrl;
		} catch (e) {
			setLinkingId(null);
			notifications.show({
				color: "red",
				message: (e as { message?: string })?.message || t("ssoLinkFailed"),
			});
		}
	};

	const handleUnlink = async (identity: SsoIdentity) => {
		if (await confirm({ message: t("ssoUnlinkConfirm"), confirmColor: "red" })) {
			unlink.mutate(identity.id);
		}
	};

	return (
		<Card withBorder padding="lg">
			<Group wrap="nowrap" align="flex-start">
				<IconKey size={28} />
				<Box style={{ flex: 1 }}>
					<Text fw={600}>{t("ssoTitle")}</Text>
					<Text size="sm" c="dimmed" mt={4} maw={520}>
						{t("ssoDescription")}
					</Text>

					{isLoading ? (
						<Loader size="sm" mt="md" />
					) : (
						<Stack gap="xs" mt="md">
							{providers.map((p) => {
								const linked = identities.filter((i) => i.provider === p.id);
								if (linked.length > 0) {
									return linked.map((identity) => (
										<Group key={identity.id} justify="space-between" wrap="nowrap">
											<Box>
												<Text size="sm">{p.name}</Text>
												<Text size="xs" c="dimmed">
													{identity.email || identity.displayName || t("ssoLinked")}
												</Text>
											</Box>
											<Button
												size="compact-sm"
												variant="subtle"
												color="red"
												onClick={() => handleUnlink(identity)}
											>
												{t("ssoUnlink")}
											</Button>
										</Group>
									));
								}
								return (
									<Group key={p.id} justify="space-between" wrap="nowrap">
										<Text size="sm">{p.name}</Text>
										<Button
											size="compact-sm"
											variant="light"
											loading={linkingId === p.id}
											onClick={() => handleLink(p.id)}
										>
											{t("ssoLink")}
										</Button>
									</Group>
								);
							})}
							{/* Identities whose provider is no longer configured. */}
							{identities
								.filter((i) => !providers.some((p) => p.id === i.provider))
								.map((identity) => (
									<Group key={identity.id} justify="space-between" wrap="nowrap">
										<Box>
											<Text size="sm">{providerName(identity.provider)}</Text>
											<Text size="xs" c="dimmed">
												{identity.email || t("ssoLinked")}
											</Text>
										</Box>
										<Button
											size="compact-sm"
											variant="subtle"
											color="red"
											onClick={() => handleUnlink(identity)}
										>
											{t("ssoUnlink")}
										</Button>
									</Group>
								))}
						</Stack>
					)}
				</Box>
			</Group>
		</Card>
	);
}

/** Passkey management: list, register, rename, delete. */
function PasskeySection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const supported = isPasskeySupported();
	const { data, isLoading } = usePasskeys();
	const register = useRegisterPasskey();
	const renameMut = useRenamePasskey();
	const removeMut = useDeletePasskey();
	const [error, setError] = useState("");
	// Rename dialog state (replaces window.prompt for design-system consistency).
	const [renaming, setRenaming] = useState<PasskeySummary | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const passkeys = data?.passkeys ?? [];

	const handleRegister = async () => {
		setError("");
		try {
			await register.mutateAsync(undefined);
			notifications.show({ color: "green", message: t("passkeyAddedSuccess") });
		} catch (e) {
			// User cancelled the browser prompt — not an error worth surfacing.
			if (isUserCancelledWebAuthn(e)) return;
			setError((e as { message?: string })?.message || t("passkeyAddFailed"));
		}
	};

	const openRename = (pk: PasskeySummary) => {
		setRenaming(pk);
		setRenameValue(pk.name ?? "");
	};

	const submitRename = () => {
		const name = renameValue.trim();
		if (renaming && name) {
			renameMut.mutate({ id: renaming.id, name });
		}
		setRenaming(null);
	};

	const handleDelete = async (pk: PasskeySummary) => {
		if (await confirm({ message: t("passkeyDeleteConfirm"), confirmColor: "red" })) {
			removeMut.mutate(pk.id);
		}
	};

	return (
		<Card withBorder padding="lg">
			<Group justify="space-between" wrap="nowrap" align="flex-start">
				<Group wrap="nowrap" align="flex-start">
					<IconFingerprint size={28} />
					<Box>
						<Text fw={600}>{t("passkeyTitle")}</Text>
						<Text size="sm" c="dimmed" mt={4} maw={520}>
							{t("passkeyDescription")}
						</Text>
					</Box>
				</Group>
				<Button
					onClick={handleRegister}
					loading={register.isPending}
					disabled={!supported}
					title={!supported ? t("passkeyUnsupported") : undefined}
				>
					{t("passkeyAdd")}
				</Button>
			</Group>

			{!supported && (
				<Alert color="yellow" variant="light" mt="md">
					{t("passkeyUnsupported")}
				</Alert>
			)}
			{error && (
				<Alert color="red" mt="md">
					{error}
				</Alert>
			)}

			{isLoading ? (
				<Loader size="sm" mt="md" />
			) : passkeys.length > 0 ? (
				<Stack gap="xs" mt="md">
					{passkeys.map((pk) => (
						<Group key={pk.id} justify="space-between" wrap="nowrap">
							<Box>
								<Text size="sm">{pk.name || t("passkeyUnnamed")}</Text>
								<Text size="xs" c="dimmed">
									{t("passkeyAddedOn", { date: pk.createdAt.slice(0, 10) })}
									{pk.lastUsedAt
										? ` · ${t("passkeyLastUsed", { date: pk.lastUsedAt.slice(0, 10) })}`
										: ""}
								</Text>
							</Box>
							<Group gap={4} wrap="nowrap">
								<ActionIcon
									variant="subtle"
									color="gray"
									onClick={() => openRename(pk)}
									aria-label={t("rename")}
								>
									<IconPencil size={16} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									color="red"
									onClick={() => handleDelete(pk)}
									aria-label={t("delete")}
								>
									<IconTrash size={16} />
								</ActionIcon>
							</Group>
						</Group>
					))}
				</Stack>
			) : (
				<Text size="sm" c="dimmed" mt="md">
					{t("passkeyNone")}
				</Text>
			)}

			<Modal
				opened={renaming !== null}
				onClose={() => setRenaming(null)}
				title={t("passkeyRenameTitle")}
				size="md"
			>
				<Stack>
					<TextInput
						label={t("passkeyName")}
						value={renameValue}
						onChange={(e) => setRenameValue(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submitRename();
						}}
						maxLength={60}
						data-autofocus
						autoFocus
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setRenaming(null)}>
							{t("cancel")}
						</Button>
						<Button onClick={submitRename} disabled={!renameValue.trim()}>
							{t("save")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Card>
	);
}
