window.__ModuleLoader__.load({
  id: '@local/dsh-goal-wait',
  factory(require) {
    const { createElement, useSyncExternalStore } = require('react');
    const namespace = 'local-goal-wait';
    const slot = 'conversation.chat.turnTail';
    const style = {
      margin: '0 0 8px',
      color: 'var(--dsw-alias-label-primary)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, {
          zh: { waiting: '等待人工操作' },
          en: { waiting: 'Human action needed' },
        }), 'goal-wait: locale');
        const t = ctx.locale.bind(namespace);
        const localeSnapshot = ctx.locale.getSnapshot.bind(ctx.locale);
        const subscribeLocale = ctx.locale.subscribe.bind(ctx.locale);

        function WaitNotice({ turn, useProjection }) {
          const notice = useProjection('localGoalWait');
          useSyncExternalStore(subscribeLocale, localeSnapshot);
          if (notice?.turn !== turn.turn) return null;
          return createElement('p', { 'data-dsh-goal-wait-action': turn.turn, style },
            createElement('strong', null, t('waiting')), '　', notice.action);
        }

        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: '@local/dsh-goal-wait' }, WaitNotice));
      },
    };
  },
});
