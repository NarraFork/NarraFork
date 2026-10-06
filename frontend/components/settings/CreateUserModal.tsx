import {
	Alert,
	Button,
	Group,
	Modal,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconCheck, IconCopy, IconDice } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { generateRandomPassword } from "../../lib/random-password";
import { CopyButton } from "../common/CopyButton";

interface CreateUserModalProps {
	opened: boolean;
	onClose: () => void;
}

/**
 * Create an account on someone else's behalf.
 *
 * The administrator sets the initial password and passes it on out of band, so the
 * dialog offers a generator and a copy button — a hand-typed password here tends to
 * be weak and then never changed.
 */
export function CreateUserModal({ opened, onClose }: CreateUserModalProps) {
	const { t } = useTranslation("common");
	const qc = useQueryClient();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"admin" | "user">("user");

	useEffect(() => {
		if (!opened) return;
		setUsername("");
		setPassword("");
		setRole("user");
	}, [opened]);

	const createUser = useMutation({
		mutationFn: api.createUser,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "users"] });
			onClose();
		},
	});

	const canSubmit = username.trim().length >= 3 && password.length >= 8;

	return (
		<Modal opened={opened} onClose={onClose} title={t("createUser")}>
			<Stack>
				<Text size="sm" c="dimmed">
					{t("createUserDescription")}
				</Text>
				<TextInput
					label={t("username")}
					value={username}
					onChange={(e) => setUsername(e.currentTarget.value)}
					description={t("usernameRules")}
				/>
				<PasswordInput
					label={t("initialPassword")}
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					description={t("initialPasswordHint")}
				/>
				<Group gap="xs">
					<Button
						size="compact-sm"
						variant="light"
						leftSection={<IconDice size={14} />}
						onClick={() => setPassword(generateRandomPassword())}
					>
						{t("generatePassword")}
					</Button>
					{password && (
						<CopyButton value={password}>
							{({ copied, copy }) => (
								<Button
									size="compact-sm"
									variant="default"
									leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
									onClick={copy}
								>
									{copied ? t("copied") : t("copyPassword")}
								</Button>
							)}
						</CopyButton>
					)}
				</Group>
				<Select
					label={t("role")}
					value={role}
					data={[
						{ value: "user", label: t("roleUser") },
						{ value: "admin", label: t("roleAdmin") },
					]}
					onChange={(value) => setRole(value === "admin" ? "admin" : "user")}
					allowDeselect={false}
				/>
				{createUser.isError && <Alert color="red">{(createUser.error as Error).message}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						disabled={!canSubmit}
						loading={createUser.isPending}
						onClick={() => createUser.mutate({ username: username.trim(), password, role })}
					>
						{t("create")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
