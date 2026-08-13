import { Button, Modal, Radio, Stack, Text } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SetupAuthorization } from "../../hooks/useSetupAssistant";

interface SetupAssistantAuthorizationModalProps {
	opened: boolean;
	onClose: () => void;
	onConfirm: (authorization: SetupAuthorization) => void;
	loading?: boolean;
}

/**
 * Asks how much authority the Setup Assistant gets before it is created.
 *
 * Handing a narrator unattended shell access is the user's call, so it is an
 * explicit choice rather than a default we pick. "Standard" is preselected
 * because it is the option the user can still stop: every state-changing command
 * waits for approval. Declining entirely is also offered here — the honest third
 * answer is "I'll install it myself", which simply creates no narrator.
 *
 * The full-authority copy must not oversell the reflection step behind it. That
 * step is the same model reviewing its own pending call, and only for calls the
 * risk classifier flags; it is not human review and not a sandbox.
 */
export function SetupAssistantAuthorizationModal({
	opened,
	onClose,
	onConfirm,
	loading,
}: SetupAssistantAuthorizationModalProps) {
	const { t } = useTranslation("settings");
	const [authorization, setAuthorization] = useState<SetupAuthorization>("default");

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("depsAuthorizeTitle")}
			size="lg"
			closeOnClickOutside={!loading}
			closeOnEscape={!loading}
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("depsAuthorizeDesc")}
				</Text>

				<Radio.Group
					value={authorization}
					onChange={(value) => setAuthorization(value as SetupAuthorization)}
				>
					<Stack gap="sm">
						<Radio
							value="default"
							label={t("depsAuthorizeStandardLabel")}
							description={t("depsAuthorizeStandardDesc")}
						/>
						<Radio
							value="full"
							label={t("depsAuthorizeFullLabel")}
							description={t("depsAuthorizeFullDesc")}
						/>
					</Stack>
				</Radio.Group>

				{/* Stated for both options: the agent can never supply a sudo password,
				    so the user must type it in the terminal panel either way. */}
				<Text size="xs" c="dimmed">
					{t("depsAuthorizeSudoNote")}
				</Text>

				<Stack gap="xs">
					<Button
						leftSection={<IconRobot size={16} />}
						onClick={() => onConfirm(authorization)}
						loading={loading}
					>
						{t("depsAuthorizeConfirm")}
					</Button>
					<Button variant="subtle" color="gray" onClick={onClose} disabled={loading}>
						{t("depsAuthorizeSelfInstall")}
					</Button>
				</Stack>
			</Stack>
		</Modal>
	);
}
