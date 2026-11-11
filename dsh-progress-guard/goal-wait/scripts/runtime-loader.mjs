import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_GOAL_WAIT_DSH_ROOT || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const anchor = pathToFileURL(`${root}/package.json`).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') || specifier === 'zod' ? { ...context, parentURL: anchor } : context);
} });
