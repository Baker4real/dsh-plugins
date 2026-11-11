// A separate module URL gives this temporary rerun a fresh fixture generation.
// The long-lived Host intentionally caches ordinary installed plugin modules.
export { inject, apply } from './verify.js?loop-requests-only';
