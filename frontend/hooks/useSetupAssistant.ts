import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useCurrentUser } from "./useAuth";

/** How much authority the user grants the Setup Assistant. */
export type SetupAuthorization = "full" | "default";

/**
 * Delegate missing system-dependency installation to a Setup Assistant narrator.
 *
 * An agent with Bash adapts to whatever distro / package manager / permission
 * model this machine has, which a hard-coded install-command matrix cannot. On
 * success it navigates to the new narrator so the user watches it work; when
 * nothing installable is missing it just says so instead of opening an empty
 * session.
 *
 * `delegate` requires an explicit authorization argument. There is deliberately
 * no default at this layer: granting a narrator unattended shell access is the
 * user's decision, so the caller must have asked first.
 *
 * Installing system software is instance-wide, so the endpoint is admin-only —
 * `canDelegate` lets callers hide the entry point for non-admins rather than
 * letting them click into a 403.
 */
export function useSetupAssistant(options?: { onCreated?: () => void }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();
	const onCreated = options?.onCreated;

	const mutation = useMutation({
		mutationFn: (authorization: SetupAuthorization) =>
			api.createSetupAssistantNarrator({ authorization }),
		onSuccess: (result) => {
			qc.invalidateQueries({ queryKey: ["dependencies"] });
			qc.invalidateQueries({ queryKey: ["health"] });
			if (!result.created || !result.narrator) {
				notifications.show({ color: "green", message: t("depsDelegateNothingToDo") });
				return;
			}
			qc.invalidateQueries({ queryKey: ["narrators"] });
			onCreated?.();
			navigate({ to: "/narrators/$narratorId", params: { narratorId: result.narrator.id } });
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				message: t("depsDelegateFailed", {
					error: (err as Error)?.message ?? String(err),
				}),
			});
		},
	});

	return {
		delegate: (authorization: SetupAuthorization) => mutation.mutate(authorization),
		isDelegating: mutation.isPending,
		canDelegate: user?.role === "admin",
	};
}
