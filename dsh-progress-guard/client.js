window.__ModuleLoader__.load({
  id: '@local/dsh-progress-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'progress-guard';
    const SLOT = 'conversation.chat.node';
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: { repeated: '重复进度已折叠 · 展开原文' },
          en: { repeated: 'Repeated progress folded · Show original' },
        }), 'progress-guard: locale');
        const translate = ctx.locale.bind(NS);
        let registrationCount = 0;
        let renderCount = 0;
        let foldCount = 0;
        const errors = [];
        ctx.effect(() => ctx.slots.onEntryError((key, _entry, cause) => {
          if (key === SLOT && errors.length < 5) errors.push('SLOT_RENDER_FAILED');
        }), 'progress-guard: entry diagnostics');
        ctx.inject(['cordisInspect'], inspectCtx => inspectCtx.effect(() => inspectCtx.cordisInspect.register({
          manifest: {
            id: 'ProgressGuard',
            description: 'Read-only status of the installed progress folding renderer; no message contents.',
            methods: [{ name: 'status', description: 'Return active registration and rendering counters.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { description: 'Version, active slot, counters and bounded slot errors.' } }],
          },
          query(method) {
            if (method !== 'status') throw new Error(`Unknown ProgressGuard method: ${method}`);
            const winner = ctx.slots.entriesOfSlot(SLOT).filter(entry => entry.options.key === 'assistant-step').sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
            return { version: '1.0.0', registrationCount, renderCount, foldCount, active: winner?.registrant === '@local/dsh-progress-guard', registrant: winner?.registrant ?? null, errors, childEntries: ['conversation.chat.reasoning.body', 'conversation.chat.message.images'].map(name => { const entry = ctx.slots.entriesOfSlot(name)[0]; return { name, registrant: entry?.registrant ?? null, inject: entry?.inject !== undefined, store: entry?.store !== undefined, children: entry?.children !== undefined, locale: entry?.locale ?? null }; }) };
          },
        }), 'progress-guard: status'));
        ctx.slots.inject(SLOT, () => {
          let observed;
          let dispose;
          let closed = false;
          let queued = false;
          const refresh = () => {
            queued = false;
            if (closed || dispose !== undefined) return;
            const original = ctx.slots.entriesOfSlot(SLOT).filter(entry => entry.options.key === 'assistant-step' && entry.registrant !== '@local/dsh-progress-guard').sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
            if (original === observed) return;
            dispose?.();
            dispose = undefined;
            observed = original;
            if (original === undefined) return;
          const Original = original.component;
          const childSources = new Map();
          function ForwardChild({ name, owner, standard }) {
            let source = childSources.get(name);
            if (source === undefined) {
              source = { subscribe: listener => ctx.slots.subscribe(name, listener), getSnapshot: () => ctx.slots.getVersion(name) };
              childSources.set(name, source);
            }
            React.useSyncExternalStore(source.subscribe, source.getSnapshot);
            const child = ctx.slots.entriesOfSlot(name)[0];
            if (child === undefined) return null;
            // The installed children are stateless Factory forwarders. Delegate
            // their live entries instead of redeclaring their owned Slot keys.
            // A future stateful child must use the official renderer's boundary.
            if (child.inject !== undefined || child.store !== undefined || child.children !== undefined) {
              throw new Error(`Progress guard cannot forward a stateful child renderer: ${name}`);
            }
            return h(child.component, { ...standard, ...(child.locale === undefined ? {} : { t: ctx.locale.bind(child.locale) }), ...owner });
          }
          function GuardedAssistant(props) {
            renderCount += 1;
            const { node, groupPart } = props;
            const renderSlot = React.useCallback((name, owner) => {
              if (!Object.hasOwn(original.children ?? {}, name)) throw new Error(`Progress guard received an undeclared child: ${name}`);
              return h(ForwardChild, { name, owner, standard: props });
            }, [props]);
            const delegated = { ...props, renderSlot };
            const projection = props.useProjection('progressGuard');
            const messageId = node.data.finalNode?.messageId;
            const duplicate = messageId === undefined ? undefined : projection?.duplicates[messageId];
            const texts = node.data.blocks.filter(block => block.kind === 'text');
            if (!duplicate || node.data.status !== 'settled' || texts.length === 0 || groupPart === 'reasoning') {
              return h(Original, delegated);
            }
            foldCount += 1;
            const otherBlocks = node.data.blocks.filter(block => block.kind !== 'text');
            return h(React.Fragment, null,
              otherBlocks.length === 0 ? null : h(Original, { ...delegated, node: { ...node, data: { ...node.data, blocks: otherBlocks } } }),
              h('details', {
                'data-progress-guard': messageId,
                style: { color: 'var(--dsw-alias-label-secondary)', margin: '4px 0' },
              },
                h('summary', { style: { cursor: 'pointer', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: '24px' } }, translate('repeated')),
                h(Original, { ...delegated, node: { ...node, data: { ...node.data, blocks: texts } } }),
              ),
            );
          }
          // Delegate all business rendering to the existing entry, including its
          // injected hooks, localization and child slots. No DOM patching.
          registrationCount += 1;
          dispose = ctx.slots.register({
            name: SLOT,
            registrant: '@local/dsh-progress-guard',
            key: 'assistant-step',
            priority: (original.options.priority ?? 0) - 1,
            ...(original.inject === undefined ? {} : { inject: original.inject }),
            ...(original.store === undefined ? {} : { store: original.store }),
            ...(original.locale === undefined ? {} : { locale: original.locale }),
          }, GuardedAssistant);
          };
          const schedule = () => {
            if (closed || queued) return;
            queued = true;
            queueMicrotask(refresh);
          };
          // The declaration can precede its official keyed occupant during boot.
          // Wait for its first occupant once per declaration lifetime. Once our
          // keyed entry wins, entriesOfSlot intentionally hides the old occupant.
          const unsubscribe = ctx.slots.subscribe(SLOT, schedule);
          schedule();
          return () => { closed = true; unsubscribe(); dispose?.(); };
        });
      },
    };
  },
});
