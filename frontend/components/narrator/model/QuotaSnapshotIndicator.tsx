import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { useTranslation } from "react-i18next";
import {
	QuotaPanelIndicator,
	type QuotaPanelIndicatorProps,
	useQuotaNow,
} from "./QuotaPanelIndicator";
import { quotaSnapshotView } from "./quota-snapshot-view";

export interface QuotaSnapshotIndicatorProps extends Omit<QuotaPanelIndicatorProps, "view"> {
	snapshot: PublicQuotaSnapshot | null | undefined;
	title: string;
}

export function QuotaSnapshotIndicator({ snapshot, title, ...props }: QuotaSnapshotIndicatorProps) {
	const { t } = useTranslation("narrator");
	const ownNow = useQuotaNow(props.now === undefined);
	const now = props.now ?? ownNow;
	return (
		<QuotaPanelIndicator view={quotaSnapshotView(snapshot, title, t, now)} {...props} now={now} />
	);
}
