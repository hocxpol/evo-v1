# Auditoria das correções T02 + T04 — regressões, conflitos e bugs

- **Data:** 2026-10-12
- **Versão base:** Evolution API `2.3.7`
- **Escopo auditado:**
  - **T02** — `getQuotedMessage()` (resolução da mensagem citada no envio Chatwoot → WhatsApp) e `instanceId` na busca do `quotedMsg` (reply inbound).
  - **T04** — `chatwootInboxId`/`chatwootConversationId` nos canais Meta e Evolution.
- **Arquivos envolvidos:**
  - `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
  - `src/api/integrations/channel/evolution/evolution.channel.service.ts`
  - `src/api/integrations/channel/meta/whatsapp.business.service.ts`
- **Documentos relacionados:** [T02](../t02/README.md), [T03](../t03/README.md), [T04](../t04/README.md)

## Método

Revisão de: (1) todos os call sites das funções alteradas; (2) formato/semântica dos identificadores do Chatwoot (`in_reply_to`, `in_reply_to_external_id`, `source_id`, `conversation_id`, `inbox_id`); (3) comportamento do Prisma para filtros JSON e `undefined`; (4) compatibilidade de provider (Postgres/MySQL); (5) consumidores dos campos alterados.

## Resumo

| # | Achado | Severidade | Status |
|---|---|---|---|
| A1 | Caminho primário usava **SQL raw Postgres-only** (`getMessageByKeyId`) → risco de erro em MySQL dentro do `processWebhook`, abortando o envio | Alta | **Corrigido** (trocado por filtro JSON do Prisma) |
| A2 | `instanceId` `undefined` em alguns call sites de `eventWhatsapp` | Baixa | OK (sem regressão) |
| A3 | Consistência de ids do Chatwoot (display_id vs id interno) | Média | OK (validado na fonte) |
| A4 | Formato do `source_id` (`WAID:`) | Média | OK (validado) |
| A5 | Outros consumidores de `chatwootConversationId`/`chatwootInboxId` | Média | OK |
| A6 | Type-safety com o SDK | Baixa | OK |
| A7 | Dados legados com valor incorreto | Baixa | Observação (fallback cobre) |
| A8 | Build/lint completos não executados neste ambiente | Baixa | Limitação |

## Detalhamento

### A1 — SQL raw no caminho primário (ENCONTRADO E CORRIGIDO)

A primeira versão do T02 resolvia o caminho forte via `getMessageByKeyId()`, que é **SQL raw com sintaxe Postgres** (`SELECT * FROM "Message" ... "key"->>'id'`). Em MySQL (identificadores com aspas duplas não são válidos por padrão; a coluna é `Json`) isso pode lançar exceção.

Risco concreto: `getQuotedMessage()` é chamado **dentro** do bloco protegido por `try/catch` de `processWebhook()`. Uma exceção faria o `catch` logar e retornar `{ message: 'bot' }` **sem enviar a mensagem ao WhatsApp** — regressão para usuários MySQL (antes o caminho usava apenas Prisma, sem SQL raw).

**Correção aplicada:** o caminho primário passou a usar filtro JSON do Prisma (agnóstico de provider), o mesmo padrão já usado no `quotedMsg`:

```ts
target = await this.prismaRepository.message.findFirst({
  where: { instanceId: instance.instanceId, key: { path: ['id'], equals: waId } },
  orderBy: { messageTimestamp: 'desc' },
});
```

### A2 — `instanceId` ausente/undefined (sem regressão)

Há call sites de `eventWhatsapp()` com `instanceId: this.instance.id` (Baileys :1129, :4192) e um sem `instanceId` (`channel.service.ts:66`, evento `STATUS_INSTANCE`).

- O caller sem `instanceId` **não entra** no branch `messages.upsert` onde está a busca alterada.
- Onde `instanceId` for `undefined`, o Prisma **omite o filtro** (comportamento padrão), degradando para o comportamento antigo — nunca lança.

Conclusão: o `instanceId` adicionado ao `quotedMsg` nunca piora; só melhora quando definido.

### A3 — Consistência de identificadores do Chatwoot (validado na fonte)

Confirmado no código-fonte do Chatwoot:

| Onde | Campo | Valor |
|---|---|---|
| API mensagem (`_message.json.jbuilder`) | `conversation_id` | `conversation.display_id` |
| Webhook (`Conversations::EventDataPresenter#push_data`) | `conversation.id` | `display_id` |
| API mensagem | `inbox_id` | `message.inbox_id` (interno) |
| Webhook (`Inbox#webhook_data`) | `inbox.id` | `id` (interno) |

