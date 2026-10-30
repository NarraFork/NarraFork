import { afterEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { returnFromModelTrace } from "./interaction/model-trace-return";
import type { NarratorInteractionAreaProps } from "./NarratorInteractionArea";

const returnButton: { click: () => void } = {
	click: () => {
		throw new Error("Return button was not rendered");
	},
};

const MenuStub = Object.assign(({ children }: { children?: ReactNode }) => <div>{children}</div>, {
	Target: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Dropdown: () => null,
	Item: () => null,
});
mock.module("@mantine/core", () => ({
	Menu: MenuStub,
	ActionIcon: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
	Box: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
	Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	Stack: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
		<div data-region="queue" style={style}>
			{children}
		</div>
	),
	Group: ({ children, role }: { children?: ReactNode; role?: string }) => (
		<div role={role}>{children}</div>
	),
	Loader: ({ size }: { size: string }) => <span data-loader={size} />,
	Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	Button: ({
		children,
		onClick,
		disabled,
		loading,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		loading?: boolean;
	}) => {
		if (children === "modelTraceReturn" && onClick) returnButton.click = onClick;
		return (
			<button type="button" onClick={onClick} disabled={disabled} data-loading={loading}>
				{children}
			</button>
		);
	},
}));
const retryModelTrace = mock(
	(_id: string): Promise<{ id: string }> => Promise.resolve({ id: "trace" }),
);
const invalidateQueries = mock((_options: unknown) => Promise.resolve());
const showNotification = mock((_notification: unknown) => {});
mock.module("../../lib/api", () => ({ api: { retryModelTrace } }));
mock.module("@mantine/notifications", () => ({ notifications: { show: showNotification } }));
mock.module("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let resizeEnabled = false;
mock.module("../../hooks/useLocalPref", () => ({
	useLocalPref: () => [resizeEnabled, () => {}],
}));
mock.module("../../hooks/useResizableBottomSpacing", () => ({
	useBottomSpacing: () => 0,
	startBottomSpacingResize: () => {},
}));
mock.module("./panels/compact-context", () => ({ useNarratorPanelCompact: () => false }));
mock.module("./interaction/use-status-bar-props", () => ({ useStatusBarProps: () => ({}) }));
mock.module("./interaction/use-queued-message-actions", () => ({
	useQueuedMessageActions: () => ({}),
}));
mock.module("./header/NarratorGitBar", () => ({
	NarratorGitBar: () => <div data-region="git" />,
}));
mock.module("./interaction/QueuedMessageRow", () => ({
	QueuedMessageRow: () => null,
	QueuedAttachmentPreview: () => null,
}));
mock.module("./interaction/NarratorInteractionStatusBar", () => ({
	NarratorInteractionStatusBar: () => <div data-region="status" />,
}));
mock.module("./interaction/PendingAgentMessagesPanel", () => ({
	PendingAgentMessagesPanel: () => null,
}));
mock.module("./interaction/UploadProgressBar", () => ({
	UploadProgressBar: () => <div data-region="upload" />,
}));
mock.module("./composer/NarratorComposerRow", () => ({
	NarratorComposerRow: (props: { attachedImages: File[]; attachedTextFiles: File[] }) => (
		<div
			data-region="composer"
			data-images={props.attachedImages.length}
			data-files={props.attachedTextFiles.length}
		/>
	),
}));
mock.module("./permission/PermissionRuleResultNotice", () => ({
	PermissionRulePolicySync: () => null,
}));
const { NarratorInteractionArea } = await import("./NarratorInteractionArea");

function renderModelTraceReturn(options: Parameters<typeof returnFromModelTrace>[0]) {
	returnButton.click = () => {
		throw new Error("Return button was not rendered");
	};
	// No editable props are supplied: the modeltrace branch must not mount them or their hooks.
	const props = {
		common: { narratorId: "trace", narrator: { status: "idle", substatus: [] } },
		onModelTraceReturn: () => returnFromModelTrace(options),
	} as unknown as NarratorInteractionAreaProps;
	const html = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
	expect(html).toContain("modelTraceReturn");
	expect(html.match(/<button/g)).toHaveLength(1);
	expect(html).not.toContain("data-region");
	returnButton.click();
}

test("modeltrace return closes exactly its desktop dock panel without navigating to its parent", () => {
	const closeTrace = mock(() => {});
	const navigateToNarrator = mock(() => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: { parentNarratorId: "source" },
		onClose: closeTrace,
		navigateToNarrator,
		navigateToDefault,
	});
	expect(closeTrace).toHaveBeenCalledTimes(1);
	expect(navigateToNarrator).not.toHaveBeenCalled();
	expect(navigateToDefault).not.toHaveBeenCalled();
});

test("modeltrace return on mobile without a dock navigates to the source narrator", () => {
	const navigateToNarrator = mock((_id: string) => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: { parentNarratorId: "source" },
		navigateToNarrator,
		navigateToDefault,
	});
	expect(navigateToNarrator).toHaveBeenCalledWith("source");
	expect(navigateToDefault).not.toHaveBeenCalled();
});

test("modeltrace return respects authorized navigation metadata and deleted-parent fallback", () => {
	const navigateToNarrator = mock((_id: string) => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: {
			parentNarratorId: "deleted-source",
			navigationSummary: { parentNarratorId: null },
		},
		navigateToNarrator,
		navigateToDefault,
	});
	expect(navigateToNarrator).not.toHaveBeenCalled();
	expect(navigateToDefault).toHaveBeenCalledTimes(1);
});

