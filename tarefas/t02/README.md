# T02 — Chatwoot: resposta cita a mensagem errada (de outra conversa)

- **Status:** Concluída
- **Data:** 2026-10-12
- **Versão base:** Evolution API `2.3.7`
- **Arquivo alterado:** `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
- **Referências upstream:**
  - [evolution-foundation/evolution-api#491](https://github.com/evolution-foundation/evolution-api/issues/491) — "[PT][BUG] Mensagem errada referenciada na resposta do Chatwoot"
  - [evolution-foundation/evolution-api#2078](https://github.com/evolution-foundation/evolution-api/issues/2078) — regressão de reply/quote
  - [evolution-foundation/evolution-api#2716](https://github.com/evolution-foundation/evolution-api/pull/2716) — reentrega do mesmo `key.id`
  - [chatwoot/chatwoot — `Messages::InReplyToMessageBuilder`](https://github.com/chatwoot/chatwoot/blob/develop/app/services/messages/in_reply_to_message_builder.rb)
- **Tarefas relacionadas:** T03 (webhook timeout), T04 (`chatwootConversationId`/`chatwootInboxId` nos canais Meta/Evolution)
- **Auditoria:** [auditoria/README.md](../auditoria/README.md)

## 1. Sintoma

Ao responder uma mensagem de um cliente **pelo Chatwoot**, a mensagem chega ao WhatsApp com a citação (reply/quote) apontando para **outra mensagem, de outra conversa**.

No exemplo reportado: o agente respondeu à mensagem *"Sim"* (aparece corretamente no Chatwoot), mas o cliente recebeu no WhatsApp a resposta citando *"Fabio Glorium CD: tambem"*, de outra conversa.

## 2. Diagnóstico — o problema é da Evolution, não do Chatwoot

A evidência decisiva é que **o próprio Chatwoot registra e renderiza o reply correto** (ele mostra *"Sim"*). O Chatwoot resolve o alvo do reply **sempre dentro da conversa**:

```ruby
# chatwoot/app/services/messages/in_reply_to_message_builder.rb
def in_reply_to_message
  return conversation.messages.find_by(id: @in_reply_to) if @in_reply_to.present?
  return conversation.messages.find_by(source_id: @in_reply_to_external_id) if @in_reply_to_external_id
  nil
