# Checklist de validação — pacote T16–T20

- **Data:** 2026-11-24
- **Escopo:** fases T16, T17, T18, T19, T20 (2ª onda, porte seletivo 2.4.0)
- **Migração de banco:** **nenhuma** (T16–T20 não alteram schema/migrations)
- **Pré-requisito de deploy:** T20 ainda **não commitada** no momento da criação deste checklist

Legenda: ⬜ a executar · ✅ ok · ❌ falhou

---

## 0. Antes de começar
- [ ] Backup do PostgreSQL/Redis (mesmo sem migração — segurança).
- [ ] Anotar a tag/imagem atual em produção (para rollback).
- [ ] `git log --oneline -6` — confirmar T16–T19 commitadas e T20 pronta.

## 1. Build & lint (obrigatório)
- [ ] `npm run lint:check`
- [ ] `npm run build` (`tsc --noEmit && tsup`)
- [ ] `npm start` (dev) sobe sem erro de tipo/import.
- [ ] Flag do T16 aceita pelo Node:
  - [ ] `node --network-family-autoselection-attempt-timeout=1000 -e "console.log('ok')"` → imprime `ok`.

## 2. T16 — IPv6 no boot + `mentionsEveryOne`
- [ ] `npm run start:prod` sobe normalmente (não trava no boot).
- [ ] `sendText` para **grupo** com `mentionsEveryOne: true` → menciona todos os participantes.
- [ ] `sendText` para grupo com `mentionsEveryOne: false` → **não** menciona ninguém.
- [ ] Regressão: `sendText` normal (sem o campo) inalterado.
- [ ] (Se testar em host com IPv6 quebrado) boot não pendura.

## 3. T17 — Chatbot: sessão `closed` reativa
- [ ] Iniciar um bot (ex.: Typebot/OpenAI) e conversar; encerrar via `keywordFinish` → sessão `closed`.
- [ ] Enviar nova mensagem do mesmo contato → bot **reinicia** (nova conversa).
- [ ] Regressão: sessão `paused` continua **ignorando** mensagens; sessão ativa inalterada.

## 4. T18 — `markMessageAsRead` com `@lid`
- [ ] Receber mensagem de contato `@lid` (telefone oculto) e marcar como lida (`chat/markMessageAsRead`).
  - [ ] No WhatsApp do contato aparece "lida".
- [ ] Regressão: marcar como lida em conversa `@s.whatsapp.net` e em grupo continua funcionando.

## 5. T19 — `deleteInstance` robusto
- [ ] Excluir uma instância **saudável** → removida, retorno SUCCESS.
- [ ] Excluir instância com **socket morto** (instância `open` mas conexão caída) → removida (sem "zumbi"); log mostra `logout failed during deleteInstance — proceeding with cleanup`.
- [ ] Regressão: instância não reaparece ao listar; memória limpa.

## 6. T20 — Chats `remoteJid`/`@lid` no histórico
> Precisa de **instância nova** (ou reconexão com history sync) para exercitar o `messaging-history.set`.
- [ ] Conectar instância nova (QR) e aguardar o history sync terminar.
- [ ] Inspecionar a tabela `Chat`:
  ```sql
  SELECT "remoteJid", name FROM "Chat"
  WHERE "instanceId" = '<ID>' ORDER BY "createdAt" DESC LIMIT 30;
  ```
  - [ ] Chats de contatos `@lid` (com PN conhecido) aparecem com `remoteJid` = **`...@s.whatsapp.net`** (telefone real), **não** `@lid`.
  - [ ] Nenhum par duplicado do mesmo contato (`@lid` + PN) para o mesmo `instanceId`.
- [ ] Webhook `CHATS_SET` (se configurado): payload inclui `remoteLid` (e `remoteLid: null` para chats sem LID).
- [ ] Chats persistem antes do webhook (persist-then-emit) — se consumir via webhook e consultar o banco, o chat já existe.
- [ ] Regressão: chats normais (PN/grupo) sincronizam como antes; `MESSAGES_SET` inalterado.

## 7. Smoke test end-to-end (preservação T02–T07)
Com uma instância WhatsApp conectada:
- [ ] Enviar/receber **texto**.
- [ ] Enviar **imagem** e **documento**.
- [ ] Enviar **áudio com `quoted`** → áudio citando a mensagem (T10).
- [ ] Marcar como lida / arquivar conversa (T12 `getLastMessage`).
- [ ] **Editar** mensagem (T06) e **apagar** mensagem (T05) — refletir no WhatsApp/Chatwoot.
- [ ] Chatwoot: resposta cita a mensagem certa (T02), sem "vermelho" de falha (T03), `inbox_id`/`conversation_id` corretos (T04).
- [ ] Instância **Evolution Channel** → status `open` (T09).
- [ ] Conexão estável > 60 min, sem `stream errored out (class="status")` (T07).

## 8. Sinais de alerta (observar logs)
- [ ] **Ausência** de `stream errored out (ack class="status")` (T07).
- [ ] `logout failed during deleteInstance` só aparece no cenário de socket morto (T19) — não em operação normal.
- [ ] Sem `Unique constraint failed` em `Chat` (T20) nem em `IsOnWhatsapp`.
- [ ] Sem erros de history sync no boot de instância.

## 9. Critério de aceite
- Build/lint ok; boots sem travar.
- T16–T20 com os resultados esperados acima.
- T02–T07 preservados no smoke.
- Sem duplicação de chats LID/PN.

## 10. Rollback
- Fase isolada: `git revert <hash-da-fase>` (T16–T19 já commitadas; T20 no commit pendente).
- Sem migração a desfazer.

## 11. Observação de dados (T20)
Chats gravados com `remoteJid=@lid` **antes** da T20 **não** são reescritos. Se necessário, fazer **backfill/limpeza** de chats `@lid` antigos como tarefa separada (não bloqueia o deploy).