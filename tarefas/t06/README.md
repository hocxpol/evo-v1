# T06 — Edição de mensagens (Chatwoot "Glorium.Chat" ↔ Evolution) — auditoria + plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar este plano tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Goal:** Fazer a edição de mensagens do fork `chatwoot-new` (T13) funcionar ponta a ponta com o `evolution-api`: Chatwoot→WhatsApp (propagar), WhatsApp→Chatwoot (refletir in-place), sem loops, sem regressão do comportamento atual e com o vínculo/inbox corretos.

**Architecture:** Toda a lógica fica em `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`. O branch **outbound** (em `processWebhook`) propaga a edição do agente para o WhatsApp (delegando a `waInstance.updateMessage`, que já persiste e emite evento); o branch **inbound** (em `eventWhatsapp`, evento `messages.edit`) reflete a edição do contato/celular no Chatwoot via `PATCH .../messages/:id/edit`. Guardas de eco usam o `CacheService`. A configuração da inbox (`glorium_features: ['evolution_api']`) é o pré-requisito no `initInstanceChatwoot`.

**Tech Stack:** TypeScript, Express, Prisma, Baileys 7.0.0-rc.9, `@figuro/chatwoot-sdk@1.1.17`, `CacheService` (Redis/local).

**Spec (fonte da verdade):** `2027-CW-4180/tarefas/T13/T13-Edicao-Mensagens-Historico-Glorium-Chat.md` (+ `Fases.md` Fase 5, `Auditorias.md`). Contrato do webhook: `chatwoot-new/app/listeners/webhook_listener.rb` (`previous_changes` em `message_updated`).

## Global Constraints

- **Arquivo único de mudança de código:** `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` (exceto T6, que também toca `tarefas/README.md`).
- **Não regredir T02 (reply), T03 (timeout), T04 (conversation/inbox id) e T05 (delete).** O branch de delete e o guard `message_updated && !deleted` não podem mudar de semântica.
- **Comportamento com a feature OFF deve permanecer** (a nota "Mensagem editada" é o fallback — ver T2/A2).
- **Escopo de instância sempre presente:** toda query usa `instanceId`.
- **Sem migração de schema.**
- **Padrões do repo:** 2 espaços, aspas simples, linha ≤ 120, `simple-import-sort`, logs via `Logger` (`[CW.EDIT]`).
- **Ordem:** T1 → T2 → T3 → T4 → T6. **T3 depende de T2** (o Step 1 da T3 ancora em `let editApplied = false`, introduzido na T2). **T5 é opcional e exige um pré-requisito de runtime (ver T5 Step 0).**

---

## 0. Auditoria (estado atual, revisão congelada)

- `chatwoot.service.ts` — `md5 b2521ed31fd78d744bb2aadedff9e356` (mtime `2026-10-14 20:37:45`).
- O `chatwoot-new` (fork 4.18.0) implementa: `PATCH /messages/:id/edit`, `content_attributes.edit_history/edited_at`, e `webhook_listener#message_updated` com `previous_changes: {content: [old,new]}`.
- O Evolution já contém: branch outbound (`~1351-1418`) e inbound reescrito (`~2552-2600`).

### Achados confirmados (por leitura de código)

| # | Achado | Sev. | Evidência |
|---|---|---|---|
| **A1** | Inbox do Evolution criada **sem** `glorium_features: ['evolution_api']`; nada no backend do Chatwoot seta o flag automaticamente. `edit_eligible?` exige-o → **422** em todo `PATCH /edit`. | 🔴 Bloqueante | `initInstanceChatwoot` (`~204-233`); `messages_controller.rb#edit_eligible?` (`:124`); `inboxes_controller` só permite via param (`:199`) |
| **A2** | Com a feature OFF (default), a edição no WhatsApp **não** gera mais a nota "Mensagem editada" nem edita in-place (PATCH→422) → regressão vs. comportamento anterior. | 🔴 Alta | inbound atual (`~2589-2599`) só faz PATCH; código antigo criava nota |
| **A3** | Editar no **celular** (fromMe) → inbound faz PATCH → Chatwoot emite `message_updated` (outgoing+content) → outbound **reenvia** o edit ao WhatsApp (redundante; com `signMsg` ON pode **duplicar assinatura**). | 🟠 Média | outbound (`~1351-1418`); inbound PATCH (`~2589`) |
| **A5** | Edição originada no Chatwoot **não persiste** no banco local nem emite evento. `sendMessageWithTyping` e `updateMessage` provam que o Evolution **não** conta com eco para persistir. | 🟠 Média | outbound (`~1407-1415`) sem `prismaRepository.message.update` |
| **A6** | `send.message.update` (edição via API `/chat/updateMessage`) é descartado → não reflete no Chatwoot. | 🟡 Baixa (decisão) | inbound `:2554` |

