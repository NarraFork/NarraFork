import { useLogin, useMfaVerify } from "@frontend/hooks/useAuth";
import { isMfaChallenge, type MfaChallenge } from "@frontend/lib/api/auth";
import {
	Alert,
	Button,
	Paper,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** No auth/status, SSO discovery, registration or WebAuthn side effects. */
export function RemoteLoginPage() {
	const { t } = useTranslation("remote");
	const navigate = useNavigate();
	const login = useLogin();
	const verify = useMfaVerify();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
	const [method, setMethod] = useState<"totp" | "backup_code">("totp");
	const [code, setCode] = useState("");
	const [error, setError] = useState(false);
	const supported =
		challenge?.methods.filter((value) => value === "totp" || value === "backup_code") ?? [];
	const submit = async () => {
		setError(false);
		try {
			if (challenge) {
				await verify.mutateAsync({ mfaToken: challenge.mfaToken, method, code });
			} else {
				const result = await login.mutateAsync({ username, password });
				setPassword("");
				if (isMfaChallenge(result)) {
					setChallenge(result);
					setMethod(result.methods.includes("totp") ? "totp" : "backup_code");
					return;
				}
			}
			await navigate({ to: "/projects" });
		} catch {
			setError(true);
		}
	};
	return (
		<Paper withBorder p="lg" maw={480} mx="auto" mt="xl">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<Stack>
					<Title order={2}>{t("title")}</Title>
					<Text size="sm">{t("adminOnly")}</Text>
					{error && <Alert color="red">{t("loginFailed")}</Alert>}
					{challenge ? (
						<>
							{!supported.length ? (
								<Alert color="yellow">{t("unsupportedMfa")}</Alert>
							) : (
								<>
									<Select
										label={t("code")}
										value={method}
										onChange={(value) =>
											setMethod(value === "backup_code" ? "backup_code" : "totp")
										}
										data={supported.map((value) => ({
											value,
											label: t(value === "totp" ? "totp" : "backupCode"),
										}))}
									/>
									<TextInput
										label={t("code")}
										value={code}
										autoComplete="one-time-code"
										onChange={(event) => setCode(event.currentTarget.value)}
										required
									/>
									<Button type="submit" loading={verify.isPending}>
										{t("verify")}
									</Button>
								</>
							)}
							<Button
								variant="subtle"
								onClick={() => {
									setChallenge(null);
									setCode("");
									setError(false);
								}}
							>
								{t("back")}
							</Button>
						</>
					) : (
						<>
							<TextInput
								label={t("username")}
								autoComplete="username"
								value={username}
								onChange={(event) => setUsername(event.currentTarget.value)}
								required
							/>
							<PasswordInput
								label={t("password")}
								autoComplete="current-password"
								value={password}
								onChange={(event) => setPassword(event.currentTarget.value)}
								required
							/>
							<Button type="submit" loading={login.isPending}>
								{t("login")}
							</Button>
						</>
					)}
				</Stack>
			</form>
		</Paper>
	);
}
