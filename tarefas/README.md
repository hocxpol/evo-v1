# Tarefas — Evolution API (fork `2027-Evo-v2`)

Registro das correções/ajustes aplicados neste fork da Evolution API, organizado **uma pasta por tarefa**, cada uma com seu `README.md`.

- **Versão base:** Evolution API `2.3.7`
- **Convenção:** `tarefas/tNN/README.md` (sintoma → causa raiz → solução → validação → riscos → rollback). Documentos transversais ficam em sua própria pasta (ex.: `tarefas/auditoria/README.md`).

## Índice de tarefas

| Tarefa | Título | Status | Documento |
|---|---|---|---|
| **T02** | Chatwoot: resposta cita a mensagem errada (de outra conversa) | Concluída | [t02/README.md](./t02/README.md) |
| **T03** | Chatwoot: mensagem marcada como falha (vermelha) mesmo tendo sido enviada | Concluída | [t03/README.md](./t03/README.md) |
| **T04** | Chatwoot: `chatwootConversationId`/`chatwootInboxId` errados nos canais Meta e Evolution | Concluída | [t04/README.md](./t04/README.md) |
| **T05** | Chatwoot: apagar mensagem do atendente não reflete no WhatsApp do cliente | Concluída | [t05/README.md](./t05/README.md) |
| **T06** | Chatwoot: edição de mensagens (Glorium.Chat T13) não funciona ponta a ponta | Em andamento | [t06/README.md](./t06/README.md) |
| **T07** | Baileys: instância para de receber (stanzas `<status>` sem ack) | Concluída | [t07/README.md](./t07/README.md) |
| **T08** | WhatsApp: envio para contatos `@lid` pode lançar `BadRequestException` (#2544) | Concluída | [t08/README.md](./t08/README.md) |
| **T09** | Evolution Channel: instâncias presas em `close` (#2420) | Concluída | [t09/README.md](./t09/README.md) |
| **T10** | WhatsApp: áudio com `quoted` não vira resposta encadeada (#2516) | Concluída | [t10/README.md](./t10/README.md) |
| **T11** | API de instância: nome com espaços causa 404 (#2546) | Concluída | [t11/README.md](./t11/README.md) |
| **T12** | `getLastMessage`: filtro JSON do Prisma retorna mensagem errada (#2495/#2515) | Concluída | [t12/README.md](./t12/README.md) |
| **T13** | List messages: clonagem JSON destrutiva quebra campos `Long` (#2461) | Concluída | [t13/README.md](./t13/README.md) |
| **T14** | `/instance/logout` idempotente (não falhar quando já desconectada) | Concluída | [t14/README.md](./t14/README.md) |
| **T15** | WhatsApp: GIF nativo (`gifPlayback`/`gifAttribution`) (#2540) | Concluída | [t15/README.md](./t15/README.md) |
| **T16** | Baixo risco: flag IPv6 no boot + `everyOne`→`mentionsEveryOne` | Concluída | [t16/README.md](./t16/README.md) |
| **T17** | Chatbot: sessão `closed` bloqueia reativação do bot | Concluída | [t17/README.md](./t17/README.md) |
| **T18** | `markMessageAsRead`: filtro de JID ignora `@lid`/business | Concluída | [t18/README.md](./t18/README.md) |
| **T19** | `deleteInstance`: instância "zumbi" quando o logout falha (#2520) | Concluída | [t19/README.md](./t19/README.md) |
| **T20** | Chats: normalização `remoteJid`/`@lid` no histórico | Concluída | [t20/README.md](./t20/README.md) |
| **T21** | Bots: `findBotByTrigger` casa keyword/regex em mídia/sem texto | Concluída | [t21/README.md](./t21/README.md) |
| **T22** | Bots/Ads: `getConversationMessage` (localização + Facebook Ads) | Concluída | [t22/README.md](./t22/README.md) |
| **T23** | `createJid` não preserva `@newsletter` | Concluída | [t23/README.md](./t23/README.md) |
| **T24** | `onWhatsappCache` race `P2002` (remoteJid) | Concluída | [t24/README.md](./t24/README.md) |
| **T25** | Build: `NODE_OPTIONS=--max-old-space-size=2048` | Concluída | [t25/README.md](./t25/README.md) |
| **T26** | Meta/Cloud `#2493` (senderJid + ordem Chatwoot→bot) | Concluída | [t26/README.md](./t26/README.md) |
| **T26b** | Webhook Meta: ACK assíncrono (já era) + tratamento de erro no background | Concluída | [t26b/README.md](./t26b/README.md) |
| **T27** | `Instance.token` 255→500 + migração | Concluída | [t27/README.md](./t27/README.md) |
| **T28a** | `fetchLatestWaWebVersion`: cache da versão (sem versão manual) | Concluída | [t28a/README.md](./t28a/README.md) |
| **T28b** | `fetchLatestWaWebVersion`: versão manual (`CONFIG_BAILEYS_VERSION`) | Concluída | [t28b/README.md](./t28b/README.md) |

> **Fases 2.4.x (T08–T20):** visão geral e auditoria de lacunas em [PLANO-PORT-2.4x.md](./PLANO-PORT-2.4x.md).
> **Segunda onda (T21–T28):** visão geral, ordem por risco e exclusões em [PLANO-PORT-2.4x-FASE2.md](./PLANO-PORT-2.4x-FASE2.md).

> **Plano de portagem 2.4.x:** visão geral, auditoria e ordem de execução em [PLANO-PORT-2.4x.md](./PLANO-PORT-2.4x.md).

## Auditoria

| Documento | Escopo |
|---|---|
| [auditoria/README.md](./auditoria/README.md) | Auditoria completa das correções T02 e T04 (regressões, conflitos e bugs) |

## Arquivos de código afetados (consolidado)

| Arquivo | Tarefas |
|---|---|
| `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` | T02, T03, T05 |
| `src/api/integrations/channel/evolution/evolution.channel.service.ts` | T04 |
| `src/api/integrations/channel/meta/whatsapp.business.service.ts` | T04 |
| `scripts/patch-baileys-message-secret.js` | T06 |
| `scripts/patch-baileys-status-ack.js` | T07 |

## Contexto comum

T02, T03, T04 e T05 são correções da integração **Chatwoot ↔ Evolution API**. Referências upstream relevantes:

- [evolution-foundation/evolution-api#2014](https://github.com/evolution-foundation/evolution-api/issues/2014) — meta-issue Chatwoot
- [evolution-foundation/evolution-api#491](https://github.com/evolution-foundation/evolution-api/issues/491) — resposta referencia mensagem errada
- [evolution-foundation/evolution-api#2078](https://github.com/evolution-foundation/evolution-api/issues/2078) — regressão de reply/quote
- [evolution-foundation/evolution-api#2716](https://github.com/evolution-foundation/evolution-api/pull/2716) — reentrega do mesmo `key.id`