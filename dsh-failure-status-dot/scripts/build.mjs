import { readFile, writeFile } from 'node:fs/promises';

try {
  const args = process.argv.slice(2);
  if (args.some(value => value !== '--check') || args.length > 1) throw new Error('Usage: node scripts/build.mjs [--check]');
  const policy = await readFile(new URL('../policy.js', import.meta.url), 'utf8');
  const template = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  if (template.split('/* @policy */').length !== 2) throw new Error('Client template must contain exactly one policy insertion point');
  const generated = template.replace('/* @policy */', () => policy.replace(/^export /gmu, ''));
  const target = new URL('../client.js', import.meta.url);
  if (args.includes('--check')) {
    const current = await readFile(target, 'utf8');
    if (current !== generated) throw new Error('Generated client is stale; run node scripts/build.mjs');
    console.log('Generated client matches its sources');
  } else {
    await writeFile(target, generated);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
