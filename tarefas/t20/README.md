# T20 — Chats: normalização de `remoteJid`/`@lid` na sincronização de histórico

- **Status:** Planejada
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` (changelog: *"WhatsApp chats: `accountLid` handling, `remoteJid` normalisation and `chatsRaw` mapping cleaned up"*)
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
- **Simplicidade:** 🟠 **média** (refactor) · **Risco:** 🟠 **médio** — **requer estudo antes de codar**
- **Ordem:** **5º de 5** (última da segunda onda)

## 1. Sintoma / objetivo

No `messaging-history.set`, chats cujo JID é `@lid` (ou cujo `accountLid` é `@lid`) podem ser persistidos/emitidos com o **JID errado** (LID em vez do `@s.whatsapp.net`), gerando contato/conversa "duplicados" ou mensagens na conversa errada.

## 2. Causa raiz

O nosso `chatsRaw` usa `chat.id` **cru**, sem resolver LID→PN:

```ts
// messaging-history.set (~:1195)
const chatsRaw: { remoteJid: string; instanceId: string; name?: string }[] = [];
...
for (const chat of chats) {
  if (chatsRepository?.has(chat.id)) continue;
  chatsRaw.push({ remoteJid: chat.id, instanceId: this.instanceId, name: chat.name });
}
```

## 3. Solução implementada (referência upstream — **estudar**)

O upstream 2.4.0:
1. Monta um mapa **lid → jid PN** a partir dos `contacts` (`contactsMapLidJid`);
2. Resolve por chat: `remoteJid` (PN) + `remoteLid`;
3. `chatsRaw` passa a ter `{ remoteJid, remoteLid, instanceId, name? }`;
4. **Antes** do `chat.createMany`, remove o `remoteLid` (campo só de webhook, **não** existe no modelo Prisma):

```ts
// upstream ~:1098-1143 (referência)
const chatsRaw: { remoteJid: string; remoteLid: string; instanceId: string; name?: string }[] = [];
...
for (const chat of chats) {
  if (chatsRepository?.has(chat.id)) continue;
  let remoteJid = null;
  let remoteLid = null;
  if (chat.id.search('@lid') !== -1) {
    const contact = contactsMapLidJid.get(chat.id);
    remoteLid = chat.id;
    if (contact && contact.jid) remoteJid = contact.jid;
  }
  if (!remoteLid && chat.accountLid && chat.accountLid.search('@lid') !== -1) {
    remoteLid = chat.accountLid;
  }
  if (!remoteJid) remoteJid = chat.id;
  chatsRaw.push({ remoteJid, remoteLid, instanceId: this.instanceId, name: chat.name });
}

if (SAVE_DATA.HISTORIC) {
  const chatsToCreateMany = JSON.parse(JSON.stringify(chatsRaw)).map((chat) => {
    delete chat.remoteLid;
    return chat;
  });
  await this.prismaRepository.chat.createMany({ data: chatsToCreateMany, skipDuplicates: true });
}
```

**Dependências a verificar antes de aplicar:** construção de `contactsMapLidJid` no upstream (~:1080-1098) e de onde vem `contact.jid` (o `contact.id` do histórico traz o alt-jid). **Sem migração** — `remoteLid` é descartado antes do `createMany` (confirmado: `Chat` não tem coluna `remoteLid`).

## 4. Auditoria — cuidados

| Ponto | Avaliação |
|---|---|
| Modelo Prisma | `Chat` **não** tem `remoteLid` → **obrigatório** remover antes do `createMany` |
| Webhook `CHATS_SET` | Passa a incluir `remoteLid` (consumidores precisam tolerar o campo novo) |
| Filtro de contatos | O upstream usa o mapa de **todos** os contatos (não só os com `notify/name`) — copiar esse comportamento |
| Risco | **Médio** — mexe no mapeamento de chats/contatos da sincronização |

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Sincronizar histórico com contatos `@lid` → conferir que chats/contatos usam o JID PN correto e **não** duplicam.
3. Evento `CHATS_SET` contém `remoteLid` quando aplicável.

## 6. Rollback

Reverter o bloco para o `chatsRaw` simples (`remoteJid: chat.id`) e o `createMany({ data: chatsRaw })`.
