import { OFFICIAL_GITHUB_REPOSITORY } from "@shared/github-repository";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";
import {
	DEFAULT_GITHUB_REPOSITORY,
	type UpdateSourceSettings,
	updateSettingsKey,
} from "../lib/update-source";
import { useCurrentUser } from "./useAuth";
import { runtimeSettingsQueryOptions } from "./useRuntimeSettings";
import type { useUpdateCheck } from "./useUpdateCheck";

export const OFFICIAL_UPDATE_SERVER_URL = "https://narrafork-update.b.domexie.cn";
const CONNECTION_ERRORS = new Set([
	"NETWORK_ERROR",
	"TIMEOUT",
	"GITHUB_RATE_LIMIT",
	"RATE_LIMITED",
]);

function isOfficialGithub(update?: UpdateSourceSettings): boolean {
	return (
		(update?.source ?? "github") === "github" &&
		(update?.githubRepository ?? DEFAULT_GITHUB_REPOSITORY).trim().toLowerCase() ===
			OFFICIAL_GITHUB_REPOSITORY.toLowerCase()
	);
}

type Check = Pick<ReturnType<typeof useUpdateCheck>, "settingsKey" | "source" | "errorCode">;

/** One completed GitHub check per browser/user, not one prompt per polling interval. */
export function useUpdateSourcePrompt(check: Check, language: string) {
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser();
	const consumed = useRef(new Set<string>());
	const savingRef = useRef(false);
	const saveController = useRef<AbortController | null>(null);
	const [prompt, setPrompt] = useState<{ userId: string; settingsKey: string } | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chinese = language.toLowerCase().startsWith("zh");
	useEffect(() => {
		const off = onTokenChange(() => {
			saveController.current?.abort();
			saveController.current = null;
			savingRef.current = false;
			setSaving(false);
			setPrompt(null);
			setError(null);
		});
		return () => {
			off();
			saveController.current?.abort();
		};
	}, []);

	useEffect(() => {
		if (user?.role !== "admin" || !check.settingsKey || check.source !== "github") return;
		const settings = queryClient.getQueryData<Awaited<ReturnType<typeof api.getRuntimeSettings>>>(
			runtimeSettingsQueryOptions().queryKey,
		);
		if (
			!isOfficialGithub(settings?.update) ||
			updateSettingsKey(settings?.update) !== check.settingsKey
		)
			return;
		if (check.errorCode === "UPDATE_SOURCE_CHANGED") return;
		const key = `narrafork:first-github-update-check:${user.id}`;
		if (consumed.current.has(key)) return;
		consumed.current.add(key);
		try {
			if (localStorage.getItem(key)) return;
			localStorage.setItem(key, "1");
		} catch {
			// Restricted storage must not break update checks; deduplicate within this mount.
		}
		if (chinese && CONNECTION_ERRORS.has(check.errorCode ?? "")) {
			setPrompt({ userId: user.id, settingsKey: check.settingsKey });
		}
	}, [check.settingsKey, check.source, check.errorCode, chinese, user, queryClient]);

	const dismiss = () => {
		if (!savingRef.current) {
			setPrompt(null);
			setError(null);
		}
	};
	const confirm = async () => {
		if (
			!prompt ||
			savingRef.current ||
			user?.role !== "admin" ||
			user.id !== prompt.userId ||
			!chinese
		)
			return;
		const token = getToken();
		if (!token) return;
		const settingsOptions = runtimeSettingsQueryOptions();
		const controller = new AbortController();
		saveController.current = controller;
		const readOptions = {
			...settingsOptions,
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				settingsOptions.queryFn({ signal: AbortSignal.any([signal, controller.signal]) }),
			staleTime: 0,
		};
		savingRef.current = true;
		setSaving(true);
		setError(null);
		try {
			// Re-read before writing: do not use the settings captured by the initial check.
			const settings = await queryClient.fetchQuery(readOptions);
			if (controller.signal.aborted || getToken() !== token) return;
			if (
				!isOfficialGithub(settings.update) ||
				updateSettingsKey(settings.update) !== prompt.settingsKey
			) {
				setError("updateSourceChanged");
				return;
			}
			// PATCH only these fields; the server merges the other update preferences.
			const saved = await api.updateRuntimeSettings(
				{
					expectedUpdateSettingsKey: prompt.settingsKey,
					update: {
						source: "update-server",
						serverUrl: OFFICIAL_UPDATE_SERVER_URL,
						product: "narrafork",
					},
				},
				{ signal: controller.signal },
			);
			if (controller.signal.aborted || getToken() !== token) return;
			queryClient.setQueryData(settingsOptions.queryKey, saved);
			await queryClient.invalidateQueries({ queryKey: ["settings"] });
			if (controller.signal.aborted || getToken() !== token) return;
			setPrompt(null);
			await queryClient.resetQueries({ queryKey: ["update-check"] });
			await queryClient.invalidateQueries({ queryKey: ["update-check"], refetchType: "none" });
		} catch (cause) {
			if (controller.signal.aborted || getToken() !== token) return;
			if (
				cause instanceof ApiError &&
				cause.status === 409 &&
				cause.data?.code === "UPDATE_SOURCE_CHANGED"
			) {
				setError("updateSourceChanged");
				await queryClient.fetchQuery(readOptions).catch(() => undefined);
				if (controller.signal.aborted || getToken() !== token) return;
				await queryClient.resetQueries({ queryKey: ["update-check"] });
			} else {
				setError("updateMirrorSwitchFailed");
			}
		} finally {
			if (saveController.current === controller) {
				saveController.current = null;
				savingRef.current = false;
				setSaving(false);
			}
		}
	};

	return {
		opened: !!prompt && chinese && user?.role === "admin" && user.id === prompt.userId,
		saving,
		error,
		dismiss,
		confirm,
	};
}