### Não-problemas (verificados — NÃO implementar)

- **Assinatura (`senderName`)** — **falso positivo**. No fork, `Message#webhook_data` faz `conversation.webhook_data.merge(messages: [webhook_push_event_data])`, então `body.conversation.messages[0]` **é a própria mensagem editada** e seu `sender` é `User#push_event_data` (que **inclui** `available_name`). Logo, `messages[0].sender.available_name` já é o agente correto. A evidência antiga citava `User#webhook_data` (método diferente, sem `available_name`). **Nenhuma mudança necessária em `:1400`.**
- **Cache de eco:** já passou a ser por **conteúdo** (`cw_edit_${body.id}` = texto, TTL 300; comparação em `:2580-2584`) — não há drop por tempo.
- **SDK `chatwootRequest`:** suporta `PATCH` e `body`; `ApiError.status` existe (base do fallback da T2).
- **`createJid(key.remoteJid)`** retorna o `remoteJid` verbatim para `@s.whatsapp.net`/`@g.us`/`@lid` → o check `oldMessage.key.remoteJid !== jid` do `updateMessage` casa (viabiliza a T4).
- **T11 (agendamento)** e **T12 (grupos):** sem ação no Evolution.

---

## File Structure

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | Integração Chatwoot↔WhatsApp (outbound + fallback + loop) | T1–T5 |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | Recebimento WhatsApp→Chatwoot (trigger de edição) | F1, F3 (ver §7) |
| `tarefas/README.md` | Índice das tarefas do fork | T6 |

Nenhum arquivo novo de código. Sem migração.

---

## 7. Correção adicional — trigger de edição inbound (F1/F3) — CAUSA RAIZ do "não refletiu"

**Sintoma:** cliente edita no WhatsApp **ou** o atendente edita no próprio celular → **o Chatwoot não reflete**.

**Causa raiz (confirmada na fonte):** `baileys@7.0.0-rc.9` entrega edições por **`messages.update`** (`src/Utils/process-message.ts`, caso `MESSAGE_EDIT`), **não** por `messages.upsert`. O gancho que chama o Chatwoot estava no `messages.upsert` do `whatsapp.baileys.service.ts` (`:1122`) → **código morto** para edições. Resultado: o Chatwoot nunca era chamado; e `MESSAGES_EDITED` / persistência local também não aconteciam.

**Correção aplicada (`whatsapp.baileys.service.ts`):**

- **F1** — no handler `messages.update`, após `if (update.message) { message.message = update.message; }` e **antes** do `$queryRaw`, detectar `update.message?.editedMessage?.message` e chamar:
  ```ts
  this.chatwootService.eventWhatsapp(
    'messages.edit',
    { instanceName: this.instance.name, instanceId: this.instanceId },
    { key, editedMessage: editedNewMessage }, // normaliza p/ shape que o Chatwoot já lê
  );
  ```
  seguido de `persistIncomingEdit(...)` e `sendDataWebhook(Events.MESSAGES_EDITED, { key, editedMessage })`, e **`continue`** (pula o caminho de status/SQL raw).
- **F3** — helper `persistIncomingEdit` (Prisma, provider‑agnóstico): acha por `key.id`, grava `message`/`status='EDITED'`/`messageTimestamp` e cria `MessageUpdate`.
- **F4** — bloco legado do `messages.upsert` mantido (compat), marcado por comentário (não remover).
- **F5** — dívida registrada: `$queryRaw` Postgres-only no `messages.update` quebra MySQL para status/delete (edição já está imune por causa do `continue`).
- **F2** (opcional) — extrator do `chatwoot.service.ts` aceita também o shape cru v7 (`body.editedMessage.message.*`).

**Correções pós-implementação desta fase:** `MessageUpdate.fromMe` é obrigatório no schema → garantido com `?? false`; `remoteJid` validado antes do `create`.

**Não mudou:** `chatwoot-new` (endpoint `/edit` e webhook já existem).

---

## Task 1: Configurar a inbox do Evolution com `evolution_api` (A1)

**Files:**
- Modify: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts:204-233` (`initInstanceChatwoot`)

**Interfaces:**
- Consumes: `client.inboxes.create/update` (`@figuro/chatwoot-sdk`), `this.provider.accountId`.
- Produces: inbox do Evolution com `glorium_features` contendo `'evolution_api'` (pré-requisito de `edit_eligible?`).

- [ ] **Step 1: Constante do flag**

Adicionar logo abaixo de `private readonly LOCK_POLLING_DELAY_MS = 300;`:

```ts
  // Per-inbox feature flag required by the Chatwoot "Glorium.Chat" fork so that
  // message edits are accepted for this (Evolution) inbox. See T06/A1.
  private readonly EVOLUTION_INBOX_FEATURE = 'evolution_api';
