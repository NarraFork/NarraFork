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
import { useEffect, useRef, useState } from "react";
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
import { replaceCurrentHistoryState } from "../lib/history-state";

/** Map backend error codes to i18n keys in the "common" namespace. */
function mapAuthErrorCode(e: ApiError): string | null {
	const code = (e.data as Record<string, unknown> | undefined)?.code;
	if (typeof code !== "string") return null;
	const retryAfter = getRetryAfterSeconds(e);
	const mapping: Record<string, string> = {
		INVALID_CREDENTIALS: "invalidCredentials",
		UNAUTHORIZED: "authRequired",
		TOKEN_EXPIRED: "tokenExpired",
		NOT_FOUND: "userNotFound",
		MFA_CODE_INVALID: "mfaCodeInvalid",
		MFA_TOKEN_INVALID: "mfaSessionExpired",
		MFA_LOCKED: retryAfter ? "mfaLockedRetry" : "mfaLocked",
		MFA_THROTTLED: retryAfter ? "mfaLockedRetry" : "mfaLocked",
		LOGIN_THROTTLED: retryAfter ? "loginThrottledRetry" : "loginThrottled",
		AUTH_BUSY: "authBusy",
		PASSKEY_AUTH_FAILED: "passkeyAuthFailed",
		SSO_CODE_INVALID: "ssoCodeInvalid",
		SSO_DOMAIN_DENIED: "ssoDomainDenied",
		SSO_SIGNUP_DISABLED: "ssoSignupDisabled",
	};
	return mapping[code] ?? null;
}

function getRetryAfterSeconds(e: ApiError): number | null {
	const value = (e.data as Record<string, unknown> | undefined)?.retryAfterSeconds;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

function useRetryCountdown(): readonly [number, (seconds: number) => void] {
	const [until, setUntil] = useState(0);
	const [seconds, setSeconds] = useState(0);

	useEffect(() => {
		if (until <= 0) {
			setSeconds(0);
			return;
		}
		const tick = () => {
			const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1_000));
			setSeconds(remaining);
			if (remaining === 0) setUntil(0);
		};
		tick();
		const timer = window.setInterval(tick, 1_000);
		return () => window.clearInterval(timer);
	}, [until]);

	const start = (nextSeconds: number) => {
		const normalized = Math.max(1, Math.ceil(nextSeconds));
		setSeconds(normalized);
		setUntil(Date.now() + normalized * 1_000);
	};
	return [seconds, start] as const;
}

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
		redirect: typeof search.redirect === "string" ? search.redirect : undefined,
	}),
	component: LoginPage,
});

type MfaMode = "totp" | "backup" | "passkey";

/** Only allow same-origin relative redirects so a crafted link can't exfiltrate the session. */
function safePostLoginPath(redirect: string | undefined): string {
	if (!redirect) return "/";
	if (!redirect.startsWith("/") || redirect.startsWith("//")) return "/";
	return redirect;
}

function clearSsoCallbackParams(): void {
	const url = new URL(window.location.href);
	url.searchParams.delete("sso_code");
	url.searchParams.delete("sso_error");
	replaceCurrentHistoryState({}, `${url.pathname}${url.search}${url.hash}`);
}

