import { canonicalPageUrl, pageIdentity } from './page-bridge.js';

const properties = {
  action: { type: 'string', enum: ['inspect', 'reload', 'click'], description: 'inspect reads. reload waits for a new document; reload requires pageId, documentId and graphRevision. click activates the inspected element and verifies its declared result; click requires pageId, documentId, graphRevision, selector, elementToken, verifySelector and expectedVisible.' },
  url: { type: 'string', description: 'Actual page origin/path from inspection, including dsh-app://app/ on Desktop. No credentials, query or fragment.' },
  sessionId: { type: 'string', description: 'Active main Session; defaults to the requesting Agent id.' },
  active: { type: 'boolean', description: 'For inspect only: atomically inspect the current active main Session without supplying sessionId.' },
  pageId: { type: 'string', description: 'Exact identity from inspect; required for reload and click.' },
  documentId: { type: 'string', description: 'Exact document identity from inspect; required for reload and click.' },
  graphRevision: { type: 'string', description: 'Exact module graph identity from inspect; required for reload and click.' },
  packageName: { type: 'string', description: 'Optional exact Client module package to compare against the Host advertisement.' },
  selector: { type: 'string', description: 'Unique CSS selector, at most 256 characters; required for click and whenever expectedExpanded is set.' },
  expectedExpanded: { type: 'boolean', description: 'Expected aria-expanded on the inspected or verification selector; requires selector.' },
  elementToken: { type: 'string', description: 'Fresh inspect token required for click; changes with element identity, layout or state.' },
  verifySelector: { type: 'string', description: 'Required for click; unique selector whose resulting visible state is checked.' },
  expectedVisible: { type: 'boolean', description: 'Required for click; expected visibility of verifySelector after activation.' },
  expectNoRenderErrors: { type: 'boolean', description: 'For inspect: require the current session to have no reported RenderBoundary errors.' },
};

export function pageVerification(result, args, advertised) {
  const visible = result.element?.status === 'found' && result.element.visible === true && result.element.hitTarget !== false;
  const absent = result.element?.status === 'not-found' || (result.element?.status === 'found' && result.element.visible === false);
  const expected = args.expectedVisible ?? true;
  const matchesVisibility = expected ? visible : absent;
  const element = args.selector === undefined ? 'not-requested' : !matchesVisibility || (args.expectedExpanded !== undefined && result.element?.ariaExpanded !== args.expectedExpanded) ? 'failed' : 'passed';
  const module = args.packageName === undefined ? 'not-requested' : !advertised || result.modules?.find(row => row.id === args.packageName)?.rev !== advertised.rev ? 'failed' : 'passed';
  const renderErrors = args.expectNoRenderErrors !== true ? 'not-requested' : Array.isArray(result.renderErrors) && result.renderErrors.length === 0 ? 'passed' : 'failed';
  return { pageReady: result.page?.ready === true, element, matchesAdvertisedModule: module, renderErrors, passed: result.page?.ready === true && element !== 'failed' && module !== 'failed' && renderErrors !== 'failed', sourceBuildVerified: false };
}

export function validatePageActionDeclaration(args) {
  if (args?.expectedExpanded !== undefined && (typeof args.expectedExpanded !== 'boolean' || args.selector === undefined)) return 'SELECTOR_REQUIRED';
  if (args?.action !== 'inspect' && ['pageId', 'documentId', 'graphRevision'].some(key => typeof args?.[key] !== 'string')) return 'TARGET_IDENTITY_REQUIRED';
  if (args?.action === 'click' && (typeof args.selector !== 'string' || typeof args.elementToken !== 'string' || typeof args.verifySelector !== 'string' || typeof args.expectedVisible !== 'boolean')) return 'CLICK_TARGET_AND_VERIFICATION_REQUIRED';
  return undefined;
}

