import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const chatPatchId = 'chat-final-reply-visibility';
export const managedInventory = 'D:/Codex/tools/dsh-maint/local-patches.json';
const sha256 = /^[0-9A-F]{64}$/;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read managed Chat ${label} (${error.code ?? 'invalid JSON'}): ${path}. Restore the dsh-maint registration.`);
  }
}

export function checkManagedChatPatch({ asarPath, hostVersion, inventoryPath = managedInventory }) {
  const inventory = readJson(inventoryPath, 'inventory');
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.patches)) {
    throw new Error(`Invalid managed Chat inventory: ${inventoryPath}. Restore the dsh-maint registration.`);
  }
  const entries = inventory.patches.filter(entry => entry?.id === chatPatchId);
  if (entries.length !== 1 || typeof entries[0].definition !== 'string') {
    throw new Error(`Expected one ${chatPatchId} definition in ${inventoryPath}. Fix the dsh-maint registration.`);
  }
  const directory = dirname(inventoryPath);
  const definitionPath = resolve(directory, entries[0].definition);
  const rel = relative(directory, definitionPath);
  if (isAbsolute(entries[0].definition) || isAbsolute(rel) || !rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Keep the ${chatPatchId} definition relative to and below ${inventoryPath}.`);
  }
  const definition = readJson(definitionPath, 'definition');
  if (definition?.id !== chatPatchId || typeof definition.release !== 'string'
    || typeof definition.baseSha256 !== 'string' || !sha256.test(definition.baseSha256)
    || typeof definition.appliedSha256 !== 'string' || !sha256.test(definition.appliedSha256)
    || definition.baseSha256 === definition.appliedSha256) {
    throw new Error(`Invalid ${chatPatchId} definition: ${definitionPath}. Check id, release and distinct SHA-256 hashes.`);
  }
  if (definition.release !== hostVersion) {
    throw new Error(`${chatPatchId}: release mismatch (Host ${hostVersion}, registered ${definition.release.slice(0, 64)}). Verify the dsh-maint definition for this Host.`);
  }

  let actual;
  const previousNoAsar = process.noAsar;
  try {
    // Electron must hash the raw archive, not the virtual directory it exposes.
    process.noAsar = true;
    actual = createHash('sha256').update(readFileSync(asarPath)).digest('hex').toUpperCase();
  } catch (error) {
    throw new Error(`Cannot read managed Chat archive (${error.code ?? 'read failed'}): ${asarPath}. Check the installed DSH resources path.`);
  } finally {
    process.noAsar = previousNoAsar;
  }
  if (actual !== definition.appliedSha256) {
    const hint = actual === definition.baseSha256
      ? 'replay-required: archive matches the registered base. Use the dsh-maint patch replay workflow.'
      : `unknown-drift: archive ${actual.slice(0, 12)} does not match registered ${definition.appliedSha256.slice(0, 12)}. Inspect the ASAR and registration; do not replay blindly.`;
    throw new Error(`${chatPatchId} (${hostVersion}): ${hint}`);
  }
  return { id: chatPatchId, release: hostVersion, appliedSha256: actual };
}
