import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import * as manifests from '../schemas.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPageTool } from '../page-tool.js';
import { createInspectTool } from '../inspect-tool.js';
for (const manifest of Object.values(manifests)) for (const method of manifest.methods) assertObjectJsonSchema(method.inputSchema);
let definition;
const registrations = [];
vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { definition = value; } } } });
const context = { slots: { onEntryError: () => () => {} }, effect: fn => fn(), inject: (_keys, callback) => callback({ effect: fn => fn(), cordisInspect: { register(value) { registrations.push(value); return () => {}; } } }) };
definition.factory().apply(context);
for (const registration of registrations) for (const method of registration.manifest.methods) assertObjectJsonSchema(method.inputSchema);
for (const tool of [createPageTool({}, {}), createInspectTool({}, {})]) {
  assertObjectJsonSchema(tool.parameters);
  assertObjectJsonSchema(tool.output.schema);
}
console.log(JSON.stringify({ status: 'passed', capability: 'Provider and tool schemas accepted by the installed Harness compiler', clientProviders: registrations.length, tools: 2 }));
