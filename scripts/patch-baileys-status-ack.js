#!/usr/bin/env node
/**
 * Postinstall patch for `baileys` (pinned to 7.0.0-rc.9).
 *
 * Bug: WhatsApp sends top-level `<status>` stanzas (contact status updates) over the
 * socket. Baileys 7.0.0-rc.9 registers no handler for `CB:status`, so those stanzas are
 * never acknowledged. Consequences observed in production:
 *   - the instance stays `open` and keeps sending, but stops receiving messages
 *     (or receives them hours late);
 *   - the connection drops with `stream errored out` (ack class="status") roughly
 *     every ~50 minutes.
 * Held-back messages are delivered after this patch without scanning the QR code again.
 *
 * Fix ported from Evolution API 2.3.8 (upstream commits 2f06ff24 "ack incoming status
 * stanzas" and 821d511b "keep the offline queue running when a status ack fails",
 * merged in PR #2805). The published npm package ships compiled `lib/**`, so the fix
 * cannot be expressed in TypeScript; this script rewrites the compiled file. It is
 * idempotent and fails soft: a missing/unknown file only logs a warning and never
 * breaks `npm install`. An already-patched file (e.g. an upstream image that ships the
 * patch) is detected and skipped.
 *
 * CLI:
 *   node scripts/patch-baileys-status-ack.js             # aplica (default, fail-soft)
 *   node scripts/patch-baileys-status-ack.js --strict    # sai com código 1 se o fix não
 *                                                        # for aplicado nem detectado
 *                                                        # (para CI). Não altera o default.
 *   node scripts/patch-baileys-status-ack.js --self-test # valida a transformação
 *                                                        # sem tocar no filesystem
 */
const fs = require('fs');
const path = require('path');

// Presence of the handler definition means the file is already patched.
const ALREADY = 'const handleStatus = async (node) => {';

// 1. Handler definition, inserted right before `handleNotification`. The try/catch keeps
//    the offline queue loop running when a status ack fails (no catch there otherwise).
const ANCHOR_HANDLER = '    const handleNotification = async (node) => {\n';
const INSERT_HANDLER = [
  '    const handleStatus = async (node) => {',
  '        // The offline queue loop has no catch: a throw here would stall it for this socket',
  '        try {',
  '            await sendMessageAck(node);',
  '        }',
  '        catch (error) {',
  "            onUnexpectedError(error, 'acking status');",
  '        }',
  '    };',
].join('\n') + '\n';

// 2. Register the handler in the offline node processor map.
const ANCHOR_MAP = "            ['notification', handleNotification]\n";
const REPLACE_MAP = "            ['notification', handleNotification],\n            ['status', handleStatus]\n";

// 3. Register the websocket listener for `CB:status`.
const ANCHOR_ON =
  "    ws.on('CB:notification', async (node) => {\n" +
  "        await processNode('notification', node, 'handling notification', handleNotification);\n" +
  '    });\n';
const REPLACE_ON =
  ANCHOR_ON +
  "    ws.on('CB:status', async (node) => {\n" +
  "        await processNode('status', node, 'handling status', handleStatus);\n" +
  '    });\n';

const TARGETS = [
  'baileys/lib/Socket/messages-recv.js',
  '@whiskeysockets/baileys/lib/Socket/messages-recv.js',
];

/**
 * Pure transform so it can be unit-tested without touching the filesystem.
 * All-or-nothing: it only rewrites when every anchor is found, never partially.
 * @param {string} src
 * @returns {{ changed: boolean, already?: boolean, notFound?: boolean, missing?: string[], src: string }}
 */
function patchSource(src) {
  if (src.includes(ALREADY)) return { changed: false, already: true, src };

  const missing = [];
  if (!src.includes(ANCHOR_HANDLER)) missing.push('handleNotification');
  if (!src.includes(ANCHOR_MAP)) missing.push('nodeProcessorMap');
  if (!src.includes(ANCHOR_ON)) missing.push('CB:notification');
  if (missing.length) return { changed: false, notFound: true, missing, src };

  let out = src.replace(ANCHOR_HANDLER, INSERT_HANDLER + ANCHOR_HANDLER);
  out = out.replace(ANCHOR_MAP, REPLACE_MAP);
  out = out.replace(ANCHOR_ON, REPLACE_ON);

  return { changed: true, src: out };
}

/**
 * Exercises patchSource against a synthetic fixture. Returns true when all assertions
 * pass. No filesystem access, so it is safe to run anywhere.
 */
function runSelfTest() {
  const fixture =
    '        finally {\n' +
    '            await sendMessageAck(node);\n' +
    '        }\n' +
    '    };\n' +
    '    const handleNotification = async (node) => {\n' +
    '        const remoteJid = node.attrs.from;\n' +
    '    };\n' +
    '    const makeOfflineNodeProcessor = () => {\n' +
    '        const nodeProcessorMap = new Map([\n' +
    "            ['message', handleMessage],\n" +
    "            ['notification', handleNotification]\n" +
    '        ]);\n' +
    '    };\n' +
    "    ws.on('CB:notification', async (node) => {\n" +
    "        await processNode('notification', node, 'handling notification', handleNotification);\n" +
    '    });\n';

  const apply = patchSource(fixture);
  const second = patchSource(apply.src);
  const unknown = patchSource('const x = 1;\n');

  const checks = [
    ['aplica', apply.changed === true],
    ['define handleStatus', apply.src.includes('const handleStatus = async (node) => {')],
    ['registra map', apply.src.includes("['status', handleStatus]")],
    ['registra CB:status', apply.src.includes("ws.on('CB:status'")],
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
      console.warn(
        `[patch-baileys] pattern not found (baileys changed?): ${rel} missing=[${result.missing.join(', ')}]`,
      );
      stats.notFound++;
    } else if (result.changed) {
      fs.writeFileSync(file, result.src);
      console.log(`[patch-baileys] applied status ack fix: ${rel}`);
      stats.applied++;
    }
  }

  if (!stats.applied) console.log('[patch-baileys] nothing to patch');
  return stats;
}

module.exports = {
  patchSource,
  runSelfTest,
  ALREADY,
  ANCHOR_HANDLER,
  ANCHOR_MAP,
  ANCHOR_ON,
  TARGETS,
};

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
