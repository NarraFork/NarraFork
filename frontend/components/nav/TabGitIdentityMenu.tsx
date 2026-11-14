import { useState } from "react";
import { useNarratorGitIdentity, useSetNarratorGitIdentity } from "../../hooks/useGitIdentities";
import { GitIdentityMenuList } from "./GitIdentityMenuList";

/**
 * The "Git commit identity" entry in a narrator tab's context menu.
 *
 * The pick is stored per (user × narrator) on the server, so two people driving the same
 * narrator each choose their own and neither sees the other's — this entry is only the
 * surface for that personal setting. Queried only once the submenu is opened: a right-click
 * that never reaches this entry should not cost a request.
 */
export function TabGitIdentityMenu({
	narratorId,
	onClose,
}: {
	narratorId: string;
	onClose: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { data, isLoading } = useNarratorGitIdentity(expanded ? narratorId : null);
	const setPick = useSetNarratorGitIdentity(narratorId);
	// 会话自己没有 pick 时跟随所在文件夹，菜单要说清跟的是哪一条。
	const folderIdentity = data?.folderSelectedId
		? data.identities.find((identity) => identity.id === data.folderSelectedId)
		: undefined;
	return (
		<GitIdentityMenuList
			identities={data?.identities ?? []}
			selectedId={data?.selectedId ?? null}
			followIdentity={folderIdentity}
			isLoading={isLoading}
			expanded={expanded}
			onToggle={() => setExpanded((open) => !open)}
			onChoose={(identityId) => {
				setPick.mutate(identityId);
				onClose();
			}}
		/>
	);
}
