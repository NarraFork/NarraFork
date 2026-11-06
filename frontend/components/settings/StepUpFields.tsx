/**
 * Passphrase + identity check shared by the two exports that carry secrets: credential
 * transfer and a data export with providers. The passphrase seals the file; the password
 * and second factor are the step-up check the server requires before it exports.
 */
import {
	Alert,
	PasswordInput,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { authApi, type StepUpMethod, type StepUpPurpose } from "../../lib/api/auth";

export const MIN_PASSPHRASE = 10;

export interface StepUpFieldsState {
	passphrase: string;
	confirmation: string;
	password: string;
	method: StepUpMethod;
	code: string;
}

const EMPTY: StepUpFieldsState = {
	passphrase: "",
	confirmation: "",
	password: "",
	method: "totp",
	code: "",
};

/**
 * Field state and the second factors this account has. `ready` says whether the fields are
 * complete; `verify` runs the step-up and returns the grant. Reset when `opened` turns on.
 */
export function useStepUpFields(opened: boolean) {
	const methods = useQuery({
		queryKey: ["auth", "step-up-methods"],
		queryFn: () => authApi.stepUpMethods(),
		enabled: opened,
	});
	const available = useMemo(() => methods.data?.methods ?? [], [methods.data]);
	const [state, setState] = useState<StepUpFieldsState>(EMPTY);

	useEffect(() => {
		if (opened) setState(EMPTY);
	}, [opened]);
	useEffect(() => {
		if (available.length && !available.includes(state.method)) {
			setState((prev) => ({ ...prev, method: available[0] as StepUpMethod }));
		}
	}, [available, state.method]);

	const ready =
		state.passphrase.length >= MIN_PASSPHRASE &&
		state.confirmation === state.passphrase &&
		state.password.length > 0 &&
		available.length > 0 &&
		(state.method === "passkey" || state.code.trim().length > 0);

	const verify = useCallback(
		(purpose: StepUpPurpose) =>
			authApi.stepUp({
				purpose,
				password: state.password,
				method: state.method,
				...(state.method === "passkey" ? {} : { code: state.code.trim() }),
			}),
		[state.password, state.method, state.code],
	);

	/** After a failed attempt the code is spent; clear it so the user enters a new one. */
	const clearCode = useCallback(() => setState((prev) => ({ ...prev, code: "" })), []);

	return {
		state,
		setState,
		available,
		/** Methods loaded and none is enrolled: this account cannot step up. */
		noSecondFactor: methods.isSuccess && available.length === 0,
		ready,
		verify,
		clearCode,
	};
}

export function StepUpFields({ fields }: { fields: ReturnType<typeof useStepUpFields> }) {
	const { t } = useTranslation("settings");
	const { state, setState, available, noSecondFactor } = fields;
	const set = (patch: Partial<StepUpFieldsState>) => setState((prev) => ({ ...prev, ...patch }));
	const mismatch = state.confirmation.length > 0 && state.confirmation !== state.passphrase;

	return (
		<Stack gap="sm">
			<PasswordInput
				label={t("credentialTransfer.passphrase")}
				description={t("credentialTransfer.passphraseHint", { min: MIN_PASSPHRASE })}
				value={state.passphrase}
				onChange={(e) => set({ passphrase: e.currentTarget.value })}
				autoComplete="new-password"
			/>
			<PasswordInput
				label={t("credentialTransfer.passphraseConfirm")}
				value={state.confirmation}
				error={mismatch ? t("credentialTransfer.passphraseMismatch") : undefined}
				onChange={(e) => set({ confirmation: e.currentTarget.value })}
				autoComplete="new-password"
			/>
			<Title order={6}>{t("credentialTransfer.verify")}</Title>
			{noSecondFactor ? (
				<Alert color="orange">{t("errors:STEP_UP_MFA_REQUIRED")}</Alert>
			) : (
				<>
					<PasswordInput
						label={t("credentialTransfer.password")}
						value={state.password}
						onChange={(e) => set({ password: e.currentTarget.value })}
						autoComplete="current-password"
					/>
					{available.length > 1 && (
						<SegmentedControl
							size="xs"
							value={state.method}
							onChange={(value) => set({ method: value as StepUpMethod })}
							data={available.map((m) => ({
								value: m,
								label: t(`credentialTransfer.methods.${m}`),
							}))}
						/>
					)}
					{state.method === "passkey" ? (
						<Text size="xs" c="dimmed">
							{t("credentialTransfer.passkeyHint")}
						</Text>
					) : (
						<TextInput
							label={t("credentialTransfer.code")}
							value={state.code}
							onChange={(e) => set({ code: e.currentTarget.value })}
							autoComplete="one-time-code"
							inputMode={state.method === "totp" ? "numeric" : "text"}
						/>
					)}
				</>
			)}
		</Stack>
	);
}
