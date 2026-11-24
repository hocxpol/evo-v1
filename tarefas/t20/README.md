# T20 — Chats: normalização de `remoteJid`/`@lid` na sincronização de histórico

- **Status:** Concluída
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

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

- A **lógica LID** (contacts loop + chats loop: `contactsMapLidJid`, resolução `remoteJid`/`remoteLid`, `accountLid`) é **byte a byte idêntica** ao `2.4.0-rc2` (`diff` de `:1188-1231` nosso × `:1078-1121` upstream). ✓
- O `createMany` usa `chatsToCreateMany` (com `delete chat.remoteLid`) — também igual ao upstream.
- **`tsconfig`**: único diff relevante vs upstream é `target` (`es2021` vs `es2020`); o rigor (`strict`/`strictNullChecks`) é o mesmo → as expressões `let x = null` + atribuições compilam como no upstream.

### 4.2 Escopo mínimo (deliberado)

O bloco upstream **empacota também** `historySyncChatCount` (campo de classe + reset/increment/log — contador do progresso do histórico). Isso **não** faz parte da normalização LID e **não** foi trazido.

- **Ordem alinhada ao upstream (correção C1 da auditoria):** o `createMany` (persistir) agora vem **antes** do `sendDataWebhook(CHATS_SET)` — elimina a race em que o consumidor recebia o webhook antes de o chat existir no banco.
- **`chatsRaw` não é mutado:** o `createMany` usa um clone (`chatsToCreateMany`), então o webhook continua entregando `remoteLid` normalmente.
- **Fail-fast:** se o `createMany` falhar, o `CHATS_SET` **não** é emitido (não se notifica um chat que não foi persistido) — mesmo comportamento do upstream.
- Única diferença remanescente vs upstream: a ausência do `historySyncChatCount`/log de contagem (se quiser, tratar em fase separada).

### 4.3 Eficácia confirmada na fonte (corrigido na auditoria 2026-11-24)

Checagem no Baileys rc.9 (`lib/Utils/history.js`, `processHistoryMessage`):
- Nos syncs principais (`INITIAL_BOOTSTRAP`/`RECENT`/`FULL`/`ON_DEMAND`), **para cada conversa** o Baileys empurra um contato:
  ```js
  contacts.push({ id: chat.id, name: chat.name, lid: chat.lidJid, phoneNumber: chat.pnJid })
  ```
- Ou seja, **`contact.phoneNumber` = `chat.pnJid`** (um **JID PN completo**, não número puro) e **`contact.id` = `chat.id`**.
- Logo, para um chat `@lid`: `contactsMapLidJid.get(chat.id)` **sempre** encontra o contato (mesma chave) e `remoteJid` vira o **PN real**. → **T20 é efetivo**, não inerte.
- `PUSH_NAME` não traz conversas (`chats: []`) → o loop de chats não roda nele; irrelevante.
- Fallback: se `pnJid` for nulo (PN desconhecido), `remoteJid` cai em `chat.id` — **não piora**.

### 4.4 Nota de dados (forward-looking)

A correção é **prospectiva**: linhas `Chat` antigas gravadas com `remoteJid = @lid` (antes da T20) **não são reescritas**. Num re-sync, pode ser criada a linha PN **ao lado** da antiga linha LID (não há `UPDATE` retroativo). Se quiser consistência total, fazer um **backfill**/limpeza de chats `@lid` antigos como tarefa separada (mesma natureza das notas de dados do T02/T04).

### 4.5 Higiene

- `git diff --check` limpo. `whatsapp.baileys.service.ts`: bloco de ~28 → ~72 linhas (**≈ +44/−3**).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria (sem `node_modules`) — rodar antes do deploy (é a fase de maior risco).

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Sincronizar histórico com contatos `@lid` → conferir que chats/contatos usam o JID PN correto e **não** duplicam.
3. Evento `CHATS_SET` contém `remoteLid` quando aplicável.

## 6. Rollback

Reverter o bloco para o `chatsRaw` simples (`remoteJid: chat.id`) e o `createMany({ data: chatsRaw })`.
