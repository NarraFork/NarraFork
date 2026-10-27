import type { OutlineSpaceSummary } from "@shared/outline-api";
import { useTranslation } from "react-i18next";
import { spaceLabelKey } from "../../lib/outline-view";

/** The display name of a space: whose it is, by name where it has one. */
export function useOutlineSpaceName(): (
	space: Pick<OutlineSpaceSummary, "kind" | "label" | "mine" | "orphaned">,
) => string {
	const { t } = useTranslation("outline");
	return (space) => {
		const { key, values } = spaceLabelKey(space);
		return t(key, values);
	};
}
