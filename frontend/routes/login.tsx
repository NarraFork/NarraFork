import {
	Alert,
	Anchor,
	Button,
	Center,
	Loader,
	Paper,
	PasswordInput,
	Stack,
	Tabs,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { createFileRoute, Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStatus, useLogin, useRegister } from "../hooks/useAuth";
import { type ApiError, getToken } from "../lib/api";

/** Map backend error codes to i18n keys in the "common" namespace. */
function mapAuthErrorCode(e: ApiError): string | null {
	const code = (e.data as Record<string, unknown> | undefined)?.code;
	if (typeof code !== "string") return null;
	const mapping: Record<string, string> = {
		INVALID_CREDENTIALS: "invalidCredentials",
		UNAUTHORIZED: "authRequired",
		TOKEN_EXPIRED: "tokenExpired",
		NOT_FOUND: "userNotFound",
	};
	return mapping[code] ?? null;
}

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
	const login = useLogin();
	const register = useRegister();
	const { t, i18n } = useTranslation("common");

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

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

	const handleLogin = async () => {
		setError("");
		try {
			await login.mutateAsync({ username, password });
			navigate({ to: "/" });
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			const i18nKey = mapAuthErrorCode(e);
			setError(i18nKey ? t(i18nKey) : e.message || t("unknownError"));
		}
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
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			const i18nKey = mapAuthErrorCode(e);
			setError(i18nKey ? t(i18nKey) : e.message || t("unknownError"));
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === "Enter") action();
	};

	return (
		<Center h="100vh">
			<Paper withBorder shadow="md" p="xl" w={400}>
				<form onSubmit={(e) => e.preventDefault()}>
					<Stack>
						<Title order={2} ta="center">
							NarraFork
						</Title>

						{needsSetup ? (
							<>
								<Text size="sm" c="dimmed" ta="center">
									{t("firstUserSetup")}
								</Text>
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
