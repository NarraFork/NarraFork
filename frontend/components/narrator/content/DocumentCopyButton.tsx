import { ActionIcon, Tooltip } from "@mantine/core";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { copyDocument } from "./document-clipboard";

export function DocumentCopyButton({
	document,
	size = "xs",
}: {
	document: TextDocumentRef;
	size?: "xs" | "lg";
}) {
	const { t } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
	const label =
		status === "error" ? tn("documentCopyFailed") : t(status === "copied" ? "copied" : "copy");
	return (
		<Tooltip label={label} withArrow position="top">
			<ActionIcon
				size={size}
				variant="filled"
				color={status === "error" ? "red" : status === "copied" ? "teal" : "gray"}
				aria-label={label}
				style={{ pointerEvents: "auto" }}
				onClick={() => {
					void copyDocument(document).then(
						() => setStatus("copied"),
						() => setStatus("error"),
					);
				}}
			>
				<IconCopy size={size === "lg" ? 18 : 12} />
			</ActionIcon>
		</Tooltip>
	);
}