function LoginPage() {
	const navigate = useNavigate();
	const { redirect: redirectParam } = Route.useSearch();
	const postLoginPath = safePostLoginPath(redirectParam);
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

	// Marks that THIS page established the session, so the "already logged in"
	// <Navigate> stays out of the way while a handler performs the redirect. A ref
	// (not state) because it must be visible to the very next render without
	// scheduling one of its own.
	const signedInHereRef = useRef(false);
	const signedInHere = signedInHereRef.current;

	/** Single redirect owner for every successful sign-in on this page. */
	const goToPostLogin = () => {
		signedInHereRef.current = true;
		navigate({ to: postLoginPath as "/", replace: true });
	};

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loginRetrySeconds, startLoginRetry] = useRetryCountdown();
	const [mfaRetrySeconds, startMfaRetry] = useRetryCountdown();

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
			clearSsoCallbackParams();
			return;
		}
		if (ssoCode) {
			clearSsoCallbackParams();
			setError("");
			ssoExchange
				.mutateAsync(ssoCode)
				.then(() => {
					goToPostLogin();
				})
				.catch((e) => {
					// Surface the backend's specific reason when available, else a
					// generic fallback (keeps parity with the ?sso_error path).
					const i18nKey = mapAuthErrorCode(e as ApiError);
					setError(i18nKey ? t(i18nKey) : t("ssoExchangeFailed"));
				});
		}
	}, []);

	// Redirect a session that already existed when this page was opened (e.g. a
	// stale /login tab). Sessions established BY this page are redirected by their
	// own handler, so `signedInHere` keeps that out of this branch.
	//
	// Both must not fire for one sign-in. `applySession` stores the token before
	// the handler's `navigate()` runs, so without this guard any re-render in that
	// window (a settling query, a WS event) would render <Navigate> too, and two
	// owners would drive the same transition. The router then tears down and
	// rebuilds the match tree concurrently, and `Match` can read a `matchId` whose
	// store has already been reconciled away — it throws "Invariant failed" from a
	// layout effect, above the root route's errorComponent, so TanStack's global
	// boundary shows its own bare "Something went wrong!" instead of our error UI.
	// A reload fixed it because the token is then present from the very first
	// render, leaving a single redirect owner.
	if (!signedInHere && getToken()) {
		return <Navigate to={postLoginPath as "/"} />;
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
		if (mfaRetrySeconds > 0) {
			setError(t("mfaLockedRetry", { seconds: mfaRetrySeconds }));
		}
	};

	const handleError = (e: unknown) => {
		const err = e as ApiError;
		const data = err?.data as Record<string, unknown> | undefined;
		const code = data?.code;
		const retryAfter = getRetryAfterSeconds(err);
		if (retryAfter) {
			if (
				code === "MFA_LOCKED" ||
				code === "MFA_THROTTLED" ||
				(code === "AUTH_BUSY" && !!mfaToken)
			) {
				startMfaRetry(retryAfter);
			} else if (code === "LOGIN_THROTTLED" || code === "AUTH_BUSY") {
				startLoginRetry(retryAfter);
			}
		}
		// When the challenge session is dead or the user-level MFA budget is
		// exhausted, return to the password step. A brief AUTH_BUSY response keeps
		// the challenge so the same attempt can be retried.
		if (code === "MFA_TOKEN_INVALID" || code === "MFA_LOCKED") {
			setMfaToken(null);
			setPassword("");
		}
		const i18nKey = mapAuthErrorCode(err);
		setError(
			i18nKey ? t(i18nKey, { seconds: retryAfter ?? 1 }) : err?.message || t("unknownError"),
		);
	};

	const handleLogin = async () => {
		if (loginRetrySeconds > 0) return;
		setError("");
		try {
			const result = await login.mutateAsync({ username, password });
			if (isMfaChallenge(result)) {
				enterMfa(result);
				return;
			}
			goToPostLogin();
		} catch (e) {
			handleError(e);
		}
	};

	const handlePasskeyLogin = async () => {
		setError("");
		try {
			await passkeyLogin.mutateAsync();
			goToPostLogin();
		} catch (e) {
			// A user cancelling the browser prompt throws; show a soft hint only.
			if (isUserCancelledWebAuthn(e)) return;
			handleError(e);
		}
	};

	const handleMfaVerify = async (codeOverride?: string) => {
		if (mfaRetrySeconds > 0) return;
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
			goToPostLogin();
		} catch (e) {
			handleError(e);
			setMfaCode("");
		}
	};

	const handleMfaPasskey = async () => {
		if (mfaRetrySeconds > 0) return;
		setError("");
		if (!mfaToken) return;
		try {
			await passkeyMfaVerify.mutateAsync(mfaToken);
			goToPostLogin();
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
			goToPostLogin();
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
											disabled={mfaRetrySeconds > 0}
										>
											{mfaRetrySeconds > 0
												? t("retryInSeconds", { seconds: mfaRetrySeconds })
												: t("mfaUsePasskey")}
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
											disabled={!mfaCode.trim() || mfaRetrySeconds > 0}
										>
											{mfaRetrySeconds > 0
												? t("retryInSeconds", { seconds: mfaRetrySeconds })
												: t("mfaVerify")}
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
											disabled={!username.trim() || !password || loginRetrySeconds > 0}
										>
											{loginRetrySeconds > 0
												? t("retryInSeconds", { seconds: loginRetrySeconds })
												: t("login")}
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