```

- [ ] **Step 2: Incluir o flag na criação e no reaproveitamento**

Substituir o bloco `if (!checkDuplicate) { ... } else { ... }` por:

```ts
    if (!checkDuplicate) {
      const data = {
        type: 'api',
        webhook_url: webhookUrl,
      };

      const inbox = await client.inboxes.create({
        accountId: this.provider.accountId,
        data: {
          name: inboxName,
          channel: data as any,
          glorium_features: [this.EVOLUTION_INBOX_FEATURE],
        } as any,
      });

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;
    } else {
      const inbox: any = findInbox.payload.find((inbox) => inbox.name === inboxName);

      if (!inbox) {
        this.logger.warn('inbox not found');
        return null;
      }

      inboxId = inbox.id;

      // Existing inboxes may predate this change — ensure the flag without dropping others.
      const currentFeatures: string[] = Array.isArray(inbox.glorium_features) ? inbox.glorium_features : [];
      if (!currentFeatures.includes(this.EVOLUTION_INBOX_FEATURE)) {
        try {
          await client.inboxes.update({
            accountId: this.provider.accountId,
            id: inboxId,
            data: { glorium_features: [...currentFeatures, this.EVOLUTION_INBOX_FEATURE] } as any,
          });
          this.logger.log(`Inbox ${inboxId} updated with '${this.EVOLUTION_INBOX_FEATURE}'`);
        } catch (error) {
          this.logger.warn(`Could not set '${this.EVOLUTION_INBOX_FEATURE}' on inbox ${inboxId}: ${error}`);
        }
      }
    }
```

- [ ] **Step 3: Compilar**

Run: `npm install && npm run build`
Expected: PASSA.

- [ ] **Step 4: Backfill operacional (inboxes já existentes) — OBRIGATÓRIO**

> `initInstanceChatwoot` só roda em `create()` com `autoCreate` (`chatwoot.service.ts:124-142`). Instâncias já configuradas **não** passam por lá de novo. Para cada inbox já existente, escolher **um**:
> - Reexecutar `POST /chatwoot` da instância com `autoCreate: true`; **ou**
> - Habilitar a flag na UI do Glorium.Chat → Caixas de Entrada.

- [ ] **Step 5: Verificar em runtime (Chatwoot)**

Run (SQL no banco do Chatwoot):
```sql
SELECT id, name, glorium_features FROM inboxes WHERE name = '<nome_da_inbox>';
```
Expected: `glorium_features` contém `evolution_api`.

- [ ] **Step 6: Commit**

```bash
git add src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts
git commit -m "fix(chatwoot): flag evolution_api na inbox criada pelo Evolution (T06/A1)"
```

---

## Task 2: Fallback "Mensagem editada" quando o PATCH não se aplica (A2)

**Files:**
- Modify: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts:2552-2600` (branch inbound `messages.edit`)

**Interfaces:**
- Consumes: `chatwootRequest`, `getClientCwConfig`, `createMessage`, `i18next`.
- Produces: em erro **422/403** do PATCH, cria a nota antiga; em **qualquer outro** erro, apenas loga (não cria nota).

- [ ] **Step 1: PATCH com fallback gated por status**

Substituir o bloco `try { await chatwootRequest(...) } catch (error) {...}` por:

```ts
        let editApplied = false;
        let editFallbackNeeded = false;
        try {
          await chatwootRequest(this.getClientCwConfig(), {
            method: 'PATCH',
            url: `/api/v1/accounts/${this.provider.accountId}/conversations/${message.chatwootConversationId}/messages/${message.chatwootMessageId}/edit`,
            body: { content: editedMessageContent },
          });
          editApplied = true;
        } catch (error) {
          const status = (error as any)?.status ?? (error as any)?.response?.status;
          // 422: feature `message_edit` OFF / inbox sem `evolution_api` / mensagem ineligível.
          // 403: inbox não-API. Só nesses casos caímos no comportamento antigo (nota).
          // Outros (5xx/timeout) são transitórios: apenas logam, sem nota (evita duplicar T2/A2).
          if (status === 422 || status === 403) {
            editFallbackNeeded = true;
            this.logger.warn(`[CW.EDIT] Edição in-place indisponível (status ${status}); usando nota 'Mensagem editada'.`);
          } else {
            this.logger.error(`[CW.EDIT] Falha ao atualizar a mensagem no Chatwoot. status=${status} error=${error}`);
          }
        }

        if (!editApplied && editFallbackNeeded) {
          const key = message.key as WAMessageKey;
          const messageType = key?.fromMe ? 'outgoing' : 'incoming';
          const editedText = `\n\n\`${i18next.t('cw.message.edited')}:\`\n\n${editedMessageContent}`;
          await this.createMessage(
            instance,
            message.chatwootConversationId,
            editedText,
            messageType,
            false,
            [],
            { message: { extendedTextMessage: { contextInfo: { stanzaId: key.id } } } },
            'WAID:' + key.id,
            null,
          );
        }

        return;
