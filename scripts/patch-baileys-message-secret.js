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

function main() {
  let applied = 0;
  for (const rel of TARGETS) {
    const file = path.join(__dirname, '..', 'node_modules', rel);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    const result = patchSource(original);

    if (result.already) {
      console.log(`[patch-baileys] already patched: ${rel}`);
    } else if (result.notFound) {
      console.warn(`[patch-baileys] pattern not found (baileys changed?): ${rel}`);
    } else if (result.changed) {
      fs.writeFileSync(file, result.src);
      applied++;
      console.log(`[patch-baileys] applied fromMe messageSecret fix: ${rel}`);
    }
  }

  if (!applied) console.log('[patch-baileys] nothing to patch');
  return applied;
}

module.exports = { patchSource, BUGGY, FIXED, ALREADY, TARGETS };

if (require.main === module) main();
