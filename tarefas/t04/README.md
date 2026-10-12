# T04 — Chatwoot: `chatwootConversationId`/`chatwootInboxId` gravados errados nos canais Meta e Evolution

- **Status:** Concluída
- **Data:** 2026-10-12
- **Versão base:** Evolution API `2.3.7`
- **Arquivos alterados:**
  - `src/api/integrations/channel/evolution/evolution.channel.service.ts` (:193)
  - `src/api/integrations/channel/meta/whatsapp.business.service.ts` (:687)
- **Tarefas relacionadas:** T02 (resposta citando mensagem errada), T03 (webhook timeout)
- **Auditoria:** [auditoria/README.md](../auditoria/README.md)

## 1. Sintoma

Nos canais **Evolution** e **Meta (WhatsApp Business/Cloud)**, ao receber uma mensagem da Evolution e criá-la no Chatwoot, os campos `chatwootInboxId` e `chatwootConversationId` da linha gravada em `Message` eram preenchidos com o **id da mensagem** (`chatwootSentMessage.id`), e não com o **id do inbox** e o **id da conversa**.

Resultado: as funcionalidades que dependem do id da conversa do Chatwoot ficam apontando para uma conversa inexistente/errada:

- `messages.read` → `update_last_seen` na conversa errada;
- `messages.delete` (evento `MESSAGES_DELETE`) → tenta deletar na conversa errada;
- `messages.edit` → posta a nota de edição na conversa errada;
- preferência por conversa no `getQuotedMessage` (T02) → não casa (cai no fallback).

## 2. Causa raiz

Copy/paste nos dois canais. O **Baileys** já fazia certo (`whatsapp.baileys.service.ts:1339-1340`), usando os campos do objeto retornado pela API do Chatwoot:

```ts
// Baileys (correto)
messageRaw.chatwootMessageId = chatwootSentMessage.id;
messageRaw.chatwootInboxId = chatwootSentMessage.inbox_id;
messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;
```

Já os canais Evolution e Meta usavam `.id` para os três campos:

```ts
// Evolution (evolution.channel.service.ts) e Meta (whatsapp.business.service.ts) — antes
if (chatwootSentMessage?.id) {
  messageRaw.chatwootMessageId = chatwootSentMessage.id;
  messageRaw.chatwootInboxId = chatwootSentMessage.id;          // errado
  messageRaw.chatwootConversationId = chatwootSentMessage.id;   // errado
}
```

O objeto `chatwootSentMessage` vem do mesmo `eventWhatsapp()` (função comum a todos os canais), então os campos `inbox_id` e `conversation_id` existem igualmente nesses canais.

**Nota sobre a semântica do campo.** No Chatwoot, o `conversation_id` do objeto de mensagem e o `id` da conversa no webhook correspondem ao **`display_id`** da conversa (numeração por conta), não ao id interno:

```ruby
# app/views/api/v1/models/_message.json.jbuilder
json.conversation_id message.conversation.display_id

# app/presenters/conversations/event_data_presenter.rb (usado no webhook)
id: display_id,
```

Ou seja, o valor correto a gravar é o `display_id`, e é exatamente o que o Baileys grava (`.conversation_id`). A correção alinha Meta/Evolution a esse mesmo valor — o que também casa com `updateChatwootMessageId` (que grava `body.conversation.id`, também o `display_id`) e com o fallback do `getQuotedMessage` (T02).

## 3. Solução implementada

Alinhar os dois canais ao padrão do Baileys:

```ts
if (chatwootSentMessage?.id) {
  messageRaw.chatwootMessageId = chatwootSentMessage.id;
  messageRaw.chatwootInboxId = chatwootSentMessage.inbox_id;
  messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;
}
```

## 4. Auditoria — efeitos colaterais

| Campo | Consumidores | Antes | Depois |
|---|---|---|---|
| `chatwootConversationId` | `messages.read` (:2458), `messages.delete` (:2392), `messages.edit` (:2432), fallback do `getQuotedMessage` (T02) | id inválido → operações falham silenciosamente | `display_id` correto → operações passam a funcionar e o T02 passa a casar a conversa |
| `chatwootInboxId` | apenas copiado (`:1588`, `:1643`); sem leitura funcional relevante | id inválido | id correto |

- **Risco:** baixo. Nenhum consumidor depende do valor *antigo* (que era incorreto por definição). A mudança apenas corrige o dado gravado a partir de agora.
- **Dados já existentes:** linhas antigas desses canais permanecem com o valor errado. Não há backfill nesta tarefa. Se necessário, reprocessar as conversas no Chatwoot ou rodar backfill a partir do `chatwootMessageId`/conversa.
- **Sem migração de schema:** são apenas atribuições em memória antes do `message.create`.

## 5. Como validar

1. Instância nos canais **Evolution** ou **Meta**, com Chatwoot habilitado.
2. Receber uma mensagem do cliente e conferir no banco:

```sql
SELECT "chatwootMessageId", "chatwootInboxId", "chatwootConversationId",
       "key"->>'remoteJid' AS remote_jid
FROM "Message"
WHERE "instanceId" = '<ID>' AND "chatwootMessageId" IS NOT NULL
ORDER BY "messageTimestamp" DESC
LIMIT 5;
```

`chatwootInboxId` e `chatwootConversationId` devem ser **diferentes** de `chatwootMessageId` (e iguais aos ids reais do inbox/conversa no Chatwoot).

3. Testar marcar como lida e deletar uma mensagem no WhatsApp e conferir o reflexo no Chatwoot.

## 6. Rollback

Reverter as duas linhas para `= chatwootSentMessage.id` nos dois arquivos.