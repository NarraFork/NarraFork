import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import type { GitTarget } from "../../lib/api/git";
import { GitCommitPreview } from "./GitCommitPreview";

interface Props {
	target: GitTarget;
	/** Full SHA of the commit to preview; null closes the modal. */
	sha: string | null;
	onClose: () => void;
}

export function GitCommitDetailModal({ target, sha, onClose }: Props) {
	const { t } = useTranslation("git");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;

	return (
		<Modal
			opened={!!sha}
			onClose={onClose}
			size="min(1240px, 95vw)"
			fullScreen={isMobile}
			closeButtonProps={{ "aria-label": t("commitPreview.close") }}
			title={t("commitPreview.title", { sha: sha?.slice(0, 7) })}
		>
			{/* Release query observers on close, not after the exit transition.
			    Mantine retains its default Escape, focus trap and focus restoration. */}
			{sha && <GitCommitPreview target={target} sha={sha} mode="modal" />}
		</Modal>
	);
}