Ou seja: os canais Meta/Evolution (após T04) passam a gravar **exatamente o mesmo tipo de valor** que o Baileys já gravava e que o `updateChatwootMessageId` grava (`body.conversation.id`). Não há mistura de espaços de id. O fallback do T02 (`chatwootConversationId: msg.conversation.id`) compara display_id com display_id — consistente.

### A4 — Formato do `source_id`

Todos os pontos que criam mensagem no Chatwoot usam `'WAID:' + body.key.id` (`chatwoot.service.ts` linhas 2156, 2175, 2200, 2245, 2301, 2336, 2355, 2440) e o import helper normaliza para `WAID:` (linhas 187-188, 311, 575). O `in_reply_to_external_id` do webhook é exatamente esse `source_id`. O parse do caminho primário (`startsWith('WAID:')` + `slice`) está correto.

### A5 — Consumidores dos campos alterados

`chatwootConversationId`: `messages.read` (:2458), `messages.delete` (:2392), `messages.edit` (:2432) e o fallback do T02. Todos esperam um id de **conversa** — nenhum comparava com id de mensagem. Logo, corrigir o valor é estritamente melhor.

`chatwootInboxId`: só é copiado (:1588, :1643), sem consumo funcional. Sem impacto.

`getQuotedMessage`: usado apenas em 2 pontos (:1518 e :1525), ambos no envio Chatwoot → WhatsApp. Nenhum outro fluxo é afetado.

`getMessageByKeyId`: **não foi alterado**; delete/edit/read permanecem intactos.

### A6 — Type-safety com o SDK

O tipo do SDK (`generic_id & message`) não declara `inbox_id`. Porém `eventWhatsapp()` retorna `any` (há branches retornando o resultado de `sendData`/axios), então `chatwootSentMessage.inbox_id` compila sem erro — o mesmo já ocorria com o `chatwootSentMessage.id` e com o Baileys usando `.inbox_id`. Em runtime, o Chatwoot envia `inbox_id`/`conversation_id` no JSON da mensagem.

### A7 — Dados legados (observação)

Linhas gravadas **antes** do T04 nos canais Meta/Evolution permanecem com `chatwootConversationId` incorreto. Não há backfill. Impacto limitado: essas mensagens antigas só falhariam em `read`/`delete`/`edit` e no desempate por conversa do T02 (que recai no fallback sem conversa). Não é regressão — é ausência de correção retroativa.

### A8 — Limitação de validação

Sem `node_modules` no ambiente, não foi possível rodar `tsc`/`eslint`/`build`. A validação feita foi de **sintaxe** (esbuild) nos 3 arquivos, todos OK. Recomenda-se rodar `npm run lint:check && npm run build` antes do deploy.

## Conclusão

- Nenhuma regressão, conflito ou bug **remanescente** identificado após a correção de A1.
- Um risco real (A1: SQL raw/provider no caminho primário) foi detectado e eliminado nesta auditoria.
- Os demais pontos (A2–A7) foram validados como seguros; A7 e A8 são observações/limitações, não defeitos.

### Pendências recomendadas (não bloqueantes)

1. Rodar `npm run lint:check` e `npm run build`.
2. (Opcional) Backfill de `chatwootConversationId` legado nos canais Meta/Evolution.
3. (Opcional) Avaliar índice único `(instanceId, chatwootMessageId)` após limpeza de duplicatas — ver T02, seção 4.