```

- [ ] **Step 2: Compilar**

Run: `npm run build`
Expected: PASSA.

- [ ] **Step 3: Verificar em runtime — feature OFF (regressão A2)**

Pré-condição: `message_edit` OFF. Editar no WhatsApp.
Expected: nota `` `Mensagem editada:` `` no Chatwoot; log `[CW.EDIT] Edição in-place indisponível (status 422)`.

- [ ] **Step 4: Verificar em runtime — feature ON**

Pré-condição: `message_edit` ON + inbox com `evolution_api`. Editar no WhatsApp.
Expected: mensagem **original** atualizada in-place; **sem** nota.

- [ ] **Step 5: Verificar em runtime — erro transitório (sem nota)**

Simular um 5xx do Chatwoot no `/edit` (ex.: proxy/erro forçado).
Expected: **nenhuma** nota; apenas `[CW.EDIT] Falha ao atualizar...`. (Locka a semântica do fallback.)

- [ ] **Step 6: Commit**

```bash
git add src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts
git commit -m "fix(chatwoot): fallback para nota 'Mensagem editada' apenas em 422/403 (T06/A2)"
```

---

## Task 3: Suprimir o reenvio da reflexão (A3)

**Files:**
- Modify: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` — inbound (antes do PATCH da T2) e outbound (`~1351-1418`)

**Interfaces:**
- Consumes: `this.cache`, `body.previous_changes.content` (`[old,new]`).
- Produces: marca `cw_edit_reflect_<chatwootMessageId>` = conteúdo refletido (TTL 60 s); outbound ignora o `message_updated` cujo **novo conteúdo** é exatamente essa marca. **Não altera `senderName` (A4 é falso positivo).**

- [ ] **Step 1: Marcar o conteúdo refletido no inbound (antes do `let editApplied = false;` da T2)**

Inserir imediatamente antes:

```ts
        // Mark the exact content we are about to write into Chatwoot. When this
        // produces a `message_updated` webhook, the outbound branch recognises it as
        // our own reflection and avoids re-sending the edit to WhatsApp (T06/A3).
        await this.cache.set(`cw_edit_reflect_${message.chatwootMessageId}`, editedMessageContent, 60);
```

- [ ] **Step 2: Atalho no topo do branch outbound**

Logo após o guard `if (!waInstance || !instance.instanceId) { ... }` do branch outbound, inserir:

```ts
        // Skip message_updated events that are the reflection of a WhatsApp edit we
        // just wrote into Chatwoot (inbound branch) — avoids a redundant WhatsApp edit
        // and a duplicated signature (T06/A3).
        const reflectedContent = (body.previous_changes?.content as string[] | undefined)?.[1];
        const pendingReflection = await this.cache.get(`cw_edit_reflect_${body.id}`);
        if (pendingReflection && pendingReflection === reflectedContent) {
          await this.cache.delete(`cw_edit_reflect_${body.id}`);
          return { message: 'bot' };
        }
```

- [ ] **Step 3: Compilar**

Run: `npm run build`
Expected: PASSA.

- [ ] **Step 4: Verificar em runtime — edição pelo celular (A3)**

Com `signMsg` ON, editar no celular uma mensagem enviada pela Evolution.
Expected: mensagem **original** atualizada no Chatwoot **sem** nota; **não** chega edição-espelho ao WhatsApp; assinatura não duplica.

- [ ] **Step 5: Commit**

```bash
git add src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts
git commit -m "fix(chatwoot): evita reenvio da edicao refletida (T06/A3)"
```

---

## Task 4: Persistir a edição originada no Chatwoot (A5)

