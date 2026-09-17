import { narratorsApi } from "@frontend/lib/api/narrators";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconSparkles } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface PromptOptimizeButtonProps {
	/** Function to get current text */
	getText: () => string;
	/** Function to apply optimized text */
	applyOptimized: (text: string) => void;
	/** Narrator ID for API call */
	narratorId: string;
	/** Whether button is disabled */
	disabled?: boolean;
	/** Button size */
	size?: string;
}

type OptimizeStyle = "clarify" | "concise" | "structured" | "translate_en";

const STORAGE_KEY = "narrafork_last_optimize_style";

export function PromptOptimizeButton({
	getText,
	applyOptimized,
	narratorId,
	disabled,
	size = "sm",
}: PromptOptimizeButtonProps) {
	const { t } = useTranslation("narrator");
	const [loading, setLoading] = useState(false);
	const abortControllerRef = useRef<AbortController | null>(null);
	const originalTextRef = useRef<string>("");

	const handleOptimize = async (style: OptimizeStyle) => {
		const text = getText();
		if (!text.trim()) {
			return; // Silently ignore empty input
		}

		// Save original for undo
		originalTextRef.current = text;

		// Remember style choice
		try {
			localStorage.setItem(STORAGE_KEY, style);
		} catch {
			// Ignore localStorage errors
		}

		// Abort any in-flight request
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
		}

		const controller = new AbortController();
		abortControllerRef.current = controller;
		setLoading(true);

		try {
			const result = await narratorsApi.optimizePrompt(narratorId, text, style, {
				signal: controller.signal,
			});
			applyOptimized(result.text);

			// Show success notification with undo
			notifications.show({
				message: t("optimizeSuccess"),
				color: "green",
				autoClose: 8000,
				withCloseButton: true,
			});
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				return; // User cancelled, don't show error
			}
			notifications.show({
				title: t("optimizeFailed"),
				message: (err as Error).message || t("optimizeFailedGeneric"),
				color: "red",
			});
		} finally {
			setLoading(false);
			abortControllerRef.current = null;
		}
	};

	return (
		<Menu position="top" withArrow withinPortal>
			<Menu.Target>
				<Tooltip label={t("optimizePrompt")} position="top" withArrow>
					<ActionIcon
						size={size}
						variant="subtle"
						disabled={disabled || loading}
						loading={loading}
						aria-label={t("optimizePrompt")}
						mb={4}
					>
						<IconSparkles size={16} />
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>{t("optimizeStyleLabel")}</Menu.Label>
				<Menu.Item onClick={() => handleOptimize("clarify")}>{t("optimizeStyleClarify")}</Menu.Item>
				<Menu.Item onClick={() => handleOptimize("concise")}>{t("optimizeStyleConcise")}</Menu.Item>
				<Menu.Item onClick={() => handleOptimize("structured")}>
					{t("optimizeStyleStructured")}
				</Menu.Item>
				<Menu.Item onClick={() => handleOptimize("translate_en")}>
					{t("optimizeStyleTranslateEn")}
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);
}
