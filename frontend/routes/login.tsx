import {
	Alert,
	Anchor,
	Button,
	Center,
	Divider,
	Loader,
	Paper,
	PasswordInput,
	PinInput,
	Stack,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconFingerprint } from "@tabler/icons-react";
import { createFileRoute, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAuthStatus,
	useLogin,
	useMfaVerify,
	usePasskeyLogin,
	usePasskeyMfaVerify,
	useRegister,
	useSsoExchange,
	useSsoProviders,
} from "../hooks/useAuth";
import { type ApiError, api, getToken } from "../lib/api";
import {
	isMfaChallenge,
	isPasskeySupported,
	isUserCancelledWebAuthn,
	type MfaChallenge,
} from "../lib/api/auth";

/** Map backend error codes to i18n keys in the "common" namespace. */
function mapAuthErrorCode(e: ApiError): string | null {
	const code = (e.data as Record<string, unknown> | undefined)?.code;
	if (typeof code !== "string") return null;
	const mapping: Record<string, string> = {
		INVALID_CREDENTIALS: "invalidCredentials",
		UNAUTHORIZED: "authRequired",
		TOKEN_EXPIRED: "tokenExpired",
		NOT_FOUND: "userNotFound",
		MFA_CODE_INVALID: "mfaCodeInvalid",
		MFA_TOKEN_INVALID: "mfaSessionExpired",
		MFA_LOCKED: "mfaLocked",
		PASSKEY_AUTH_FAILED: "passkeyAuthFailed",
		SSO_CODE_INVALID: "ssoCodeInvalid",
		SSO_DOMAIN_DENIED: "ssoDomainDenied",
		SSO_SIGNUP_DISABLED: "ssoSignupDisabled",
	};
	return mapping[code] ?? null;
}

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

type MfaMode = "totp" | "backup" | "passkey";