**Files:**
- Modify: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts:1407-1415` (bloco de envio do outbound)

**Interfaces:**
- Consumes: `waInstance.client.sendMessage` (envio da edição) + `persistOutboundEdit` (helper privado, Prisma).
- Produces: DB local atualizado (`Message.status = 'EDITED'` + `MessageUpdate`), sem depender de SQL raw Postgres-only.

> **Correção da auditoria (P3):** delegar a `waInstance.updateMessage(...)` foi **rejeit** porque ele usa `getMessage()`, que é **SQL raw Postgres-only** (`"key"->>'id'`) — em MySQL cai no `catch` → `formatUpdateMessage` retorna `null` → `'Message not compatible'` → a edição **não é enviada**. A solução final envia via `client.sendMessage` e persiste via **Prisma** (agnóstico de provider), espelhando a persistência do `updateMessage`.

- [ ] **Step 1: Enviar via `client.sendMessage` e persistir via Prisma**

Substituir o bloco `try { ... } catch (error) { ... }` (`~1467-1476`) por:

```ts
        try {
          // Keep the "echo by content" marker (cw_edit_<body.id>) used by the inbound guard.
          await this.cache.set(`cw_edit_${body.id}`, formatText, 300);
          this.setEditMarker(`self:${instance.instanceId}:${body.id}`, formatText, 300000);
          await waInstance.client.sendMessage(key.remoteJid, { text: formatText, edit: key } as any);
          // Persist the edit locally via Prisma (provider-agnostic). Delegating to
          // `updateMessage` was rejected because it depends on `getMessage()`
          // (Postgres-only raw SQL), which broke edits on MySQL (T06/A5).
          await this.persistOutboundEdit(instance.instanceId, editedMessage, formatText);
        } catch (error) {
          this.logger.error(`[CW.EDIT] Falha ao editar mensagem no WhatsApp. keyId=${key?.id} error=${error}`);
        }
```

E adicionar o helper (perto de `getMessageByKeyId`):

```ts
  private async persistOutboundEdit(instanceId: string | undefined, storedMessage: MessageModel, text: string) {
    const saveData = this.configService.get<Database>('DATABASE').SAVE_DATA;
    if (!instanceId || !saveData.NEW_MESSAGE || !storedMessage?.id) return;

    const key = storedMessage.key as WAMessageKey;
    const message: any = (storedMessage.message as any) ?? {};
    const messageType = (storedMessage as any).messageType;

    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      message.conversation = text;
    } else if (message[messageType]) {
      message[messageType].caption = text;
    } else {
      message.conversation = text;
    }

    await this.prismaRepository.message.update({
      where: { id: storedMessage.id, instanceId },
      data: { message, status: 'EDITED', messageTimestamp: Math.floor(Date.now() / 1000) },
    });

    if (saveData.MESSAGE_UPDATE) {
      await this.prismaRepository.messageUpdate.create({
        data: {
          messageId: storedMessage.id,
          keyId: key.id,
          remoteJid: key.remoteJid,
          fromMe: key.fromMe,
          participant: key.participant,
          status: 'EDITED',
          instanceId,
        },
      });
    }
  }
```

- [ ] **Step 2: Compilar**

Run: `npm run build`
Expected: PASSA.

- [ ] **Step 3: Verificar em runtime — persistência local (A5)**

Editar no Chatwoot uma mensagem enviada pelo agente. Depois:
```sql
SELECT key->>'id' AS key_id, status,
       message->>'conversation' AS conv_text,
       message->'extendedTextMessage'->>'text' AS ext_text
FROM "Message" WHERE "instanceId" = '<ID>' ORDER BY "messageTimestamp" DESC LIMIT 3;
```
Expected: a linha editada com `status = 'EDITED'` e o **novo** conteúdo (em `conv_text` **ou** `ext_text`); log sem erro.

- [ ] **Step 4: Verificar webhook externo (opcional)**

Com webhook do Evolution configurado para `SEND_MESSAGE_UPDATE`, editar no Chatwoot.
Expected: chega `send.message.update`. Se não usar, apenas confirmar ausência de erro.

- [ ] **Step 5: Commit**

```bash
git add src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts
git commit -m "fix(chatwoot): persiste edicao originada no Chatwoot via updateMessage (T06/A5)"
```

---

## Task 5 (aplicado): Refletir `send.message.update` no Chatwoot (A6)

> **Status: aplicado** com guard defensivo (`!body?.key?.id`). O pré-requisito de runtime (Step 0) deve ser confirmado em homologação: verificar que o `protocolMessage` de `send.message.update` traz `body.key.id`. O loop de eco é evitado pela marca `self:` (T4) quando o evento é o nosso próprio edit.

**Files:**
- Modify: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts:2552-2554` (inbound)

**Interfaces:**
- Consumes: `body` = `protocolMessage` (`body.key`, `body.editedMessage.*`).
- Produces: PATCH in-place também para `send.message.update`.

- [ ] **Step 0: Pré-requisito de runtime — confirmar que o `protocolMessage` tem `key.id`**

Verificar em log/runtime que o payload de `send.message.update` (`whatsapp.baileys.service.ts:4182-4194`) traz `body.key.id` e `body.key.remoteJid`. **Se não trouxer, não habilitar T5** (o `getMessageByKeyId(instance, undefined)` degrada e o guard de `ignoreJids` pode lançar). Adicionar guard defensivo (abaixo) resolve o `undefined`, mas não o propósito.

