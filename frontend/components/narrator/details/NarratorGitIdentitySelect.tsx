import { NativeSelect, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useNarratorGitIdentity, useSetNarratorGitIdentity } from "../../../hooks/useGitIdentities";
import { followIdentityKind } from "./git-identity-follow-label";

const FOLLOW_DEFAULT = "__follow_default__";

/** This selection belongs to the viewer, not to everyone sharing the session. */
export function NarratorGitIdentitySelect({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { data, isLoading, isError } = useNarratorGitIdentity(narratorId);
	const setPick = useSetNarratorGitIdentity(narratorId);
	const identities = data?.identities ?? [];
	const defaultIdentity = identities.find((identity) => identity.isDefault);
	// 会话自己没有 pick 时跟的是文件夹（若设过），不是全局默认。
	const folderIdentity = data?.folderSelectedId
		? identities.find((identity) => identity.id === data.folderSelectedId)
		: undefined;
	const followDefaultLabel =
		followIdentityKind(folderIdentity, defaultIdentity) === "folder"
			? t("details.gitIdentityFollowFolder", { name: folderIdentity?.name })
			: defaultIdentity
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