function LoginPage() {
	const navigate = useNavigate();
	const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
	const login = useLogin();
	const register = useRegister();
	const mfaVerify = useMfaVerify();
	const passkeyLogin = usePasskeyLogin();
	const passkeyMfaVerify = usePasskeyMfaVerify();
	const ssoExchange = useSsoExchange();
	const { data: ssoData } = useSsoProviders();
	const { t, i18n } = useTranslation("common");

	const passkeySupported = isPasskeySupported();
	const ssoProviders = ssoData?.providers ?? [];

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	// MFA second-step state
	const [mfaToken, setMfaToken] = useState<string | null>(null);
	const [mfaMethods, setMfaMethods] = useState<MfaChallenge["methods"]>([]);
	const [mfaMode, setMfaMode] = useState<MfaMode>("totp");
	const [mfaCode, setMfaCode] = useState("");

	// Handle the SSO callback redirect: ?sso_code=… (exchange for a session) or
	// ?sso_error=… (show a message). Runs once on mount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only handler
	useEffect(() => {
		// Already authenticated (e.g. opened /login with a stale ?sso_code in a
		// tab that's still logged in): skip exchange. The <Navigate> below handles
		// the redirect. This also avoids consuming/erroring on a one-time code.
		if (getToken()) return;
		const params = new URLSearchParams(window.location.search);
		const ssoError = params.get("sso_error");
		const ssoCode = params.get("sso_code");
		if (ssoError) {
			setError(t("ssoError", { reason: ssoError.replace(/_/g, " ") }));
			window.history.replaceState({}, "", window.location.pathname);
			return;
		}
		if (ssoCode) {
			window.history.replaceState({}, "", window.location.pathname);
			ssoExchange
				.mutateAsync(ssoCode)
				.then(() => navigate({ to: "/" }))
				.catch((e) => {
					// Surface the backend's specific reason when available, else a
					// generic fallback (keeps parity with the ?sso_error path).
					const i18nKey = mapAuthErrorCode(e as ApiError);
					setError(i18nKey ? t(i18nKey) : t("ssoExchangeFailed"));
				});
		}
	}, []);

	// If already logged in, redirect
	if (getToken()) {
		return <Navigate to="/" />;
	}

	if (statusLoading) {
		return (
			<Center h="100vh">
				<Loader />
			</Center>
		);
	}

	const needsSetup = authStatus && !authStatus.hasUsers;
	const canRegister = authStatus?.registrationOpen || needsSetup;

	const enterMfa = (challenge: MfaChallenge) => {
		setMfaToken(challenge.mfaToken);
		setMfaMethods(challenge.methods);
		// Prefer TOTP entry when available, else fall back to passkey.
		setMfaMode(challenge.methods.includes("totp") ? "totp" : "passkey");
		setMfaCode("");
	};

	const handleError = (e: unknown) => {
		const err = e as ApiError;
		const code = (err?.data as Record<string, unknown> | undefined)?.code;
		// When the challenge session is dead, return to the password step.
		if (code === "MFA_TOKEN_INVALID" || code === "MFA_LOCKED") {
			setMfaToken(null);
			setPassword("");
		}
		const i18nKey = mapAuthErrorCode(err);
		setError(i18nKey ? t(i18nKey) : err?.message || t("unknownError"));
	};

	const handleLogin = async () => {
		setError("");
		try {
			const result = await login.mutateAsync({ username, password });
			if (isMfaChallenge(result)) {
				enterMfa(result);
				return;
			}
			navigate({ to: "/" });
		} catch (e) {
			handleError(e);
		}
	};

	const handlePasskeyLogin = async () => {
		setError("");
		try {
			await passkeyLogin.mutateAsync();
			navigate({ to: "/" });
		} catch (e) {
			// A user cancelling the browser prompt throws; show a soft hint only.
			if (isUserCancelledWebAuthn(e)) return;
			handleError(e);
		}
	};

	const handleMfaVerify = async (codeOverride?: string) => {
		setError("");
		if (!mfaToken) return;
		const code = (codeOverride ?? mfaCode).trim();
		if (!code) return;
		try {
			await mfaVerify.mutateAsync({
				mfaToken,
				method: mfaMode === "backup" ? "backup_code" : "totp",
				code,
			});
			navigate({ to: "/" });
		} catch (e) {
			handleError(e);
			setMfaCode("");
		}
	};

	const handleMfaPasskey = async () => {
		setError("");
		if (!mfaToken) return;
		try {
			await passkeyMfaVerify.mutateAsync(mfaToken);
			navigate({ to: "/" });
		} catch (e) {
			if (isUserCancelledWebAuthn(e)) return;
			handleError(e);
		}
	};

	const cancelMfa = () => {
		setMfaToken(null);
		setMfaCode("");
		setError("");
		setPassword("");
	};

	const validateRegisterFields = (): string | null => {
		const u = username.trim();
		if (u.length < 3) return t("usernameTooShort");
		if (u.length > 50) return t("usernameTooLong");
		if (!/^[a-zA-Z0-9_-]+$/.test(u)) return t("usernameInvalidChars");
		if (password.length < 8) return t("passwordTooShort");
		if (password.length > 128) return t("passwordTooLong");
		return null;
	};

	const handleRegister = async () => {
		setError("");
		const validationError = validateRegisterFields();
		if (validationError) {
			setError(validationError);
			return;
		}
		try {
			await register.mutateAsync({ username, password, language: i18n.language });
			navigate({ to: "/" });
		} catch (e) {
			handleError(e);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === "Enter") action();
	};

	const hasTotp = mfaMethods.includes("totp");
	const hasPasskeyMfa = mfaMethods.includes("passkey");

	return (
		<Center h="100vh">
			<Paper withBorder shadow="md" p="xl" w={400}>
				<form onSubmit={(e) => e.preventDefault()}>
					<Stack>
						<Title order={2} ta="center">
							NarraFork
						</Title>

						{mfaToken ? (
							<Stack>
								{mfaMode === "passkey" ? (
									<>
										<Text size="sm" c="dimmed" ta="center">
											{t("mfaPasskeyPrompt")}
										</Text>
										{error && <Alert color="red">{error}</Alert>}
										<Button
											leftSection={<IconFingerprint size={18} />}
											onClick={handleMfaPasskey}
											loading={passkeyMfaVerify.isPending}
										>
											{t("mfaUsePasskey")}
										</Button>
									</>
								) : (
									<>
										<Text size="sm" c="dimmed" ta="center">
											{mfaMode === "backup" ? t("mfaBackupPrompt") : t("mfaTotpPrompt")}
										</Text>
										{error && <Alert color="red">{error}</Alert>}
										{mfaMode === "backup" ? (
											<TextInput
												label={t("mfaBackupCode")}
												placeholder="xxxx-xxxx"
												value={mfaCode}
												onChange={(e) => setMfaCode(e.currentTarget.value)}
												onKeyDown={(e) => handleKeyDown(e, () => handleMfaVerify())}
												autoFocus
											/>
										) : (
											<Center>
												<PinInput
													length={6}
													type="number"
													inputMode="numeric"
													oneTimeCode
													value={mfaCode}
													onChange={setMfaCode}
													onComplete={(value) => handleMfaVerify(value)}
													autoFocus
												/>
											</Center>
										)}
										<Button
											onClick={() => handleMfaVerify()}
											loading={mfaVerify.isPending}
											disabled={!mfaCode.trim()}
										>
											{t("mfaVerify")}
										</Button>
									</>
								)}

								{/* Method switchers */}
								<Stack gap={4} mt={4}>
									{mfaMode !== "passkey" && (
										<Anchor
											component="button"
											type="button"
											size="xs"
											ta="center"
											onClick={() => {
												setMfaMode(mfaMode === "backup" ? "totp" : "backup");
												setMfaCode("");
												setError("");
											}}
										>
											{mfaMode === "backup" ? t("mfaUseAuthenticator") : t("mfaUseBackupCode")}
										</Anchor>
									)}
									{hasPasskeyMfa && mfaMode === "passkey" && hasTotp && (
										<Anchor
											component="button"
											type="button"
											size="xs"
											ta="center"
											onClick={() => {
												setMfaMode("totp");
												setError("");
											}}
										>
											{t("mfaUseAuthenticator")}
										</Anchor>
									)}
									{hasPasskeyMfa && mfaMode !== "passkey" && (
										<Anchor
											component="button"
											type="button"
											size="xs"
											ta="center"
											onClick={() => {
												setMfaMode("passkey");
												setError("");
											}}
										>
											{t("mfaUsePasskey")}
										</Anchor>
									)}
									<Anchor
										component="button"
										type="button"
										size="xs"
										c="dimmed"
										ta="center"
										onClick={cancelMfa}
									>
										{t("mfaBackToLogin")}
									</Anchor>
								</Stack>
							</Stack>
						) : needsSetup ? (
							<>
								<Alert color="blue" variant="light" title={t("firstUserSetupTitle")}>
									<Text size="sm">{t("firstUserSetupDescription")}</Text>
								</Alert>
								{error && <Alert color="red">{error}</Alert>}
								<TextInput
									label={t("username")}
									value={username}
									onChange={(e) => setUsername(e.currentTarget.value)}
									onKeyDown={(e) => handleKeyDown(e, handleRegister)}
								/>
								<PasswordInput
									label={t("password")}
									value={password}
									onChange={(e) => setPassword(e.currentTarget.value)}
									onKeyDown={(e) => handleKeyDown(e, handleRegister)}
								/>
								<Button
									onClick={handleRegister}
									loading={register.isPending}
									disabled={!username.trim() || !password}
								>
									{t("createAdmin")}
								</Button>
							</>
						) : (
							<Tabs defaultValue="login">
								<Tabs.List grow>
									<Tabs.Tab value="login">{t("login")}</Tabs.Tab>
									{canRegister && <Tabs.Tab value="register">{t("register")}</Tabs.Tab>}
								</Tabs.List>

								{error && (
									<Alert color="red" mt="sm">
										{error}
									</Alert>
								)}

								<Tabs.Panel value="login" pt="sm">
									<Stack>
										<TextInput
											label={t("username")}
											value={username}
											onChange={(e) => setUsername(e.currentTarget.value)}
											onKeyDown={(e) => handleKeyDown(e, handleLogin)}
										/>
										<PasswordInput
											label={t("password")}
											value={password}
											onChange={(e) => setPassword(e.currentTarget.value)}
											onKeyDown={(e) => handleKeyDown(e, handleLogin)}
										/>
										<Button
											onClick={handleLogin}
											loading={login.isPending}
											disabled={!username.trim() || !password}
										>
											{t("login")}
										</Button>
										{(passkeySupported || ssoProviders.length > 0) && (
											<Divider label={t("or")} labelPosition="center" my={4} />
										)}
										{passkeySupported && (
											<Button
												variant="default"
												leftSection={<IconFingerprint size={18} />}
												onClick={handlePasskeyLogin}
												loading={passkeyLogin.isPending}
											>
												{t("signInWithPasskey")}
											</Button>
										)}
										{ssoProviders.map((p) => (
											<Button
												key={p.id}
												variant="default"
												component="a"
												href={api.ssoStartUrl(p.id)}
											>
												{t("signInWithProvider", { provider: p.name })}
											</Button>
										))}
									</Stack>
								</Tabs.Panel>

								{canRegister && (
									<Tabs.Panel value="register" pt="sm">
										<Stack>
											<TextInput
												label={t("username")}
												value={username}
												onChange={(e) => setUsername(e.currentTarget.value)}
												onKeyDown={(e) => handleKeyDown(e, handleRegister)}
											/>
											<PasswordInput
												label={t("password")}
												value={password}
												onChange={(e) => setPassword(e.currentTarget.value)}
												onKeyDown={(e) => handleKeyDown(e, handleRegister)}
											/>
											<Button
												onClick={handleRegister}
												loading={register.isPending}
												disabled={!username.trim() || !password}
											>
												{t("register")}
											</Button>
										</Stack>
									</Tabs.Panel>
								)}
							</Tabs>
						)}
					</Stack>
				</form>
				<Anchor
					component={Link}
					to="/licenses"
					size="xs"
					c="dimmed"
					ta="center"
					mt="md"
					display="block"
				>
					{t("licensesTitle")}
				</Anchor>
			</Paper>
		</Center>
	);
}