- [ ] **Step 1: Guard defensivo + remover o descarte incondicional**

Substituir:

```ts
      if (event === 'messages.edit' || event === 'send.message.update') {
        // Echo of our own programmatic edit (outbound branch) → drop by event name.
        if (event === 'send.message.update') return;
```

por:

```ts
      if (event === 'messages.edit' || event === 'send.message.update') {
        // `send.message.update` carries the same `protocolMessage` shape as
        // `messages.edit`; both reflect a real edit and are handled the same.
        if (!body?.key?.id) {
          this.logger.warn('[CW.EDIT] event sem key.id — ignorando.');
          return;
        }
```

- [ ] **Step 2: Compilar**

Run: `npm run build`
Expected: PASSA.

- [ ] **Step 3: Verificar em runtime**

`POST /chat/updateMessage` numa mensagem de instância com Chatwoot.
Expected: original atualizada in-place no Chatwoot; sem loop; sem nota.

- [ ] **Step 4: Commit**

```bash
git add src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts
git commit -m "feat(chatwoot): reflete edicao da API updateMessage no Chatwoot (T06/A6)"
```

---

## Task 6: Validação final, regressões e documentação

**Files:**
- Modify: `tarefas/README.md` (índice)

**Interfaces:**
- Consumes: nada.
- Produces: índice do repo atualizado; evidências de regressão.

- [ ] **Step 1: Lint e build**

Run: `npm install && npm run lint:check && npm run build`
Expected: sem erros novos.

- [ ] **Step 2: Regressões T02/T03/T05 + loops (checklist manual)**

1. **T02 (reply):** responder com quote no Chatwoot → citação correta no WhatsApp.
2. **T03 (timeout):** enviar pelo Chatwoot → sem mensagem vermelha.
3. **T05 (delete):** apagar no Chatwoot → revoga no WhatsApp; sem `[CW.DELETE] Mensagem não encontrada`.
4. **Echo/loop:** editar 2x seguidas no Chatwoot → sem duplicidade nem loop; editar no WhatsApp → reflete in-place.
5. **Meta/Evolution:** editar no Chatwoot nesses canais → apenas log de "Method not available" (comportamento igual ao anterior).

Expected: todos OK.

- [ ] **Step 3: Atualizar o índice**

Em `tarefas/README.md`, adicionar ao "Índice de tarefas":

```markdown
| **T06** | Chatwoot: edição de mensagens (Glorium.Chat T13) não funciona ponta a ponta | Em andamento | [t06/README.md](./t06/README.md) |
```

- [ ] **Step 4: Commit**

```bash
git add tarefas/README.md
git commit -m "docs(chatwoot): registra T06 (edicao de mensagens) no indice de tarefas"
```

---

## Riscos, decisões e rollback

| Item | Risco | Mitigação / decisão |
|---|---|---|
| T1 | `inboxes.update` substituir `glorium_features` | Enviar array mesclado (`[...current, evolution_api]`) |
| T1 | Inboxes já existentes não passam por `initInstanceChatwoot` | Backfill operacional obrigatório (T1 Step 4) |
| T2 | Fallback criar nota em erro transitório | Gate em 422/403 (`editFallbackNeeded`); 5xx só loga |
| T3 | Cache desabilitado (`CACHE` sem Redis/local) → supressão inócua | **Corrigido**: fallback em memória (`editMarkers`) cobre o fluxo same-process; cache Redis cobre multi-process |
| T3 | Falsa supressão de edição legítima idêntica | TTL + igualdade exata; risco mínimo |
| T4 | Meta/Evolution: `updateMessage` lança | Comportamento igual ao anterior (falha era esperada); apenas loga |
| T4 | `updateMessage` só persiste se o `protocolMessage` vier no resultado do send | Mesmo comportamento da API `/chat/updateMessage` (já em produção) |
| T5 | `send.message.update` sem `key.id` | Gate no Step 0 + guard defensivo no Step 1 |
| Todos | Arquivo alterado por terceiros durante a implementação | "Congelar" a revisão (`md5` acima) antes de começar |

**Nota:** o check de 15 minutos dentro de `updateMessage` é código morto (`messageTimestamp` em segundos vs `Date.now()+900000` em ms) — **não** conta como proteção. A janela real é a do Chatwoot.

**Rollback:** reverter os commits (cada um atômico). Sem migração nem mudança de schema.

## Ajustes pós-implementação (auditoria crítica → correções)

Após implementar T1–T5, uma auditoria crítica do código aplicado encontrou 2 defeitos reais, já corrigidos:

