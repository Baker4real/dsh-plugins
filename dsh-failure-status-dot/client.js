window.__ModuleLoader__.load({
  id: '@local/dsh-failure-status-dot',
  factory(require) {
    const React = require('react');
    // POLICY: generated from the same pure functions used by the Host and tests.
    const initialState = () => false;

function foldOutcome(state, event) {
  if (event.type === 'turn/start') return false;
  if (event.type === 'turn/end') return event.data.reason.kind === 'error';
  return state;
}

function failedCompletion(list, statuses, sessionId) {
  const status = statuses.get(sessionId);
  return list.projectionsBySession[sessionId]?.values.failureStatusDot === true
    && list.byId[sessionId]?.running === false
    && status?.completionUnread === true
    && status.running !== true
    && status.pendingInteraction === undefined;
}

function rowStyles(sessionId) {
  const id = sessionId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `[data-row-key="session:${id}"] > span:first-child {
    --dsw-alias-state-success-primary: var(--dsw-alias-state-error-primary);
  }`;
}


    function FailureDotStyle({ sessionId, useSessions, useSessionStatus }) {
      const list = useSessions(value => value);
      const statuses = useSessionStatus(value => value);
      if (!failedCompletion(list, statuses, sessionId)) return null;
      return React.createElement('style', {
        'data-dsh-failure-dot': sessionId,
      }, rowStyles(sessionId));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'failure-status-dot',
          order: 100,
        }, FailureDotStyle));
      },
    };
  },
});