export function createPageTool(ctx, bridge) {
  return {
    name: 'dsh_page',
    description: 'Inspect or act on the exact Harness page for a Session. Click uses a fresh element token and verifies the resulting state on that same page. Reload verifies a new document. No native keys, coordinates or new pages.',
    parameters: { type: 'object', properties, required: ['action', 'url'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 40000,
    isConcurrencySafe: args => args?.action === 'inspect',
    async execute(args, exec) {
      if (!args || !['inspect', 'reload', 'click'].includes(args.action) || !exec.agent) throw new Error('INVALID_PAGE_ACTION');
      if (args.active !== undefined && typeof args.active !== 'boolean') return { status: 'rejected', code: 'INVALID_ACTIVE' };
      if (args.active === true && args.action !== 'inspect') return { status: 'rejected', code: 'ACTIVE_INSPECT_ONLY' };
      if (args.expectNoRenderErrors !== undefined && (args.action !== 'inspect' || typeof args.expectNoRenderErrors !== 'boolean')) return { status: 'rejected', code: 'INVALID_RENDER_ERROR_EXPECTATION' };
      const url = canonicalPageUrl(args.url);
      const sessionId = args.active === true ? undefined : args.sessionId ?? exec.agent.id;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(sessionId))) throw new Error('INVALID_SESSION_ID');
      const declarationError = validatePageActionDeclaration(args);
      if (declarationError === 'SELECTOR_REQUIRED') throw new Error(declarationError);
      if (declarationError) return { status: 'rejected', code: declarationError };
      const target = { url, ...(sessionId === undefined ? {} : { sessionId }), ...(args.active === true ? { active: true } : {}), ...Object.fromEntries(['pageId', 'documentId', 'graphRevision', 'packageName', 'selector'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
      const query = input => ctx.cordisInspect.query('client', 'Page', 'inspect', { ...input, requireMatch: true }, exec.agent, exec.signal);
      let before;
      try { before = await query(target); } catch { return { status: 'unverified', code: 'MATCHING_PAGE_UNAVAILABLE' }; }
      if (before?.status === 'mismatch') return { status: 'unverified', code: 'MATCHING_PAGE_UNAVAILABLE', pages: typeof before.page?.url === 'string' ? [before.page.url] : [], mismatch: Array.isArray(before.mismatch) ? before.mismatch : [] };
      const advertised = ctx.clientModules.graph().entries.find(row => row.id === args.packageName);
      if (args.action === 'inspect') return { ...before, verification: pageVerification(before, args, advertised) };
      if (args.action === 'click') {
        if (before.element?.status !== 'found' || before.element.visible !== true || before.element.token !== args.elementToken) return { status: 'rejected', code: 'ELEMENT_CHANGED' };
        const clicked = await bridge.click(pageIdentity(before.page), { selector: args.selector, elementToken: args.elementToken }, { signal: exec.signal });
        if (clicked.status !== 'clicked') return clicked;
        const verify = { ...target, selector: args.verifySelector };
        let after;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (exec.signal?.aborted) return { status: 'unverified', code: 'CANCELLED', clicked: true };
          try { after = await query(verify); } catch { return { status: 'unverified', code: 'CLICK_VERIFICATION_UNAVAILABLE', clicked: true }; }
          if (after?.status === 'mismatch') return { status: 'unverified', code: 'PAGE_IDENTITY_CHANGED', clicked: true };
          const verification = pageVerification(after, { ...args, selector: args.verifySelector }, ctx.clientModules.graph().entries.find(row => row.id === args.packageName));
          if (verification.passed || attempt === 9) return { status: verification.passed ? 'verified' : 'unverified', requestId: clicked.requestId, clicked: true, page: after.page, element: after.element, verification };
          await new Promise(resolve => { const timer = setTimeout(done, 100); function done() { clearTimeout(timer); exec.signal?.removeEventListener('abort', done); resolve(); } exec.signal?.addEventListener('abort', done, { once: true }); });
        }
      }
      const reloaded = await bridge.reload(pageIdentity(before.page), { signal: exec.signal });
      if (reloaded.status !== 'reloaded') return reloaded;
      let after;
      try { after = await query({ ...target, ...Object.fromEntries(['pageId', 'documentId', 'graphRevision'].map(key => [key, reloaded.page[key]])) }); } catch { return { ...reloaded, status: 'unverified', code: 'RELOAD_VERIFICATION_UNAVAILABLE' }; }
      if (after?.status === 'mismatch') return { status: 'unverified', code: 'RELOAD_VERIFICATION_UNAVAILABLE', requestId: reloaded.requestId, reloaded: true, pages: typeof after.page?.url === 'string' ? [after.page.url] : [], mismatch: Array.isArray(after.mismatch) ? after.mismatch : [] };
      const verification = pageVerification(after, args, ctx.clientModules.graph().entries.find(row => row.id === args.packageName));
      return { status: verification.passed ? 'verified' : 'unverified', requestId: reloaded.requestId, reloaded: true, page: after.page, modules: after.modules, ...(after.element === undefined ? {} : { element: after.element }), verification };
    },
  };
}