| # | Defeito | Correção aplicada |
|---|---|---|
| **P1** | O fork retorna **422 `Content is unchanged`** quando o conteúdo é igual; o fallback tratava **todo** 422 como "in-place indisponível" → criava nota "Mensagem editada" espúria em no-ops. | No `catch`, 422 com `body.error === 'Content is unchanged'` é **no-op** (sem nota); o fallback só ocorre para 422 de elegibilidade/feature e 403. |
| **P2** | Com `CACHE` **desabilitado**, a supressão de eco/reflexão era inócua: o self-event `send.message.update` reentrava e fazia PATCH com o texto normalizado (corrupção de markdown + nota). | Fallback **em memória** (`editMarkers`, por `${instanceId}:${chatwootMessageId}`) usado além do cache para os guardas `self:` (eco) e `reflect:` (reflexão). Robusto para cache desabilitado e para TTL vencido em single-process; o Redis cobre multi-process. |
| **P3** | **Regressão em MySQL:** a T4 delegava a `waInstance.updateMessage`, que usa `getMessage()` — **SQL raw Postgres-only**. Em MySQL lançava e a edição **não era enviada**. | T4 passou a usar `client.sendMessage` + `persistOutboundEdit` (Prisma, provider-agnóstico). Sem SQL raw. |

Advisories registrados (não bloqueantes): `source_id` do fallback reutiliza `WAID:<keyId>` (pré-existente); edição de grupo perde o prefixo `**telefone - nome:**`.

## Ajustes pós-implementação (2ª rodada — P1 inbound)

Depois do commit `55a58131` (dedup upsert+update, fallback WAID, logs), a auditoria encontrou 3 defeitos reais na edição inbound, corrigidos:

| # | Defeito | Correção aplicada |
|---|---|---|
| **P4** | **Fallback WAID era código morto.** `resolveChatwootMessageByWaId` retornava cedo `if (!knownConversationId)`, mas era chamado justamente quando `chatwootConversationId` era `null` → nunca resolvia nada. | Novo `getChatwootConversationIdByRemoteJid` recupera a conversa de uma mensagem-irmã do mesmo chat (que já tenha o vínculo); só então o WAID busca o `messageId` por `source_id`. |
| **P5** | Logs decisivos em `logger.verbose` — invisíveis no nível padrão → impossível diagnosticar "não reflete". | `logger.info` nos marcos (`edit (upsert/update)`, `inbound`, `resolved`, `PATCH ok`); `warn` permanece no `vínculo ausente`. |
| **P6** | `eventWhatsapp('messages.edit', …)` chamado **sem `await` e sem `.catch`** → rejeição não tratada e silenciosa. | `void … .catch((error) => logger.error('[CW.EDIT] falha ao encaminhar edição'))`. |

**Diagnóstico em 1 linha:** no nível `info`, procure `[CW.EDIT] edit (messages.update|messages.upsert) keyId=…` → `[CW.EDIT] inbound …` → `[CW.EDIT] resolved …` → `[CW.EDIT] PATCH ok`. Se parar em `vínculo ausente`, o problema é o vínculo/`source_id`; se não houver nenhum `[CW.EDIT] edit …`, o evento não está chegando (Baileys/instância).

**Validação:** parse TypeScript (TS 5.7) sem erros de sintaxe nos 2 arquivos; espelhado em `2027-Evo-v2/evo-v1` (byte a byte). Sem `node_modules` → `tsup`/`tsc --noEmit` completo e `eslint` pendentes; sem mudança de schema.


## 8. Edição de mensagem cifrada (`secretEncryptedMessage`) — CAUSA RAIZ do inbound

**Sintoma:** editar no WhatsApp (cliente ou celular) **não** reflete no Chatwoot; editar **no Chatwoot funciona**.

**Causa raiz (confirmada):** o WhatsApp passou a enviar a edição **cifrada** em `secretEncryptedMessage` (`secretEncType: 2` = MESSAGE_EDIT), com `targetMessageKey` apontando a original. O texto novo é cifrado com o `messageContextInfo.messageSecret` da mensagem original. A **Baileys 7.0.0-rc.9 não decifra** isso (não há `unwrapSecretEncryptedMessage`) → nenhum evento de edição útil é emitido nem persistido. Referências: issue `evolution-foundation/evolution-api#2545` e Baileys PR `#2690` (commit `306dd16`).

**Correção aplicada (no Evolution, sem trocar a dependência):**

