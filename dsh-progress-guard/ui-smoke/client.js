window.__ModuleLoader__.load({
  id: '@local/dsh-progress-guard-ui-check',
  factory() {
    return {
      inject: ['uiWorkspace', 'timer', 'sessions'],
      apply(ctx) {
        const sessionId = 'session-ed38658d-1cc0-429f-ad8a-01805498863e';
        const progressText = '官方把这张上下文卡片直接写在输入框组件里，没有可往卡片内部追加内容的插槽。我会用现有 dock 插槽放置同一风格的压缩余量入口，这样不改官方包，也不会影响原有上下文卡片和压缩行为。';
        const status = { sessionId, state: 'waiting', folds: 0, toolNodes: 0, collapsedByDefault: false, originalPreserved: false, expansionChangesHeight: false, projectionDuplicates: null };
        ctx.inject(['cordisInspect'], inspectCtx => inspectCtx.effect(() => inspectCtx.cordisInspect.register({
          manifest: { id: 'ProgressGuardSmoke', description: 'Read-only result of the real page folding verification.', methods: [{ name: 'status', description: 'Read DOM verification facts from the real synthetic Host session.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { description: 'Counts, disclosure behavior and preservation checks; no user content.' } }] },
          query(method) { if (method !== 'status') throw new Error('Unknown method'); return { ...status }; },
        }), 'progress-smoke: inspect'));
        const check = () => {
          const binding = ctx.sessions.binding(sessionId);
          if (binding !== undefined) status.projectionDuplicates = Object.keys(binding.session.projections.faceOf('progressGuard').getSnapshot()?.duplicates ?? {}).length;
          const allDetails = [...document.querySelectorAll('details[data-progress-guard]')];
          const details = allDetails.filter(item => item.textContent.includes(progressText));
          status.folds = details.length;
          status.otherFolds = allDetails.length - details.length;
          status.toolNodes = document.querySelectorAll('[data-chat-flow-kind="tool-call"]').length;
          if (details.length === 0) return;
          status.collapsedByDefault = details.every(item => !item.open);
          status.originalPreserved = details.every(item => item.textContent.includes(progressText));
          const first = details[0];
          const closedHeight = first.getBoundingClientRect().height;
          first.open = true;
          status.expansionChangesHeight = first.getBoundingClientRect().height > closedHeight;
          first.open = false;
          status.state = status.folds === 4 && status.originalPreserved && status.collapsedByDefault && status.expansionChangesHeight ? 'pass' : 'fail';
          observer.disconnect();
          if (status.state === 'pass') {
            const turn = details[0].closest('[data-chat-turn]')?.getAttribute('data-chat-turn');
            const process = [...document.querySelectorAll('[data-chat-flow-kind="turn-process"]')].find(item => item.getAttribute('data-chat-turn') === turn);
            const toggle = process?.querySelector('button[aria-expanded="false"]') ?? process?.querySelector('button');
            if (details[0].getBoundingClientRect().height === 0) toggle?.click();
            ctx.timer.timeout(() => details[0].scrollIntoView({ block: 'center' }), 300);
          }
        };
        const observer = new MutationObserver(check);
        ctx.effect(() => {
          observer.observe(document.body, { childList: true, subtree: true });
          ctx.uiWorkspace.openSession(sessionId);
          void ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
            await reference.ready;
            await reference.binding.session.loadThrough(507);
            check();
          });
          return () => observer.disconnect();
        }, 'progress-smoke: open real verification session');
        ctx.timer.timeout(() => { check(); if (status.state === 'waiting') status.state = 'timeout'; observer.disconnect(); }, 15000);
        ctx.effect(() => () => ctx.uiWorkspace.openSession('session-93a054ce-cc0e-4801-9e73-2407c6af7877'), 'progress-smoke: restore repair conversation');
      },
    };
  },
});
