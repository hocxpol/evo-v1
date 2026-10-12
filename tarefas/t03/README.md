# T03 — Chatwoot: mensagem marcada como falha (vermelha) mesmo tendo sido enviada

- **Status:** Concluída
- **Data:** 2026-10-12
- **Versão base:** Evolution API `2.3.7`
- **Arquivo alterado:** `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`
- **Referências upstream:** [evolution-foundation/evolution-api#2014](https://github.com/evolution-foundation/evolution-api/issues/2014) (meta-issue Chatwoot), [chatwoot/chatwoot#12294](https://github.com/chatwoot/chatwoot/issues/12294)
- **Tarefas relacionadas:** T02 (resposta cita mensagem errada), T04 (`chatwootConversationId`/`chatwootInboxId` nos canais Meta/Evolution)

## 1. Sintoma

Ao responder uma conversa pelo Chatwoot, o cliente **recebe a mensagem no WhatsApp normalmente**, mas a UI do Chatwoot mostra a mensagem do agente em **vermelho / "falha ao enviar"**, com o erro:

```
Net::ReadTimeout with #<TCPSocket:(closed)>
```

## 2. Causa raiz

O endpoint `POST /chatwoot/webhook/:instanceName` (recebido do Chatwoot) processava **toda a cadeia de envio de forma síncrona** e só respondia ao Chatwoot no final. Do lado do Chatwoot, o webhook tem timeout curto:

- Em `chatwoot/lib/webhooks/trigger.rb`, o `WEBHOOK_TIMEOUT` é lido de `GlobalConfig` e, por padrão, vale **5 s** — aplicado tanto a `open_timeout` quanto a `read_timeout` da chamada que o Chatwoot faz para a Evolution.
- Em caso de timeout/erro, para inbox do tipo `api` (o que a Evolution usa), o Chatwoot executa `Messages::StatusUpdateService.new(message, 'failed', error.message)` — **é exatamente isso que pinta a mensagem de vermelho**, mesmo a entrega ao WhatsApp já tendo ocorrido.

Fatores que estouravam os 5 s na Evolution (v2.3.7):

| Local (`chatwoot.service.ts`) | Fator de latência |
|---|---|
| `receiveWebhook` (:1320) | `setTimeout` artificial de **500 ms** |
| envio de texto | delay de digitação aleatório de **500–2000 ms** |
| envio de mídia | delay de digitação de **1200 ms** |
| envio de áudio/template | delay de digitação de **500–2000 ms** |
| `sendMessageWithTyping` | verificação `whatsappNumber()` (chamada de rede ao Baileys quando o número não está em cache) |
| pós-envio | `updateChatwootMessageId` (SQL raw + possível import de histórico) e rotina de leitura (`MESSAGE_READ`) |

Ou seja: a resposta só saía depois do delay + envio + persistência. Somando proxy reverso/Cloudflare, o `read_timeout` de 5 s era atingido com frequência.

## 3. Solução implementada

Arquivo alterado: `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts`

1. **ACK imediato + processamento em background (correção na raiz).**
   - `receiveWebhook` agora responde `{ message: 'bot' }` imediatamente e dispacha o trabalho pesado para `processWebhook` **sem `await`**, com `.catch()` para log.
   - O contrato HTTP com o Chatwoot permanece o mesmo (`200` + `{ message: 'bot' }`), e o Chatwoot não usa o corpo da resposta.

   ```ts
   public async receiveWebhook(instance: InstanceDto, body: any) {
     void this.processWebhook(instance, body).catch((error) => {
       this.logger.error(`Error processing Chatwoot webhook: ${error}`);
     });
     return { message: 'bot' };
   }

   private async processWebhook(instance: InstanceDto, body: any) { /* lógica original */ }
   ```

2. **Remoção do `setTimeout(500)`** artificial que existia no início do processamento.

3. **Remoção do delay de digitação nos envios do Chatwoot** (texto, template, mídia e áudio). O delay deixou de ser enviado em `SendTextDto`/`SendMediaDto`/`SendAudioDto`, então `sendMessageWithTyping` não simula mais "digitando…" para esses envios.
   - Mudança cirúrgica: feita apenas nos envios da integração Chatwoot, sem tocar no método genérico `sendMessageWithTyping` — assim os demais chatbots que usam `isIntegration=true` mantêm o comportamento.

## 4. Configuração complementar no Chatwoot (recomendada)

Mesmo com o ACK imediato, recomenda-se aumentar o timeout do lado do Chatwoot como reforço:

- **Chatwoot Super Admin → General Settings → `WEBHOOK_TIMEOUT`** (fica em `installation_configs`), ajustar para **20 s** (faixa recomendada 20–45 s).
- Isso é o paliativo validado na comunidade no issue #2014 e ajuda caso o processamento demore por outros motivos.

## 5. Como validar

1. Enviar uma resposta pelo Chatwoot em uma conversa conectada à Evolution.
2. Confirmar que a mensagem chega no WhatsApp **e** que a UI do Chatwoot **não** a marca como falha/vermelha.
3. Verificar nos logs da Evolution que o webhook é processado normalmente (não deve haver `Net::ReadTimeout` no lado do Chatwoot).
4. Testar também envio de mídia/áudio e nota com template.

## 6. Riscos e trade-offs

- **Fire-and-forget:** erros de envio passam a ser apenas logados e reportados via nota privada no Chatwoot (`onSendMessageError`) — **exatamente o comportamento que já existia**, pois o `receiveWebhook` original já capturava a exceção e respondia `200`. Não há mudança funcional nesse ponto.
- **Ordenação de mensagens:** a ordem entre requisições concorrentes já não era garantida (por causa dos delays aleatórios). A alteração não piora esse cenário. Se surgir relato real de reordenação, avaliar fila serial por `conversationId` (T03-B, não implementado).
- **Sem indicador "digitando…":** o delay de digitação era puramente cosmético e foi removido apenas no fluxo Chatwoot.

## 7. Rollback

Reverter o arquivo `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` para o estado anterior:
- restaurar `receiveWebhook` como método único (sem `processWebhook`),
- reinserir o `setTimeout(500)`,
- reinserir os campos `delay` nos envios.