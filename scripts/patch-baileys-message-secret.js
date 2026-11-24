#!/usr/bin/env node
/**
 * Postinstall patch for `baileys` (pinned to 7.0.0-rc.9).
 *
 * Bug (WhiskeySockets/Baileys#2541, fix in #2566 — unmerged as of 7.0.0-rc14):
 * in `lib/Utils/decode-wa-message.js` the decoded message is unwrapped with
 *     msg = msg.deviceSentMessage?.message || msg;
 * which DISCARDS every sibling field of the `deviceSentMessage` envelope — most
 * importantly `messageContextInfo.messageSecret`.
 *
 * `deviceSentMessage` is only present on messages *we* sent (`fromMe: true`), so
 * that secret is lost exactly for our own outgoing messages. WhatsApp now seals
 * message EDITS inside a `secretEncryptedMessage` encrypted with the original
 * message's `messageSecret`; without the secret the edit cannot be decrypted and
 * never reaches Chatwoot (see tarefas/t06/README.md §8).
 *
 * The npm package ships compiled `lib/**`, so the fix cannot be expressed in
 * TypeScript. This script applies the upstream #2566 merge (`{ ...outer, ...inner }`)
 * to the published file. It is idempotent and fails soft: a missing/unknown file
 * only logs a warning and never breaks `npm install`.
 *
 * CLI:
 *   node scripts/patch-baileys-message-secret.js             # aplica (default, fail-soft)
 *   node scripts/patch-baileys-message-secret.js --strict    # sai com código 1 se o fix
 *                                                            # não for aplicado nem detectado
 *                                                            # (para CI). Não altera o default.
 *   node scripts/patch-baileys-message-secret.js --self-test # valida a transformação
 *                                                            # sem tocar no filesystem
 */
const fs = require('fs');
const path = require('path');

const BUGGY = 'msg = msg.deviceSentMessage?.message || msg;';
// Indentation matches the compiled file (24 spaces for the statement, +4 inside the if).
const FIXED = [
  'if (msg.deviceSentMessage?.message) {',
  '                            const inner = msg.deviceSentMessage.message;',
  '                            const { deviceSentMessage, ...outer } = msg;',
  '                            msg = { ...outer, ...inner };',
  '                        }',
].join('\n');
const ALREADY = 'const { deviceSentMessage, ...outer } = msg;';

const TARGETS = [
  'baileys/lib/Utils/decode-wa-message.js',
  '@whiskeysockets/baileys/lib/Utils/decode-wa-message.js',
];

/**
 * Pure transform so it can be unit-tested without touching the filesystem.
 * @param {string} src
 * @returns {{ changed: boolean, already?: boolean, notFound?: boolean, src: string }}
 */
function patchSource(src) {
  if (src.includes(ALREADY)) return { changed: false, already: true, src };
  if (!src.includes(BUGGY)) return { changed: false, notFound: true, src };
  return { changed: true, src: src.replace(BUGGY, FIXED) };
}

/**
 * Exercises patchSource against a synthetic fixture. Returns true when all assertions
 * pass. No filesystem access, so it is safe to run anywhere.
 */
function runSelfTest() {
  const fixture =
    '    if (something) {\n' +
    '                        msg = msg.deviceSentMessage?.message || msg;\n' +
    '    }\n';

  const apply = patchSource(fixture);
  const second = patchSource(apply.src);
  const unknown = patchSource('const x = 1;\n');

  const checks = [
    ['aplica', apply.changed === true],
    ['preserva envelope', apply.src.includes(ALREADY)],
    ['remove a linha antiga', !apply.src.includes(BUGGY)],
    ['idempotente', second.already === true && second.changed === false],
    ['fail-soft em fonte desconhecida', unknown.notFound === true && unknown.changed === false],
  ];

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`[patch-baileys] self-test ${pass ? 'ok ' : 'FAIL'} - ${name}`);
    if (!pass) ok = false;
  }
  return ok;
}

function main() {
  const stats = { applied: 0, already: 0, notFound: 0 };

  for (const rel of TARGETS) {
    const file = path.join(__dirname, '..', 'node_modules', rel);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    const result = patchSource(original);

    if (result.already) {
      console.log(`[patch-baileys] already patched: ${rel}`);
      stats.already++;
    } else if (result.notFound) {
      console.warn(`[patch-baileys] pattern not found (baileys changed?): ${rel}`);
      stats.notFound++;
    } else if (result.changed) {
      fs.writeFileSync(file, result.src);
      console.log(`[patch-baileys] applied fromMe messageSecret fix: ${rel}`);
      stats.applied++;
    }
  }

  if (!stats.applied) console.log('[patch-baileys] nothing to patch');
  return stats;
}

module.exports = { patchSource, runSelfTest, BUGGY, FIXED, ALREADY, TARGETS };

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    // Set exitCode (instead of process.exit) so stdout is not truncated when piped in CI.
    process.exitCode = runSelfTest() ? 0 : 1;
  } else {
    const stats = main();
    const fixPresent = stats.applied + stats.already > 0;
    if (process.argv.includes('--strict') && !fixPresent) {
      const detail = `applied=${stats.applied} already=${stats.already} notFound=${stats.notFound}`;
      console.error(`[patch-baileys] strict: fix não aplicado nem detectado (${detail})`);
      process.exitCode = 1;
    }
  }
}