test("passes image/file resources into the composer without an external attachment strip", () => {
	// Control hooks and leaf panels are mocked: only the real area's composition is under test.
	const props = {
		common: { narratorId: "n", isWorkspacePreview: false },
		onOpenGitPanel: () => {},
		attachedImages: [new File(["image"], "image.png")],
		attachedTextFiles: [new File(["text"], "notes.txt")],
		queueDeps: { queuedMessages: [{}, {}, {}] },
		statusBarInputs: {},
		composerRowProps: {},
		sendingState: { attachmentCount: 2, progress: 50, canCancel: true },
	} as unknown as NarratorInteractionAreaProps;
	const html = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
	const regions = [...html.matchAll(/data-region="([^"]+)"/g)].map((match) => match[1]);
	expect(regions).toEqual(["queue", "git", "status", "upload", "composer"]);
	expect(html).not.toContain('data-region="attachments"');
	expect(html).not.toContain('role="separator"');
	expect(html).not.toContain("ns-resize");
	expect(html).toContain("pointer-events:none");
	resizeEnabled = true;
	try {
		const enabledHtml = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
		expect(enabledHtml).toContain('role="separator"');
		expect(enabledHtml).toContain("cursor:ns-resize");
	} finally {
		resizeEnabled = false;
	}
	expect(html).toContain('data-images="1"');
	expect(html).toContain('data-files="1"');
	expect(html).toContain(
		'data-region="queue" style="border-top:1px solid var(--mantine-color-default-border)',
	);
});

let root: Root | undefined;
const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
	retryModelTrace.mockReset();
	invalidateQueries.mockClear();
	showNotification.mockClear();
});

async function mountTrace(
	status: string,
	substatus: string[] = [],
	errorMessage: string | null = null,
) {
	const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
	for (const key of globals) {
		savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : window[key],
		});
	}
	const container = window.document.getElementById("root") as unknown as HTMLElement;
	root = createRoot(container);
	const render = async (
		nextStatus = status,
		nextSubstatus = substatus,
		nextError = errorMessage,
	) => {
		const props = {
			common: {
				narratorId: "trace",
				narrator: { status: nextStatus, substatus: nextSubstatus, errorMessage: nextError },
			},
			onModelTraceReturn: () => {},
		} as unknown as NarratorInteractionAreaProps;
		await act(async () => root?.render(<NarratorInteractionArea {...props} />));
	};
	await render();
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find((item) => item.textContent === label);
	return { container, render, button };
}

test.each([
	"working",
	"waiting",
])("modeltrace %s displays a small sampling loader and keeps return available", async (status) => {
	const { container, button } = await mountTrace(status, ["error"], "old error");
	expect(container.querySelector('[role="status"]')?.textContent).toBe("modelTraceSampling");
	expect(container.querySelector('[data-loader="xs"]')).not.toBeNull();
	expect(button("modelTraceReturn")?.disabled).toBe(false);
	expect(button("modelTraceRetry")).toBeUndefined();
	expect(container.querySelector('[data-region="composer"]')).toBeNull();
});

test("modeltrace retries the same child once, disables submission, and follows persisted success without old UI", async () => {
	let resolve!: (value: { id: string }) => void;
	retryModelTrace.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const { container, render, button } = await mountTrace("idle", ["error"], "invalid result");
	expect(container.textContent).not.toContain("invalid result");
	await act(async () => {
		button("modelTraceRetry")?.click();
		button("modelTraceRetry")?.click();
	});
	expect(retryModelTrace).toHaveBeenCalledTimes(1);
	expect(retryModelTrace).toHaveBeenCalledWith("trace");
	expect(button("modelTraceRetry")?.disabled).toBe(true);
	expect(button("modelTraceRetry")?.getAttribute("data-loading")).toBe("true");
	expect(button("modelTraceReturn")?.disabled).toBe(false);
	await act(async () => {
		resolve({ id: "trace" });
	});
	expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["narrators", "trace"] });
	await render("working", [], null);
	expect(button("modelTraceRetry")).toBeUndefined();
	await render("idle", [], null);
	expect(container.querySelector('[role="status"]')).toBeNull();
	expect(button("modelTraceRetry")).toBeUndefined();
	expect(container.querySelectorAll("button")).toHaveLength(1);
	expect(container.querySelector('[data-region="composer"]')).toBeNull();
});

test("HTTP retry failure toasts without clearing persisted failure or restoring the composer", async () => {
	retryModelTrace.mockImplementation(() => Promise.reject(new Error("Network unavailable")));
	const { container, button } = await mountTrace("idle", ["error"], "original result error");
	await act(async () => {
		button("modelTraceRetry")?.click();
	});
	expect(showNotification).toHaveBeenCalledWith({ color: "red", message: "Network unavailable" });
	expect(invalidateQueries).not.toHaveBeenCalled();
	expect(button("modelTraceRetry")?.disabled).toBe(false);
	expect(button("modelTraceReturn")).toBeDefined();
	expect(container.textContent).not.toContain("original result error");
	expect(container.querySelector('[data-region="composer"]')).toBeNull();
});
