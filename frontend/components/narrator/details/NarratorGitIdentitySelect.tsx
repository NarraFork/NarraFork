import { NativeSelect, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useNarratorGitIdentity, useSetNarratorGitIdentity } from "../../../hooks/useGitIdentities";

const FOLLOW_DEFAULT = "__follow_default__";

/** This selection belongs to the viewer, not to everyone sharing the session. */
export function NarratorGitIdentitySelect({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { data, isLoading, isError } = useNarratorGitIdentity(narratorId);
	const setPick = useSetNarratorGitIdentity(narratorId);
	const identities = data?.identities ?? [];
	const defaultIdentity = identities.find((identity) => identity.isDefault);
	const followDefaultLabel = defaultIdentity
		? t("details.gitIdentityFollowDefault", { name: defaultIdentity.name })
		: t("details.gitIdentityFollowDefaultPlain");

	return (
		<Stack gap={4}>
			<NativeSelect
				label={t("details.gitIdentity")}
				description={t("details.gitIdentityDescription")}
				value={data?.selectedId ?? FOLLOW_DEFAULT}
				disabled={isLoading || isError || identities.length === 0 || setPick.isPending}
				data={[
					{
						value: FOLLOW_DEFAULT,
						label: isLoading ? t("common:loading") : followDefaultLabel,
					},
					...identities.map((identity) => ({
						value: identity.id,
						label: `${identity.name} <${identity.email}>`,
					})),
				]}
				onChange={(event) => {
					const value = event.currentTarget.value;
					setPick.mutate(value === FOLLOW_DEFAULT ? null : value);
				}}
				error={isError ? t("details.gitIdentityLoadFailed") : undefined}
			/>
			{!isLoading && !isError && identities.length === 0 && (
				<Text size="xs" c="dimmed">
					{t("details.gitIdentityUnconfigured")}
				</Text>
			)}
		</Stack>
	);
}
