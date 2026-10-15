import { createDecipheriv, createHmac } from 'crypto';

import { proto } from 'baileys';

const MESSAGE_EDIT_LABEL = 'Message Edit';

/**
 * Decrypts a WhatsApp message edit sealed inside a `secretEncryptedMessage` envelope
 * (secretEncType MESSAGE_EDIT), using the ORIGINAL message's `messageSecret`.
 *
 * Mirrors the reference implementation in whatsmeow (`msgsecret.go`) and the Baileys
 * PR #2690:
 * - key derived via HKDF (double HMAC-SHA256) with the "Message Edit" use-case label;
 * - unlike poll votes / event responses, message edits are sealed WITHOUT AAD.
 *
 * @returns the decrypted inner message (`proto.Message`). Throws if the key is wrong
 *          (GCM authentication failure).
 */
export function decryptMessageEdit(
  secretEnc: { encPayload: Uint8Array | Buffer; encIv: Uint8Array | Buffer },
  origMsgId: string,
  origMsgSenderJid: string,
  editorJid: string,
  msgEncKey: Buffer,
): proto.IMessage {
  const sign = Buffer.concat([
    Buffer.from(origMsgId),
    Buffer.from(origMsgSenderJid),
    Buffer.from(editorJid),
    Buffer.from(MESSAGE_EDIT_LABEL),
    Buffer.from([1]),
  ]);

  const key0 = createHmac('sha256', Buffer.alloc(32))
    .update(msgEncKey)
    .digest();
  const decKey = createHmac('sha256', key0)
    .update(sign)
    .digest();

  const ciphertext = Buffer.from(secretEnc.encPayload);
  const iv = Buffer.from(secretEnc.encIv);
  // WhatsApp GCM format: ciphertext || authTag (16 bytes)
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const enc = ciphertext.subarray(0, ciphertext.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', decKey, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return proto.Message.decode(plain);
}
