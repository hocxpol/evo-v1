# T05 — Chatwoot: apagar mensagem do atendente não reflete no WhatsApp do cliente

- **Status:** Concluída
- **Data:** 2026-10-12
- **Versão base:** Evolution API `2.3.7`
- **Versões alvo:** Chatwoot `4.18.0` + Evolution API `2.3.7`
- **Arquivo alterado:** `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
- **Referências:**
  - [evolution-foundation/evolution-api#2014](https://github.com/evolution-foundation/evolution-api/issues/2014) — meta-issue Chatwoot
  - [evolution-foundation/evolution-api#302](https://github.com/EvolutionAPI/evolution-api/issues/302) — apaga a mensagem errada no WhatsApp
  - [chatwoot/chatwoot#8560](https://github.com/chatwoot/chatwoot/issues/8560) — "delete só remove no Chatwoot"
  - [chatwoot/chatwoot — `MessagesController#destroy`](https://github.com/chatwoot/chatwoot/blob/v4.18.0/app/controllers/api/v1/accounts/conversations/messages_controller.rb)
  - [chatwoot/chatwoot — `Messages::MessageBuilder`](https://github.com/chatwoot/chatwoot/blob/v4.18.0/app/builders/messages/message_builder.rb)
- **Tarefas relacionadas:** T02 (reply citando mensagem errada), T04 (`chatwootConversationId`/`chatwootInboxId` errados)

## 1. Sintoma

O agente apaga uma mensagem **que ele mesmo enviou** (Chatwoot → WhatsApp), recente. No Chatwoot a mensagem aparece como excluída, mas **no WhatsApp do cliente ela continua lá**.

## 2. Diagnóstico — a exclusão local é do Chatwoot, mas propagar é da Evolution

O Chatwoot **nunca** apaga no canal por conta própria em inbox do tipo API. Em `4.18.0`:

```ruby
# app/controllers/api/v1/accounts/conversations/messages_controller.rb
def destroy
  ActiveRecord::Base.transaction do
    message.update!(content: I18n.t('conversations.messages.deleted'), content_type: :text, content_attributes: { deleted: true })
    message.attachments.destroy_all
  end
end
```

Isso dispara `Message#after_update_commit :dispatch_update_event` → `MESSAGE_UPDATED`, e o `WebhookListener#message_updated` entrega, sem filtro de subscription, ao `webhook_url` do `Channel::Api` (o endpoint `/chatwoot/webhook/<instância>` da Evolution). O payload traz, no topo, `id` e `content_attributes: { deleted: true }`.

**Ou seja: o Chatwoot faz a parte dele.** A revogação no WhatsApp é 100% responsabilidade da Evolution, no handler de `message_updated` (linhas 1371-1392 / 1371-1427 após esta correção).

## 3. Causa raiz

O handler do 2.3.7 dependia **exclusivamente** de `chatwootMessageId`:

```ts
const message = await this.prismaRepository.message.findFirst({
  where: { chatwootMessageId: body.id, instanceId: instance.instanceId },
});
// se não achar: sai sem revogar E sem log
```

Dois problemas se somam:

1. **Vínculo frágil/ausente.** No sentido Chatwoot → WhatsApp, `chatwootMessageId` é gravado **só** por `updateChatwootMessageId()`, que usava **SQL raw Postgres-only**:

   ```ts
   $executeRaw`UPDATE "Message" SET ... WHERE "instanceId" = ${...} AND "key"->>'id' = ${key.id}`
   ```

   Em **MySQL** isso lança exceção (identificadores com aspas + operador `->>`), o `catch` do `processWebhook` engole, e o vínculo **nunca é gravado** → a deleção nunca acha a mensagem. (Upstream corrigiu essa classe de bug depois — commit `d6262ca4` —, ausente neste fork.)

2. **Sem rede de segurança.** O handler não logava e não tinha plano B. Detalhe importante: o webhook de deleção **não carrega o `key.id` do WhatsApp** quando `source_id` é `null` — e, para mensagem **outgoing**, `source_id` é `null` (o painel do Chatwoot não envia esse campo; ver `Messages::MessageBuilder#message_params`: `source_id: @params[:source_id]`). Só existe `source_id` em mensagem **incoming** ou quando o import DB do Chatwoot está configurado (`updateMessageSourceID` grava `WAID:<keyId>`).

Conclusão: o bug **não é do Chatwoot**. É da Evolution — o vínculo pode não ser gravado (provider) e, quando falta, o handler falha em silêncio.

## 4. Solução implementada

Arquivo: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`.

### 4.1 `updateChatwootMessageId()` — agnóstico de provider (fonte da verdade)

Troca do SQL raw Postgres-only pelo filtro JSON do Prisma (mesmo padrão da T02):

```ts
const result = await this.prismaRepository.message.updateMany({
  where: {
    instanceId: instance.instanceId,
    key: { path: ['id'], equals: key.id },
  },
  data: {
    chatwootMessageId: chatwootMessageIds.messageId,
    chatwootConversationId: chatwootMessageIds.conversationId,
    chatwootInboxId: chatwootMessageIds.inboxId,
    chatwootContactInboxSourceId: chatwootMessageIds.contactInboxSourceId,
    chatwootIsRead: chatwootMessageIds.isRead || false,
  },
});
```

Garante a gravação do vínculo em **Postgres e MySQL**, que é o que o handler de deleção usa.

### 4.2 Handler de deleção — resolução em camadas + log + guarda

```ts
if (body.event === 'message_updated' && body.content_attributes?.deleted) {
  // 1) PRIMÁRIO: vínculo do Chatwoot (chatwootMessageId = body.id). Cobre múltiplos anexos
  //    (várias linhas com o mesmo chatwootMessageId). Prefere a mesma conversa para não revogar
  //    a mensagem errada quando o vínculo está contaminado (T02 / issue #302).
  // 2) FALLBACK: id nativo do WhatsApp via source_id ("WAID:<stanzaId>"), quando o vínculo do
  //    Chatwoot não foi gravado (incoming / import DB).
  const waId =
    typeof body.source_id === 'string' && body.source_id.startsWith('WAID:')
      ? body.source_id.slice('WAID:'.length)
      : null;

  let candidates: MessageModel[] = [];

  const baseWhere = { chatwootMessageId: body.id, instanceId: instance.instanceId };

  if (body.conversation?.id) {
    candidates = await this.prismaRepository.message.findMany({
      where: { ...baseWhere, chatwootConversationId: body.conversation.id },
      orderBy: { messageTimestamp: 'desc' },
    });
  }

  if (candidates.length === 0) {
    candidates = await this.prismaRepository.message.findMany({
      where: baseWhere,
      orderBy: { messageTimestamp: 'desc' },
    });
  }

  if (candidates.length === 0 && waId) {
    candidates = await this.prismaRepository.message.findMany({
      where: { instanceId: instance.instanceId, key: { path: ['id'], equals: waId } },
      orderBy: { messageTimestamp: 'desc' },
    });
  }

  if (candidates.length === 0) {
    this.logger.warn(
      `[CW.DELETE] Mensagem não encontrada para revogar. chatwootMessageId=${body.id} source_id=${body.source_id ?? 'null'}`,
    );
    return { message: 'bot' };
  }

  for (const candidate of candidates) {
    const key = candidate.key as WAMessageKey;

    if (!key?.fromMe) {
      // WhatsApp não permite "apagar para todos" mensagem que não foi enviada pela instância.
      this.logger.warn(`[CW.DELETE] Mensagem incoming não pode ser revogada para o cliente. keyId=${key?.id}`);
      continue;
    }

    try {
      await waInstance?.client.sendMessage(key.remoteJid, { delete: key });

      // Remove apenas a linha revogada com sucesso; em falha, permanece para nova tentativa.
      await this.prismaRepository.message.deleteMany({
        where: { id: candidate.id, instanceId: instance.instanceId },
      });
    } catch (error) {
      this.logger.error(`[CW.DELETE] Falha ao revogar mensagem no WhatsApp. keyId=${key?.id} error=${error}`);
    }
  }

  return { message: 'bot' };
}
```

### 4.3 `getMessageByKeyId()` — portável (bônus, mesmo bug de classe)

Usada por `edit`/`read` e pela deleção reversa (WhatsApp → Chatwoot). Também era SQL raw Postgres-only; passou a usar o filtro JSON do Prisma:

```ts
return this.prismaRepository.message.findFirst({
  where: { instanceId: instance.instanceId, key: { path: ['id'], equals: keyId } },
});
```

## 5. Como validar

1. Enviar uma mensagem pelo Chatwoot (agente) para um contato e apagá-la no Chatwoot.
2. Conferir que **no WhatsApp do cliente** a mensagem virou "apagada".
3. Nos logs da Evolution, não deve haver `[CW.DELETE] Mensagem não encontrada`. Se houver, o `source_id` e o `chatwootMessageId` virão impressos para diagnóstico.
4. Conferir no banco que a linha do envio tem o vínculo gravado:

```sql
SELECT id, "chatwootMessageId", key->>'id' AS key_id, key->>'fromMe' AS from_me
FROM "Message"
WHERE "instanceId" = '<ID_DA_INSTANCIA>'
ORDER BY "messageTimestamp" DESC LIMIT 5;
```

5. Testar mensagem **incoming** (cliente) apagada no Chatwoot: deve logar `[CW.DELETE] Mensagem incoming não pode ser revogada` e **não** apagar (limitação do WhatsApp).
6. Observação: deleções iniciadas **no WhatsApp** (cliente ou agente no celular) podem logar `[CW.DELETE] Mensagem não encontrada` — é esperado, pois o fluxo `MESSAGES_DELETE` (WhatsApp → Chatwoot) já removeu a linha do banco antes do webhook `message_updated` chegar.

## 6. Riscos e trade-offs

- **Camada 1:** o filtro JSON do Prisma já é usado no fork (T02) e é suportado em Postgres e MySQL. Estritamente melhor que o SQL raw.
- **Camada 2:** o caminho WAID só dispara quando `source_id` existe (incoming / import DB). Para outgoing, continua valendo o fallback `chatwootMessageId` — por isso a camada 1 é indispensável.
- **`orderBy`** adicionado nas buscas torna a escolha determinística quando há duplicatas (mesmo racional da T02).
- **`getMessageByKeyId`:** mudança de SQL raw para Prisma mantém a semântica (`LIMIT 1` ≈ `findFirst`) e elimina o erro em MySQL.
- **Sem migração de schema.**

## 7. Rollback

Reverter as alterações em `chatwoot.service.ts`:
- `updateChatwootMessageId()` de volta para o `$executeRaw` Postgres-only;
- handler de deleção de volta para `findFirst` por `chatwootMessageId` + `sendMessage(key.remoteJid, { delete: key })` sem log/guarda/loop de anexos;
- `getMessageByKeyId()` de volta para o `$queryRaw`;
- checagem de echo em `outgoing` de volta para `body.conversation.messages[0].source_id`;
- `MESSAGE_READ` de volta para `findFirst` sem `orderBy`.

## 8. Auditoria das alterações (bugs/regressões)

Revisão dos *call sites* e do comportamento do Prisma em relação ao SQL raw original.

| # | Achado | Severidade | Status |
|---|---|---|---|
| A1 | `updateChatwootMessageId` com `instanceId` indefinido: o Prisma **omite** o filtro (atualizaria linhas de outras instâncias), enquanto o SQL raw **lançava**. | Alta (se ocorrer) | **Corrigido** (guard: retorna com warning) |
| A2 | Ramo `outgoing`: checagem de echo usava a **última** mensagem da conversa (`messages[0]`) em vez do `source_id` da própria mensagem do evento. Podia (a) descartar um envio real — e não gravar o vínculo; ou (b) na variante do PR #2048 (`messages[0].id === body.id`), **reenviar um echo** (duplicado). | Alta | **Corrigido** (usa `body.source_id` — preciso e sem corrida) |
| A3 | Bloco `MESSAGE_READ`: `findFirst` de incoming **sem `orderBy`** marcava uma mensagem arbitrária como lida (não necessariamente a última). | Média | **Corrigido** (`orderBy: messageTimestamp desc`) |
| A4 | Estado compartilhado `this.provider` no singleton `ChatwootService`: `clientCw()` sobrescreve `this.provider`; com `processWebhook` *fire-and-forget* (T03), webhooks de instâncias diferentes podem intercalar e usar `accountId` errado. | Média/Alta | **Observação** (não corrigido — exige refactor para eliminar estado compartilhado) |
| A5 | Deleção reversa (WhatsApp → Chatwoot): `deleteMany` da linha acontece **antes** do `client.messages.delete`; se o delete no Chatwoot falhar, a linha já foi removida. | Baixa | **Observação** (mantido de propósito: evita reentrada via `message_updated`) |
| A6 | `getReplyToIds()` grava `in_reply_to_external_id` sem o prefixo `WAID:` (inconsistente com o `source_id`), mas o Chatwoot resolve pelo `in_reply_to` (id interno). | Baixa | **Observação** (pré-existente, sem impacto no fluxo de deleção/T02) |
| A7 | `getMessageByKeyId()` sem `orderBy` (equivalente ao `LIMIT 1` do raw). Determinismo preservado. | Baixa | OK |
| A8 | Sem `node_modules` no ambiente: validação de sintaxe via `esbuild`; `tsc`/`lint` não executados. | Baixa | Limitação |
| A9 | Deleção de mensagem com **vários anexos**: todas compartilham o mesmo `chatwootMessageId`, mas o handler usava `findFirst` e revogava **só a primeira** no WhatsApp. | Média | **Corrigido** (`findMany` + revoga cada uma) |
| A10 | `chatwootMessageId` contaminado (ver T02) podia apontar para mensagem de **outra conversa** → revogar a mensagem errada no WhatsApp (issue upstream #302). | Alta | **Corrigido** (escopo por `chatwootConversationId`, com fallback legado) |
| A11 | Prioridade invertida na resolução (WAID antes do vínculo): com import DB, o `source_id` do Chatwoot aponta só para o **último** anexo → revogaria apenas um dos anexos. | Média | **Corrigido** (vínculo como primário; WAID virou fallback) |
| A12 | `processWebhook`: `instance.instanceId = waInstance.instanceId` lançava `TypeError` quando a instância não está em memória (inbox órfão de instância deletada / janela de restart), abortando TODO o processamento e tornando o guard `!waInstance` do ramo de envio **código morto**. | Alta | **Corrigido** (optional chaining + guards no handler de deleção e no `MESSAGE_READ`) |

### Comentários

- **A1** só se manifesta se `instance.instanceId` for *falsy* — o que não ocorre no fluxo normal (`processWebhook` seta `instance.instanceId = waInstance.instanceId` antes). Ainda assim, o guard impede um `UPDATE` em massa silencioso.
- **A2** é o achado mais relevante para o sintoma original: além de poder derrubar o envio, ele **impede a gravação do vínculo** — exatamente o que faz a deleção a partir do Chatwoot falhar. A correção usa o `source_id` da **própria mensagem do evento** (`body.source_id`, presente no `webhook_data` do Chatwoot), que é preciso e imune à corrida entre mensagens da conversa.
- **A9** deixa a deleção consistente com o envio: cada anexo virou uma mensagem no WhatsApp com o mesmo `chatwootMessageId`; agora todas são revogadas, e cada linha só é removida após o revoke correspondente ter sucesso.
- **A10** endereça o bug upstream #302 (apagar a mensagem errada): a busca por `chatwootMessageId` prefere a linha da **mesma conversa** (`body.conversation.id`), caindo para a busca sem escopo só quando não encontra (dados legados com `chatwootConversationId` nulo/incorreto). Nota: nesse fallback legado, se o vínculo estiver contaminado entre conversas, o comportamento equivale ao do código original (`findFirst` arbitrário) — não é uma regressão introduzida.
- **A11** corrige uma inversão de prioridade introduzida na 1ª versão deste fix (WAID primeiro): para múltiplos anexos com import DB, o `source_id` da mensagem do Chatwoot é o do último anexo, então revogar por `source_id` pegaria só um. O vínculo `chatwootMessageId` (que cobre todos) passou a ser o primário e o `WAID` o fallback.
- **A12** é pré-existente no upstream, mas tornou-se crítico de documentar porque o handler de deleção depende desse trecho: com a instância ausente em memória, nada era processado (nem a revogação nem a nota de erro no Chatwoot). Com o optional chaining, o guard de `!waInstance` do ramo de envio volta a funcionar como projetado.
- **A4** é pré-existente (o upstream também compartilha `this.provider`), mas o T03 o torna mais provável por não serializar o processamento. Fica registrado como pendência estrutural.
- **A5** e **A6** foram avaliados e **não** alterados para não introduzir reentrada/loop nem regressão fora do escopo.

### Pendências recomendadas (não bloqueantes)

1. Rodar `npm run lint:check && npm run build` antes do deploy.
2. Avaliar remoção do estado compartilhado `this.provider` (A4) por uma instância de cliente/provedor passada por parâmetro.
3. Avaliar `orderBy`/escopo de conversa no `quotedMsg` (linha 2119) — sem impacto conhecido hoje.
