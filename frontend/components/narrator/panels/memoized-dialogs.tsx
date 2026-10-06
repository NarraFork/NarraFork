import { memo } from "react";
import { CompactSummaryModal as CompactSummaryModalBody } from "../compact/compact-summary-modal";
import { ContextThresholdSettingsModal as ContextThresholdSettingsModalBody } from "../context-management/ContextThresholdSettingsModal";
import { SetGlobalModelModal as SetGlobalModelModalBody } from "../interaction/SetGlobalModelModal";
import { LeakedToolCallModal as LeakedToolCallModalBody } from "../permission/LeakedToolCallModal";
import { RevertActionConfirmModal as RevertActionConfirmModalBody } from "../permission/RevertScopeConfirmModal";

// Keep these shells mounted, including during their existing exit transitions.
// Default shallow comparison checks every prop, including callbacks and payloads;
// their own query/WS/state/context updates remain independent of the parent.
export const CompactSummaryModal = memo(CompactSummaryModalBody);
export const ContextThresholdSettingsModal = memo(ContextThresholdSettingsModalBody);
export const SetGlobalModelModal = memo(SetGlobalModelModalBody);
export const LeakedToolCallModal = memo(LeakedToolCallModalBody);
export const RevertActionConfirmModal = memo(RevertActionConfirmModalBody);
