import { useLocale, useMessages } from "gt-react";
import { useState } from "react";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";

function sameArray<T>(
  left: ReadonlyArray<T> | undefined,
  right: ReadonlyArray<T> | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((item, index) => item === right[index]))
  );
}

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    sameArray(left.optimisticMessages, right.optimisticMessages) &&
    sameArray(left.anchoredMessages, right.anchoredMessages) &&
    left.attachmentUrlById === right.attachmentUrlById &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  timelineInput: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  // Keyed on the locale: without a GTProvider, useMessages() returns a new function every render.
  const locale = useLocale();
  const resolve = useMessages();
  const input = { ...timelineInput, resolve: timelineInput.resolve ?? resolve };
  const [state, setState] = useState(() => ({
    threadKey,
    locale,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  const reusable = state.threadKey === threadKey && state.locale === locale;
  if (reusable && sameInput(state.projection.input, input)) {
    return state.projection.entries;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    reusable ? state.projection : null,
  );
  setState({ threadKey, locale, projection });
  return projection.entries;
}
