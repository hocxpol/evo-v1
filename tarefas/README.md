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

## Contexto comum

T02, T03, T04 e T05 são correções da integração **Chatwoot ↔ Evolution API**. Referências upstream relevantes:

- [evolution-foundation/evolution-api#2014](https://github.com/evolution-foundation/evolution-api/issues/2014) — meta-issue Chatwoot
- [evolution-foundation/evolution-api#491](https://github.com/evolution-foundation/evolution-api/issues/491) — resposta referencia mensagem errada
- [evolution-foundation/evolution-api#2078](https://github.com/evolution-foundation/evolution-api/issues/2078) — regressão de reply/quote
- [evolution-foundation/evolution-api#2716](https://github.com/evolution-foundation/evolution-api/pull/2716) — reentrega do mesmo `key.id`