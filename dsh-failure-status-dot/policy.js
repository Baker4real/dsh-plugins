export const initialState = () => false;

export function foldOutcome(state, event) {
  if (event.type === 'turn/start') return false;
  if (event.type === 'turn/end') return event.data.reason.kind === 'error';
  return state;
}

export function failedCompletion(list, statuses, sessionId) {
  const status = statuses.get(sessionId);
  return list.projectionsBySession[sessionId]?.values.failureStatusDot === true
    && list.byId[sessionId]?.running === false
    && status?.completionUnread === true
    && status.running !== true
    && status.pendingInteraction === undefined;
}

export function rowStyles(sessionId) {
  const id = sessionId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `[data-row-key="session:${id}"] > span:first-child {
    --dsw-alias-state-success-primary: var(--dsw-alias-state-error-primary);
  }`;
}
