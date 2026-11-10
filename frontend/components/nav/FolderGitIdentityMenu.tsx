import { useState } from "react";
import { useFolderGitIdentity, useSetFolderGitIdentity } from "../../hooks/useGitIdentities";
import { GitIdentityMenuList } from "./GitIdentityMenuList";

/**
 * The "Git commit identity" entry in a sidebar folder's context menu.
 *
 * A folder pick is what sessions inside that folder commit under when they have no pick of
 * their own; a session with its own pick still wins. Stored per (user × folder), so the
 * folder's membership is what carries the choice — moving a session out of it drops back to
 * the default. Queried only once the submenu is opened.
 */
export function FolderGitIdentityMenu({
	folderId,
	onClose,
}: {
	folderId: string;
	onClose: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { data, isLoading } = useFolderGitIdentity(expanded ? folderId : null);
	const setPick = useSetFolderGitIdentity(folderId);
	return (
		<GitIdentityMenuList
			identities={data?.identities ?? []}
			selectedId={data?.selectedId ?? null}
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
