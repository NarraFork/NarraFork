import { useMediaQuery } from "@mantine/hooks";
import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { LazyOverlayShell } from "../common/LazyOverlayBoundary";
import type { CreateNarratorModalProps } from "./CreateNarratorModal";

const importCreateNarratorBody = () => import("./CreateNarratorModal");
const CreateNarratorBody = lazy(() =>
	importCreateNarratorBody().then((module) => ({ default: module.CreateNarratorModalBody })),
);

/** Warm the body on intent; failures are reported by the real open's error boundary. */
export function preloadCreateNarratorModal(): void {
	void importCreateNarratorBody().catch(() => {});
}

export function CreateNarratorLazyModal(props: CreateNarratorModalProps & { busy?: boolean }) {
	const { t } = useTranslation("narrators");
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	const { busy, ...bodyProps } = props;
	return (
		<LazyOverlayShell
			type="modal"
			opened={props.opened}
			onClose={props.onClose}
			busy={busy}
			label={t("newNarratorModal")}
			title={t("newNarratorModal")}
			size={isWide ? 880 : "md"}
			styles={{
				body: {
					maxHeight: "85vh",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				},
			}}
		>
			<CreateNarratorBody {...bodyProps} />
		</LazyOverlayShell>
	);
}
