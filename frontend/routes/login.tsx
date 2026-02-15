import {
	Alert,
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
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStatus, useLogin, useRegister } from "../hooks/useAuth";
import { getToken } from "../lib/api";

export const Route = createFileRoute("/login")({
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const { data: authStatus, isLoading: statusLoading } = useAuthStatus();
	const login = useLogin();
	const register = useRegister();
	const { t } = useTranslation("common");

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
		} catch (e: any) {
			setError(e.message || t("unknownError"));
		}
	};

	const handleRegister = async () => {
		setError("");
		try {
			await register.mutateAsync({ username, password });
			navigate({ to: "/" });
		} catch (e: any) {
			setError(e.message || t("unknownError"));
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === "Enter") action();
	};

	return (
		<Center h="100vh">
			<Paper withBorder shadow="md" p="xl" w={400}>
				<form onSubmit={e => e.preventDefault()}>
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
			</Paper>
		</Center>
	);
}
