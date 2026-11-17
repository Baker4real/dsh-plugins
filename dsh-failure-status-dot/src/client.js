window.__ModuleLoader__.load({
  id: '@local/dsh-failure-status-dot',
  factory(require) {
    const React = require('react');
    // POLICY: generated from the same pure functions used by the Host and tests.
    /* @policy */

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
