window.__ModuleLoader__.load({
  id: '@local/dsh-devtools',
  factory() {
    // Runtime diagnostics expose identifiers and known failure classes only.
    // An arbitrary exception can contain user config, so its raw text stays local.
    function failure(value) {
      const message = String(value instanceof Error ? value.message : value?.message ?? value);
      if (/^(?:Error:\s*)?slot ["'][\w.:-]{1,128}["'] is already declared/u.test(message)) return { code: 'SLOT_ALREADY_DECLARED' };
      if (/^(?:Error:\s*)?sessions\.retain: unknown session [\w-]{1,128}/u.test(message)) return { code: 'UNKNOWN_SESSION' };
      if (/not registered|no registered factory/u.test(message)) return { code: 'REGISTRATION_MISSING' };
      if (/inject|service|dependency/u.test(message)) return { code: 'DEPENDENCY_FAILURE' };
      return { code: 'PLUGIN_FAILURE', detail: 'Raw exception omitted because it can contain configuration values.' };
    }
    function packageMatches(id, name) { return name === undefined || id === name || id.startsWith(`${name}/`); }
    function ownsRegistration(occupant, name) {
      if (name === undefined) return true;
      const registrant = occupant.registrant ?? '';
      if (packageMatches(registrant, name)) return true;
      const id = typeof occupant.id === 'string' ? occupant.id : typeof occupant.options?.id === 'string' ? occupant.options.id : '';
      return id === name || id.startsWith(`${name}-`) || id.startsWith(`${name}/`);
    }
    function slotRegistrations(slots, name) {
      if (typeof slots?.snapshot !== 'function') return [];
      const found = [];
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'slot' && Array.isArray(node.occupants)) {
          for (const occupant of node.occupants) {
            if (!ownsRegistration(occupant, name)) continue;
            found.push({ slot: node.name, id: occupant.id ?? null, key: occupant.key ?? null, registrant: occupant.registrant ?? null, order: occupant.order ?? null, priority: occupant.priority ?? 0, active: occupant.active === true });
          }
        }
        if (Array.isArray(node.children)) for (const child of node.children) visit(child);
      };
      const roots = slots.snapshot();
      if (Array.isArray(roots)) for (const root of roots) visit(root);
      return found;
    }
    const pageFields = ['pageId', 'documentId', 'url', 'sessionId', 'graphRevision'];
    const receiptKey = 'dsh-devtools/reload-receipt';
    function createPageInspection(ctx) {
      const identity = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      const documentKey = Symbol.for('dsh-devtools.document-identity');
      if (typeof document !== 'undefined' && !document[documentKey]) document[documentKey] = identity('document');
      const pageId = identity('page');
      const documentId = typeof document === 'undefined' ? null : document[documentKey];
      let previousSignature, graphRevision;
      let graphSequence = 0;
      function base() {
        const modules = ctx.get('modules');
        const state = modules?.entries.state.getSnapshot();
        const entries = modules?.manifest.modules;
        const layout = ctx.get('layout')?.panelInfo.getSnapshot();
        const byId = ctx.get('sessions')?.list.getSnapshot().byId;
        const mains = Object.values(byId ?? {}).filter(session => (session.retainedBy?.mainView ?? 0) > 0);
        const sessionId = layout?.activePanelId === null && mains.length === 1 ? mains[0].id : null;
        const moduleIds = (entries ?? []).map(row => ({ id: row.id, rev: row.rev })).sort((a, b) => a.id.localeCompare(b.id));
        let url = null;
        const pageLocation = window.location ?? document.location ?? document.defaultView?.location;
        if (typeof pageLocation?.origin === 'string' && typeof pageLocation?.pathname === 'string') url = pageLocation.origin + pageLocation.pathname;
        else {
          const href = pageLocation?.href ?? document.URL ?? document.documentURI;
          if (typeof href === 'string' && typeof URL === 'function') {
            const parsed = new URL(href);
            url = parsed.origin + parsed.pathname;
          }
        }
        return { pageId, documentId, url, sessionId, ready: document.readyState === 'complete' && state?.syncing === false && sessionId !== null, modules: moduleIds, signature: JSON.stringify(moduleIds) };
      }
      function safeUrl() {
        const url = base().url;
        return typeof url === 'string' && url.length > 0 && url.length <= 2048 ? url : null;
      }
      function snapshot() {
        if (!documentId) throw new Error('PAGE_DOCUMENT_UNAVAILABLE');
        const current = base();
        if (!/^https?:\/\//u.test(current.url) && !['app://./index.html', 'dsh-app://app/'].includes(current.url)) throw new Error('PAGE_LOCATION_UNAVAILABLE');
        if (current.signature !== previousSignature) {
          previousSignature = current.signature;
          graphRevision = `${pageId}:graph:${++graphSequence}`;
        }
        return { page: { pageId, documentId, url: current.url, sessionId: current.sessionId, graphRevision, ready: current.ready }, modules: current.modules, signature: current.signature };
      }
      function matches(target, page) { return pageFields.every(key => target[key] === undefined || target[key] === page[key]); }
      function differed(target, page) { return pageFields.filter(key => target[key] !== undefined && target[key] !== page[key]); }
      function currentMatches(result) {
        const current = base();
        return ['pageId', 'documentId', 'url', 'sessionId'].every(key => current[key] === result.page[key]) && current.signature === result.signature && current.ready;
      }
      const elementIds = new WeakMap();
      let elementSequence = 0;
      function elementState(selector) {
        if (typeof selector !== 'string' || selector.length < 1 || selector.length > 256) throw new Error('INVALID_SELECTOR');
        let elements;
        try { elements = document.querySelectorAll(selector); } catch { return { status: 'invalid-selector', matches: 0 }; }
        if (elements.length !== 1) return { status: elements.length ? 'ambiguous' : 'not-found', matches: elements.length };
        const element = elements[0];
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const expanded = element.getAttribute('aria-expanded');
        if (!elementIds.has(element)) elementIds.set(element, ++elementSequence);
        const inViewport = rect.left < (window.innerWidth ?? Infinity) && rect.top < (window.innerHeight ?? Infinity) && rect.left + rect.width > 0 && rect.top + rect.height > 0;
        const painted = typeof element.checkVisibility !== 'function' || element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        const visible = rect.width > 0 && rect.height > 0 && inViewport && painted && Number(style.opacity ?? 1) > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        const hitTarget = hit === element || (hit !== null && element.contains?.(hit) === true);
        const geometry = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        const token = JSON.stringify([pageId, documentId, base().sessionId, graphRevision, elementIds.get(element), geometry, expanded, visible, style.pointerEvents ?? null, !!element.disabled, hitTarget]);
        return { status: 'found', matches: 1, visible, hitTarget, token, ariaExpanded: expanded === 'true' ? true : expanded === 'false' ? false : null, rect: geometry };
      }
      function activate(target, action) {
        const latest = snapshot();
        if (!matches(target, latest.page) || !latest.page.ready) return false;
        const state = elementState(action.selector);
        if (state.status !== 'found' || !state.visible || !state.hitTarget || state.token !== action.elementToken) return false;
        const element = document.querySelectorAll(action.selector)[0];
        if (element.disabled || element.isConnected === false || typeof element.click !== 'function' || getComputedStyle(element).pointerEvents === 'none') return false;
        if (!currentMatches(latest)) return false;
        element.click();
        return true;
      }
      return { snapshot, safeUrl, matches, differed, currentMatches, elementState, activate };
    }
    function connectPageReload(ctx, page) {
      const pageLocation = window.location ?? (typeof document === 'undefined' ? undefined : document.location ?? document.defaultView?.location);
      if (typeof fetch !== 'function' || typeof AbortController !== 'function' || typeof pageLocation?.reload !== 'function') return;
      ctx.effect(() => {
        const controller = new AbortController();
        let receipt = null;
        try {
          const saved = window.sessionStorage?.getItem(receiptKey);
          if (saved && saved.length < 1024) receipt = JSON.parse(saved);
          window.sessionStorage?.removeItem(receiptKey);
        } catch { receipt = null; }
        const post = async (operation, input) => {
          const response = await fetch(`api/dsh-devtools/page/${operation}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
          if (!response.ok) throw new Error('PAGE_CHANNEL_UNAVAILABLE');
          return await response.json();
        };
        const pause = (milliseconds = 2000) => new Promise(resolve => {
          const end = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', end); resolve(); };
          const timer = setTimeout(end, milliseconds);
          controller.signal.addEventListener('abort', end, { once: true });
          if (controller.signal.aborted) end();
        });
        const run = async () => {
          while (!controller.signal.aborted) {
            try {
              const current = await page.snapshot();
              const command = await post('poll', { ...current.page, ...(receipt ? { receipt } : {}) });
              if (!['reload', 'click'].includes(command.action)) { await pause(Number.isFinite(command.retryAfterMs) ? Math.max(100, Math.min(2000, command.retryAfterMs)) : 2000); continue; }
              const latest = await page.snapshot();
              const valid = page.matches(command.target, latest.page) && latest.page.ready;
              const acknowledged = await post('ack', { requestId: command.requestId, page: latest.page, rejected: !valid });
              if (controller.signal.aborted) return;
              if (!valid || !acknowledged.accepted || !page.currentMatches(latest)) continue;
              if (command.action === 'click') {
                if (!Number.isFinite(acknowledged.expiresAt) || Date.now() > acknowledged.expiresAt) continue;
                const activated = page.activate(command.target, command.element ?? {});
                await post('ack', { requestId: command.requestId, page: page.snapshot().page, completed: true, rejected: !activated });
                continue;
              }
              window.sessionStorage.setItem(receiptKey, JSON.stringify({ requestId: command.requestId, previousPageId: latest.page.pageId, previousDocumentId: latest.page.documentId }));
              pageLocation.reload();
              return;
            } catch {
              if (!controller.signal.aborted) await pause();
            }
          }
        };
        void run();
        return () => controller.abort();
      }, 'devtools: authenticated page reload channel');
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        const errors = [];
        const page = createPageInspection(ctx);
        connectPageReload(ctx, page);
        ctx.inject(['cordisInspect'], inspectCtx => inspectCtx.effect(() => inspectCtx.cordisInspect.register({
          manifest: {
            id: 'Page', description: 'Read-only inspection bound to the exact page URL and active main Session. A mismatch returns only that page origin and pathname.',
            methods: [{ name: 'inspect', description: 'Read page and module generations plus optional selector visibility and aria-expanded, without DOM text or navigation.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Current GUI origin and pathname, without query or fragment.' }, sessionId: { type: 'string', description: 'Active main Session id.' }, pageId: { type: 'string' }, documentId: { type: 'string' }, graphRevision: { type: 'string' }, packageName: { type: 'string' }, selector: { type: 'string', description: 'One CSS selector, at most 256 characters.' }, requireMatch: { type: 'boolean', description: 'Reject nonmatching pages so the Host can accept a different connected page. Defaults to false for path diagnostics.' } }, required: ['url', 'sessionId'], additionalProperties: false }, outputSchema: { description: 'Matched page identity, actual module revisions and optional structural element state.' } }],
          },
          async query(method, input = {}) {
            if (method !== 'inspect') throw new Error('Unknown Page method');
            if (typeof input.url !== 'string' || input.url.length > 2048 || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.sessionId)) throw new Error('INVALID_PAGE_TARGET');
            let result;
            try { result = page.snapshot(); } catch (error) {
              if (error?.message !== 'PAGE_LOCATION_UNAVAILABLE') throw error;
              const url = page.safeUrl();
              if (url === null) throw error;
              return { status: 'mismatch', page: { url }, mismatch: ['url'] };
            }
            const fields = page.differed(input, result.page);
            if (fields.length) {
              if (input.requireMatch === true) throw new Error('PAGE_TARGET_MISMATCH');
              return { status: 'mismatch', page: { url: result.page.url }, mismatch: fields };
            }
            if (input.packageName !== undefined && (typeof input.packageName !== 'string' || !/^[A-Za-z0-9@_./-]{1,214}$/u.test(input.packageName))) throw new Error('INVALID_PACKAGE_NAME');
            const selected = result.modules.filter(row => packageMatches(row.id, input.packageName));
            return { status: result.page.ready ? 'ready' : 'not-ready', page: result.page, modules: selected.slice(0, 25), modulesTruncated: selected.length > 25, ...(input.selector === undefined ? {} : { element: page.elementState(input.selector) }) };
          },
        }), 'devtools: identity-bound Page inspection'));
        ctx.effect(() => ctx.slots.onEntryError((key, entry, error) => {
          if (errors.length < 20) errors.push({ slot: key, registrant: entry.registrant ?? null, ...failure(error) });
        }), 'devtools: bounded slot diagnostics');
        ctx.inject(['cordisInspect'], inspectCtx => inspectCtx.effect(() => inspectCtx.cordisInspect.register({
          manifest: {
            id: 'Runtime',
            description: 'Read-only Client module failures, Slot winner and Session catalog availability; never opens history or navigates.',
            methods: [{ name: 'status', description: 'Read loaded module ids and classified failures. Omit slot to list this package\'s own registrations; a Slot winner is returned only for the slot you name.', inputSchema: { type: 'object', properties: { packageName: { type: 'string' }, slot: { type: 'string' }, entryKey: { type: 'string' }, sessionId: { type: 'string' } }, additionalProperties: false }, outputSchema: { description: 'Client graph identity, bounded classified failures, this package\'s registrations when slot is omitted, and one named Slot winner.' } }],
          },
          query(method, input = {}) {
            if (method !== 'status') throw new Error('Unknown Runtime method');
            for (const [key, value] of Object.entries(input)) if (typeof value !== 'string' || value.length > (key === 'packageName' ? 214 : 128) || !/^[A-Za-z0-9@_./:-]+$/u.test(value)) throw new Error('Invalid Runtime identifier');
            const modules = ctx.get('modules');
            const state = modules?.entries.state.getSnapshot();
            const entries = (modules?.manifest.modules ?? []).filter(row => packageMatches(row.id, input.packageName));
            const namedSlot = input.slot;
            let slot = null;
            let registrations;
            let registrationsTruncated = false;
            if (namedSlot === undefined) {
              const rows = slotRegistrations(ctx.slots, input.packageName);
              registrationsTruncated = rows.length > 25;
              registrations = rows.slice(0, 25);
            } else {
              const rows = slotRegistrations(ctx.slots, input.packageName).filter(row => row.slot === namedSlot && (input.entryKey === undefined || row.key === input.entryKey));
              let winner = rows.find(row => row.active) ?? rows[0];
              if (winner === undefined && typeof ctx.slots.entriesOfSlot === 'function') {
                const legacy = ctx.slots.entriesOfSlot(namedSlot).filter(entry => (input.entryKey === undefined || entry.options.key === input.entryKey) && ownsRegistration(entry, input.packageName)).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
                winner = legacy === undefined ? undefined : { key: legacy.options.key ?? null, registrant: legacy.registrant ?? null, priority: legacy.options.priority ?? 0 };
              }
              slot = { name: namedSlot, winner: winner === undefined ? null : { key: winner.key ?? null, registrant: winner.registrant ?? null, priority: winner.priority ?? 0 } };
            }
            const sessions = ctx.get('sessions');
            const catalog = sessions?.list.getSnapshot().byId;
            return {
              platform: 'client',
              moduleSystem: modules === undefined ? 'unavailable' : 'available',
              release: modules?.manifest.release?.version ?? null,
              syncing: state?.syncing ?? null,
              entries: entries.slice(0, 25).map(row => ({ id: row.id, rev: row.rev, immediately: row.immediately ?? null })),
              entriesTruncated: entries.length > 25,
              failures: (state?.failures ?? []).filter(row => packageMatches(row.id, input.packageName)).slice(0, 20).map(row => ({ id: row.id, ...failure(row) })),
              slot,
              ...(registrations === undefined ? {} : { registrations, registrationsTruncated }),
              slotErrors: errors.filter(row => (namedSlot === undefined || row.slot === namedSlot) && packageMatches(row.registrant ?? '', input.packageName)),
              ...(input.sessionId === undefined ? {} : { session: { id: input.sessionId, catalogued: catalog === undefined ? null : Object.hasOwn(catalog, input.sessionId), retained: sessions?.binding(input.sessionId) !== undefined, historyOpenedByThisQuery: false } }),
            };
          },
        }), 'devtools: Client Runtime'));
        ctx.inject(['cordisInspect'], inspectCtx => inspectCtx.effect(() => inspectCtx.cordisInspect.register({
          manifest: {
            id: 'Desktop',
            description: 'Read-only selector geometry and computed hit-test style; never returns DOM text or performs input.',
            methods: [{ name: 'inspectElement', description: 'Read one unique visible element and its upper, center and lower CSS-pixel points.', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'Unique CSS selector, at most 256 characters.' } }, required: ['selector'], additionalProperties: false }, outputSchema: { description: 'Bounded geometry, DPR and whitelisted computed styles; no text content.' } }],
          },
          query(method, input = {}) {
            if (method !== 'inspectElement') throw new Error('Unknown Desktop method');
            if (typeof input.selector !== 'string' || input.selector.length < 1 || input.selector.length > 256) throw new Error('selector must contain 1 to 256 characters');
            let elements;
            try { elements = document.querySelectorAll(input.selector); }
            catch { return { platform: 'client', error: { code: 'INVALID_SELECTOR' } }; }
            if (elements.length === 0) return { platform: 'client', error: { code: 'ELEMENT_NOT_FOUND' } };
            if (elements.length !== 1) return { platform: 'client', error: { code: 'ELEMENT_NOT_UNIQUE', matches: elements.length } };
            const element = elements[0];
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return { platform: 'client', error: { code: 'ELEMENT_NOT_VISIBLE' } };
            const style = getComputedStyle(element);
            const x = rect.left + rect.width / 2;
            const points = { upper: { x, y: rect.top + 4 }, center: { x, y: rect.top + rect.height / 2 }, lower: { x, y: rect.top + rect.height - 4 } };
            const hitTargets = Object.fromEntries(Object.entries(points).map(([name, point]) => {
              const hit = document.elementFromPoint(point.x, point.y);
              return [name, hit === element || (hit !== null && element.contains(hit))];
            }));
            const popover = element.closest('[popover]');
            return {
              platform: 'client', status: 'ok', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              points, hitTargets,
              devicePixelRatio: window.devicePixelRatio || 1,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              appRegion: style.webkitAppRegion ?? style.getPropertyValue?.('-webkit-app-region') ?? null,
              display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
              windowsTitlebar: document.documentElement.hasAttribute('data-windows-titlebar'),
              popoverOpen: popover === null ? false : popover.matches(':popover-open'),
            };
          },
        }), 'devtools: Client Desktop'));
      },
    };
  },
});
