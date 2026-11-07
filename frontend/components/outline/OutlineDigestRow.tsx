/**
 * The inbox's digest row expanded (P2 PR 11), loaded when it is first opened: the reports' modules
 * stay out of the outline surface, which shows the questions form from `OutlineQuestions.tsx`.
 *
 * A transient fetch failure of its chunk is retried once (`lazyWithRetry`). A lasting one is shown
 * in the row, not across the whole drawer, and "Try again" loads it afresh: `lazy` keeps a
 * rejection, so the boundary keeps the lazy component in its own state, makes a new one on retry,
 * and creates the element in its own render (an element made earlier by a parent would still
 * name the rejected one).
 */
import { Button, Group, Loader, Text } from "@mantine/core";
import {
	Component,
	type ComponentType,
	type LazyExoticComponent,
	type ReactNode,
	Suspense,
} from "react";
import { useTranslation } from "react-i18next";
import { lazyWithRetry } from "../../lib/lazy-with-retry";

interface InboxProps {
	reportIds: readonly string[];
	onOpen?: () => void;
}
type Importer = () => Promise<{ default: ComponentType<InboxProps> }>;

const importInbox: Importer = () =>
	import("./digest/OutlineDigestInbox").then((module) => ({
		default: module.OutlineDigestInbox,
	}));
let importer: Importer = importInbox;
let current: LazyExoticComponent<ComponentType<InboxProps>> = lazyWithRetry(importer);

/** A new lazy component, which imports again. */
function reload(): LazyExoticComponent<ComponentType<InboxProps>> {
	current = lazyWithRetry(importer);
	return current;
}

/** Wrap how the chunk is imported (tests: make it fail); null restores it. */
export function setOutlineDigestRowImporterForTests(wrap: ((load: Importer) => Importer) | null) {
	importer = wrap ? wrap(importInbox) : importInbox;
	reload();
}

function Failed({ onRetry }: { onRetry: () => void }) {
	const { t } = useTranslation("outline");
	return (
		<Group gap="xs" wrap="wrap" data-testid="outline-digest-failed">
			<Text size="xs" c="red">
				{t("report.inboxFailed")}
			</Text>
			<Button
				size="compact-xs"
				variant="light"
				onClick={onRetry}
				data-testid="outline-digest-retry"
			>
				{t("report.retry")}
			</Button>
		</Group>
	);
}

class DigestRowBoundary extends Component<
	InboxProps,
	{ failed: boolean; Inbox: LazyExoticComponent<ComponentType<InboxProps>> }
> {
	state = { failed: false, Inbox: current };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	retry = () => this.setState({ failed: false, Inbox: reload() });

	render(): ReactNode {
		const { failed, Inbox } = this.state;
		if (failed) return <Failed onRetry={this.retry} />;
		return (
			<Suspense fallback={<Loader size="xs" />}>
				<Inbox reportIds={this.props.reportIds} onOpen={this.props.onOpen} />
			</Suspense>
		);
	}
}

export function OutlineDigestRow(props: InboxProps) {
	return <DigestRowBoundary {...props} />;
}