end
```

O que aparece errado é só a citação montada **pela Evolution** ao enviar ao WhatsApp (`quoted`), em `getQuotedMessage()`. Ou seja: o vínculo chega certo, e é a Evolution que busca a mensagem errada ao montar o quote.

### Causa raiz

`getQuotedMessage()` buscava a mensagem a citar por **`chatwootMessageId` + `instanceId`**, sem qualquer escopo de conversa e sem determinismo:

```ts
// antes
const message = await this.prismaRepository.message.findFirst({
  where: { chatwootMessageId: msg?.content_attributes?.in_reply_to, instanceId: instance.instanceId },
});
```

Problemas:

1. **Sem escopo de conversa** — `Message.chatwootMessageId` não tem constraint única (schema só tem `@@index([instanceId])`). Havendo mais de uma linha com o mesmo `chatwootMessageId`, o `findFirst` devolve uma linha arbitrária, possivelmente de outra conversa.
2. **Fonte de contaminação** — o `chatwootMessageId` é gravado por `updateChatwootMessageId()` casando apenas por `key->>'id'`; se o mesmo `key.id` do WhatsApp existir em mais de uma linha (reentregas — ver #2716), o mesmo `chatwootMessageId` é escrito em várias linhas.
3. **Identificador melhor foi ignorado** — o webhook do Chatwoot também envia `content_attributes.in_reply_to_external_id` = o `source_id` da mensagem respondida. Para mensagens criadas pela Evolution, esse `source_id` é **`WAID:<stanzaId>`** — o **id nativo do WhatsApp**, único e independente de `chatwootMessageId`. Esse caminho não era usado.

## 3. Solução implementada

### 3.1 `getQuotedMessage()` — priorizar o id nativo do WhatsApp

Passou a resolver a mensagem citada em duas etapas:

```ts
private async getQuotedMessage(msg: any, instance: InstanceDto): Promise<Quoted> {
  const attributes = msg?.content_attributes ?? {};
  const inReplyTo = attributes.in_reply_to;
  const inReplyToExternalId: string | undefined = attributes.in_reply_to_external_id;

  let target: MessageModel | null = null;

  // 1) Preferência: id nativo do WhatsApp (source_id = "WAID:<stanzaId>")
  // Filtro JSON do Prisma (agnóstico de provider), sem SQL raw.
  if (typeof inReplyToExternalId === 'string' && inReplyToExternalId.startsWith('WAID:')) {
    const waId = inReplyToExternalId.slice('WAID:'.length);
    target = await this.prismaRepository.message.findFirst({
      where: { instanceId: instance.instanceId, key: { path: ['id'], equals: waId } },
      orderBy: { messageTimestamp: 'desc' },
    });
  }

  // 2) Fallback: id interno do Chatwoot, com escopo de conversa + determinismo
  if (!target && inReplyTo) {
    const baseWhere = { chatwootMessageId: inReplyTo, instanceId: instance.instanceId };

    if (msg?.conversation?.id) {
      target = await this.prismaRepository.message.findFirst({
        where: { ...baseWhere, chatwootConversationId: msg.conversation.id },
        orderBy: { messageTimestamp: 'desc' },
      });
    }

    if (!target) {
      target = await this.prismaRepository.message.findFirst({
        where: baseWhere,
        orderBy: { messageTimestamp: 'desc' },
      });
    }
  }

  const key = target?.key as WAMessageKey;
  const messageContent = target?.message as WAMessageContent;

  return messageContent && key?.id ? { key, message: messageContent } : null;
}
```

- **Caminho 1 (forte):** resolve pelo `key.id` do WhatsApp (filtro JSON do Prisma, agnóstico de provider — evita o SQL raw `getMessageByKeyId`, que é Postgres-only). Imune à contaminação/duplicação de `chatwootMessageId`.
- **Caminho 2 (fallback):** mantém o comportamento antigo (busca por `chatwootMessageId`), agora preferindo a linha da mesma conversa e, se não achar, caindo para a busca anterior. Isso **preserva o comportamento legado** quando `chatwootConversationId` estiver nulo/incorreto.
- `orderBy: { messageTimestamp: 'desc' }` torna a seleção determinística.

### 3.2 Busca do `quotedMsg` (reply inbound) — adicionar `instanceId`

Na consulta do `quotedMsg` (fluxo WhatsApp → Chatwoot) faltava **até o escopo de instância**; foi adicionado:

```ts
quotedMsg = await this.prismaRepository.message.findFirst({
  where: {
    key: { path: ['id'], equals: quotedId },
    chatwootMessageId: { not: null },
    instanceId: instance.instanceId, // ADICIONADO
  },
});
```

## 4. Auditoria — efeitos colaterais e o que **não** foi alterado

| Item avaliado | Decisão | Motivo |
|---|---|---|
| Escopo por `chatwootConversationId` como **filtro rígido** | ❌ não usado | Nos canais **Meta** (`whatsapp.business.service.ts:690`) e **Evolution** (`evolution.channel.service.ts:196`) o campo era gravado **errado** (corrigido na **T04**); por isso entrou só como desempate com fallback. |
| Escopo por `remoteJid` | ❌ não usado | Risco de **LID**: o mesmo chat alterna entre `@lid` e `@s.whatsapp.net`; filtro rígido perderia o match. |
| Alterar `getMessageByKeyId()` para escopar por `remoteJid` | ❌ não feito | A função é compartilhada por 4 fluxos (`getReplyToIds`, `MESSAGES_DELETE`, `messages.edit`, `messages.read`). Escopar por `remoteJid` quebraria todos por LID. |
| Índice único em `(instanceId, chatwootMessageId)` | ⏳ adiado | A migração falha se já houver duplicatas; e o `updateChatwootMessageId` (casa só por `key.id`) passaria a lançar *unique violation* no envio. Fazer só após limpeza de dados e ajuste do writer. |
| Alterar `updateChatwootMessageId` | ❌ não feito agora | Escopar por `remoteJid` tem risco de LID (UPDATE acerta 0 linhas → mensagem sem `chatwootMessageId`). Fica como item futuro com validação em dados reais. |
| Canais Meta/Evolution (`chatwootConversationId` incorreto) | ✅ corrigido na **T04** | Bug independente (afeta `read`/`delete`/`edit`); a T04 alinha os canais ao Baileys. |

**Por que a mudança é segura:** `getQuotedMessage()` é usado **somente** nos dois envios de resposta do Chatwoot → WhatsApp (`:1522` e `:1518`). A alteração não toca nenhum outro fluxo, e o caminho 2 (fallback) mantém o comportamento anterior intacto.

## 5. Como validar

1. Ter duas conversas abertas no Chatwoot para a mesma instância.
2. Na conversa A, responder uma mensagem do cliente (reply) e conferir que **no WhatsApp** a citação é a mensagem correta.
3. Repetir na conversa B; garantir que a citação não "vaza" de A para B.
4. Testar também responder a uma mensagem **enviada pelo próprio agente** (aí o `source_id` pode ser nulo e o caminho 2 entra em ação).
5. Conferir nos logs que não há erro de Prisma (ex.: cast de tipo) no processamento do webhook.

Diagnóstico opcional de dados (para decidir o item adiado do índice único):

```sql
SELECT "chatwootMessageId", count(*) AS qtd,
       array_agg(id) AS mensagens, array_agg("chatwootConversationId") AS conversas
FROM "Message"
WHERE "instanceId" = '<ID_DA_INSTANCIA>' AND "chatwootMessageId" IS NOT NULL
GROUP BY "chatwootMessageId"
HAVING count(*) > 1
ORDER BY 2 DESC;
```

- **Retorna linhas:** há contaminação; o fix do writer + limpeza + índice único passam a ser necessários.
- **Não retorna:** o `chatwootMessageId` é único e o caminho 1 resolve o sintoma por si.

## 6. Riscos e trade-offs

- **Sem regressão funcional:** o fallback preserva a busca antiga; o novo caminho só é usado quando o `source_id` está no formato `WAID:`.
- **Dependência do `source_id`:** o caminho 1 depende de a mensagem respondida ter sido criada pela Evolution com `source_id = WAID:<id>`. Mensagens do agente (outgoing) podem não ter `source_id` — nesse caso o fallback assume (comportamento anterior).
- **Não resolve contaminação pré-existente de `chatwootMessageId`** quando o `source_id` está ausente; para esses casos, o item adiado (limpeza + índice único) é o complemento.

## 7. Rollback

Reverter `getQuotedMessage()` para a versão de busca única por `chatwootMessageId` + `instanceId` e remover a linha `instanceId` da consulta do `quotedMsg`.