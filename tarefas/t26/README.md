# T26 — Meta/Cloud API: `#2493` (senderJid correto + ordem Chatwoot→bot)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — PR [#2493](https://github.com/evolution-foundation/evolution-api/pull/2493) (*"Business API (Cloud): race condition in sender identification resolved; execution order normalised; `chatwootIds` correctly propagated"*)
- **Arquivo:** `src/api/integrations/channel/meta/whatsapp.business.service.ts`
- **Linhas (~):** **~47**
- **Ordem:** 6/8 · **Simplicidade:** 🟡 média · **Risco:** 🟡 médio · **Importância:** 🔴 alta **somente para quem usa Cloud API (Meta)**
- **T04 (`chatwootInboxId`/`chatwootConversationId`):** no `business.service`, o `2.4.0-rc2` **já** usa `inbox_id`/`conversation_id` (o próprio `#2493` corrigiu) → coincide com o nosso T04. **Manter esses valores** (não trocar por `.id`). Obs.: o bug do `.id` ainda persiste no `evolution.channel.service.ts` do upstream — lá mantemos o T04 à parte.

## 1. Sintomas
- **Race de remetente:** `key.remoteJid` usava `this.phoneNumber`, que pode mudar entre o recebimento e o processamento (instância multi-número/evento concorrente) → mensagem gravada no `remoteJid` errado.
- **Ordem inconsistente:** webhook/bot disparavam **antes** do Chatwoot, diferente do canal Baileys.
- `eventHandler`/`messageHandle` não eram `await`ados.

## 2. Causa raiz
`senderJid` era derivado de `this.phoneNumber` (mutável) em vez de capturado uma vez do payload; e a ordem dos efeitos colaterais divergia do Baileys.

## 3. Solução implementada (upstream — preservando T04)
1. **Capturar `senderJid` uma vez** no `connectToWhatsapp` e passar adiante:
```diff
- this.eventHandler(content);
- this.phoneNumber = createJid(content.messages ? content.messages[0].from : content.statuses[0]?.recipient_id);
+ const senderJid = createJid(content.messages ? content.messages[0].from : content.statuses[0]?.recipient_id);
+ this.phoneNumber = senderJid;
+ await this.eventHandler(content, senderJid);
```
2. **Assinaturas** `eventHandler(content, senderJid)` e `messageHandle(received, database, settings, senderJid)`; usar `remoteJid: senderJid` (não `this.phoneNumber`) em mensagens e statuses; `await` nas chamadas.
3. **Ordem normalizada:** Chatwoot **primeiro**, depois `sendDataWebhook(MESSAGES_UPSERT)` + `chatbotController.emit(...)`.
4. `if (chatwootSentMessage?.id)` → `if (chatwootSentMessage)`.

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| `remoteJid` | Passa a vir do payload do evento (imune a race) |
| Ordem | Chatwoot → webhook → bot (igual ao Baileys) |
| T04 (inbox/conversation id) | **Preservado** (não trocar por `.id`) |
| Canal Baileys / Evolution | Não afetados (arquivo é só Meta) |
| Risco | Médio — mexe na ordem de efeitos do Cloud; validar |
| Impacto | **Alto apenas para instâncias Cloud API** |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
`src/api/integrations/channel/meta/whatsapp.business.service.ts` ficou **byte a byte idêntico** ao `2.4.0-rc2` (`diff` vazio). Isso confirma que:
- o `senderJid` capturado uma vez + passado a `eventHandler`/`messageHandle`;
- `await` nas chamadas;
- ordem **Chatwoot → webhook → bot**;
- `if (chatwootSentMessage)` (sem `?.id`).
E o T04 (`inbox_id`/`conversation_id`) **coincide** com o upstream neste arquivo (o `#2493` corrigiu o `chatwootIds` também).

### 4.2 Sem overrides cruzados
`eventHandler`/`messageHandle` são `protected` do `BusinessStartupService` e **não** têm overrides/outros callers com a assinatura antiga (verificado por `grep`). Os `eventHandler` do Evolution Channel e do Baileys são métodos de **outras classes**, não afetados.

### 4.3 Não-regressão
- Canal Baileys/Evolution não usam este arquivo.
- `chatbotController.emit` + `sendDataWebhook` continuam rodando, agora **após** o Chatwoot.
- `statuses` passam a usar `senderJid` (mesmo valor capturado no início).

### 4.4 Higiene
- `git diff --check` limpo. `npm run lint:check` → **exit 0**; `npm run build` → **Build success**.
- **Impacto:** só instâncias **Cloud API (Meta)**; Baileys/Evolution inalterados.

### 4.5 Webhook do Meta — ACK é rápido (diagnóstico **corrigido**)
- **Correção de diagnóstico (auditoria posterior):** o `receiveWebhook` processa com `data.entry?.forEach(async …)`, e **`Array.forEach` NÃO aguarda** callbacks async. O `await connectToWhatsapp(...)` está **dentro** do callback → a rota (`meta.router:17`) recebe o retorno **imediatamente**. Portanto o `await eventHandler` adicionado pela T26 **não** torna a resposta ao Meta síncrona. **O risco de latência NÃO se aplica.**
- O upstream também usa esse padrão (`forEach(async …)`), então a T26 é fiel.
- O **risco real** desse padrão (promessas flutuantes sem `catch` → *unhandled rejection*) foi tratado na **[T26b](../t26b/README.md)**.

### 4.6 Payload do `MESSAGES_UPSERT` (mudança aditiva)
Como o Chatwoot roda **antes** do `sendDataWebhook`, o payload de `MESSAGES_UPSERT` agora inclui `chatwootMessageId`/`chatwootInboxId`/`chatwootConversationId`. É **aditivo** (consumidores devem tolerar); é o objetivo do *"chatwootIds correctly propagated"* do #2493.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Instância **Cloud API** recebendo mensagem → conferir:
   - `remoteJid` correto (= `from` do payload);
   - Chatwoot recebe **antes** de webhook/bot (ordem nos logs);
   - `chatwootInboxId`/`chatwootConversationId` corretos (T04).
3. Webhook `MESSAGES_UPSERT` e bot disparam normalmente.

## 6. Rollback
Reverter para `this.eventHandler(content)` / `this.phoneNumber` / ordem antiga (webhook antes do Chatwoot).