| Arquivo | Mudança |
|---|---|
| `src/utils/secretEdit.ts` (novo) | `decryptMessageEdit()` — HKDF (HMAC-SHA256 duplo, label `"Message Edit"`), AES-256-GCM **sem AAD**; espelha whatsmeow/PR #2690 |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | `unwrapSecretEdit(received)`: detecta o envelope, pega o `messageSecret` da original (Prisma), tenta LID/PN e reescreve `received.message` para o shape `protocolMessage` MESSAGE_EDIT **antes** do pipeline de edição; chamado no topo do loop de `messages.upsert` |
| `test/all.test.ts` | teste automatizado: round-trip, rejeição de chave errada (GCM), fallback LID/PN |

**Por que no Evolution (e não via patch da Baileys):** o pacote npm `baileys` é **compilado** (`lib/`), então `patch-package` exigiria patchear JS gerado (frágil); e o fork do PR é `master` + patch (**125 commits**). A decifração local é auto-contida, testável e não altera a versão.

**Validação:** `npm test` roda o teste (tsx); em runtime, o log `[CW.EDIT] secret edit decifrado` confirma a decifração, seguido do fluxo normal (`[CW.EDIT] inbound → resolved → PATCH ok`).

**Não mudou no Chatwoot:** o fork já tem o endpoint `/edit` e o webhook com `previous_changes`.

## 8.1. Edição do **agente (fromMe)** — causa raiz própria: `messageSecret` descartado pela Baileys

**Sintoma:** a edição do **cliente** passou a funcionar, mas a edição feita pelo **agente a partir do celular** (`fromMe: true`) continuava sem refletir.

**Causa raiz (confirmada):** bug de *decode* da Baileys (`lib/Utils/decode-wa-message.js`):

```js
msg = msg.deviceSentMessage?.message || msg;   // 7.0.0-rc.9 (e até rc14)
```

`deviceSentMessage` só existe em mensagens **que nós enviamos** (`fromMe`). Essa linha substitui a `Message` inteira pela mensagem interna e **descarta os campos irmãos do envelope** — em especial `messageContextInfo.messageSecret`. Resultado: a mensagem original enviada do celular é gravada **sem o `messageSecret`**, e sem ele a edição cifrada não pode ser decifrada (`[CW.EDIT] secret edit: messageSecret ausente`). Referência: Baileys issue `#2541` (comentário de `binjamil`) e PR `#2566` (ainda **não mergeado** em `7.0.0-rc14`).

**Correção aplicada (patch do `lib/` compilado, via `postinstall`):**

| Arquivo | Mudança |
|---|---|
| `scripts/patch-baileys-message-secret.js` (novo) | Aplica o merge do PR `#2566` (`{ ...outer, ...inner }`) preservando o `messageContextInfo` externo. Idempotente e *fail-soft* (não quebra o install se o padrão mudar) |
| `package.json` | `"postinstall": "node scripts/patch-baileys-message-secret.js"` |
| `Dockerfile` / `Dockerfile.metrics` | `COPY ./scripts` antes do `npm ci` / do build, para o patch rodar |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | `unwrapSecretEdit`: além de LID/PN, tenta o **par origem × editor** (cartesian product), cobrindo o *“orig sender hack”* do whatsmeow quando o envelope e a original usam formas de JID diferentes |
| `test/all.test.ts` | testes do transform do patch (correto + idempotente + fonte desconhecida intacta) |

**Por que agora por patch (e não só no Evolution):** o `messageContextInfo` externo é **inalcançável** no handler do Evolution (a Baileys já o descartou na decodificação). Só o patch no ponto de decode restaura o segredo. O patch é de uma linha, coberto por teste, e o `postinstall` o mantém após qualquer `npm install`/`npm ci`.

**Observação:** mensagens enviadas do celular **antes** do patch/restart não têm o `messageSecret` gravado e não poderão ser editadas retroativamente; mensagens novas funcionam. O lado Chatwoot foi conferido e está correto: `edit_eligible?` libera chamadas por *integration token* (`api_access_token`, que o Evolution envia) e o vínculo `chatwootMessageId` existe para mensagens `fromMe`.

## Pendências fora de escopo

- Sincronizar a documentação do `chatwoot-new` (o T13 diz "planejado", mas está implementado).
- Tratamento especial para grupos (o prefixo `**telefone - nome:**` se perde na edição in-place).
- Relatórios/métricas.

## Self-review (cobertura do spec T13)

- "Agente edita ≤15 min → Chatwoot + WhatsApp": T1, T4 (+ gate no Chatwoot).
- "Contato edita → original atualizada in-place": T1, T2, T3.
- "Celular edita → in-place, eco descartado": T3.
- "Sem loop / sem `Mensagem editada:` duplicada": T3 (+ guard existente).
- "Feature OFF = comportamento idêntico": T2 (nota preservada em 422/403).
- "Delete/reply intactos": T6 (checklist) + guards inalterados.
