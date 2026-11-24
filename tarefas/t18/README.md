# T18 — `markMessageAsRead`: filtro de JID ignora `@lid`/business

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` (changelog: *"markMessageAsRead: corrected JID filter to cover all user types (regular, business, broadcast, group)"*)
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
- **Simplicidade:** 🟢 muito alta (1 linha, drop-in) · **Risco:** 🟢 baixo
- **Ordem:** **3º de 5**

## 1. Sintoma

Ao marcar como lida uma mensagem de um contato cujo JID termina em `@lid` (perfis com telefone oculto), o **read receipt não é enviado** — no WhatsApp do contato a mensagem continua "não lida".

## 2. Causa raiz

O filtro monta as `keys` apenas para **grupo** ou **PN** (`@s.whatsapp.net`):

```ts
// markMessageAsRead (~:3919)
data.readMessages.forEach((read) => {
  if (isJidGroup(read.remoteJid) || isPnUser(read.remoteJid)) {
    keys.push({ remoteJid: read.remoteJid, fromMe: read.fromMe, id: read.id });
  }
});
```

`@lid` não é grupo nem PN → cai fora e nunca entra em `keys`.

## 3. Solução implementada

Inverter para "tudo, exceto broadcast/newsletter" (inclui `@lid`, business e demais tipos):

```diff
  data.readMessages.forEach((read) => {
-   if (isJidGroup(read.remoteJid) || isPnUser(read.remoteJid)) {
+   if (!isJidBroadcast(read.remoteJid) && !isJidNewsletter(read.remoteJid)) {
      keys.push({ remoteJid: read.remoteJid, fromMe: read.fromMe, id: read.id });
    }
  });
```

> `isJidBroadcast` e `isJidNewsletter` **já estão importados** (`whatsapp.baileys.service.ts:114` e `:116`) — sem alteração de import.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| `@lid` / business | Passam a enviar read receipt (correção) |
| `@broadcast` / `@newsletter` | Continuam **excluídos** (antes também, pois não são grupo/PN) |
| Grupos / PN | Inalterado (continuam incluídos) |
| Consumidor | Apenas a rota de marcar como lida (`readMessages`) |
| Risco | Baixo — amplia o conjunto de JIDs elegíveis |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

O bloco `markMessageAsRead` é **byte a byte idêntico** ao `2.4.0-rc2` (confirmado por `diff`). `isJidBroadcast`/`isJidNewsletter` já estavam importados (`:114`, `:116`) — sem mudança de import.

### 4.2 Não-regressão

- `@broadcast`/`@newsletter` seguem **excluídos** (antes também, pois não são grupo/PN).
- Grupo e PN continuam incluídos.
- Único consumidor: a rota de marcar como lida.

### 4.3 Higiene

- `git diff --check` limpo; `whatsapp.baileys.service.ts` com **1+/1−** para esta fase.
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Receber mensagem de um contato `@lid` e marcar como lida (`chat/markMessageAsRead`); esperado: o contato vê "lida".
3. Regressão: marcar como lida em conversa PN e em grupo continua funcionando.

## 6. Rollback

Reverter a linha para `if (isJidGroup(read.remoteJid) || isPnUser(read.remoteJid)) {`.
