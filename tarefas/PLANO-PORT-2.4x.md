# Plano de portagem 2.4.x → evo-v1 — fases T08–T15

- **Data:** 2026-11-24
- **Base do fork:** Evolution API `2.3.7` + customizações T02–T07
- **Upstream de referência:** `evolution-api-2.4.0` / `2.4.0-rc2` (pasta local `../evolution-api-2.4.0-rc2`)
- **Documento de auditoria relacionado:** `../Auditoria_Correcoes_Evolution_API_Glorium.md`
- **Método:** uma fase por vez → auditar → subir (commit). Cada fase é independente, testável e reversível.

> ⚠️ **Não adotar a 2.4.0 inteira.** Ela introduz **BREAKING CHANGE** (licença obrigatória + tabela `RuntimeConfig`), Manager v2 redesenhado e endpoints interativos novos. Aqui só fazemos **backport seletivo** de correções, preservando T02–T07.

## Auditoria resumida

### 2.4.0-rc2 (fixes)
| PR | Correção | Na nossa versão? | Fase |
|---|---|---|---|
| #2544 | bypass `@lid` em `sendPresence`/`sendMessageWithTyping` | ❌ ausente | **T08** |
| #2420 | Evolution Channel deixa de travar em `close` | ❌ ausente | **T09** |
| #2516 | `quoted` propagado em `sendWhatsAppAudio` | ❌ ausente | **T10** |
| #2546 | `instanceName` trimado na criação | ❌ ausente | **T11** |
| #2540 | GIF nativo (`gifPlayback`/`gifAttribution`) | ❌ ausente | **T15** |

### 2.4.0 (Fixed)
| Correção | Na nossa versão? | Fase |
|---|---|---|
| #2495/#2515 `getLastMessage` filtro JSON Prisma | ❌ ausente | **T12** |
| #2461 list messages: JSON clone destrutivo (`this.isZero`) | ❌ ausente | **T13** |
| `/instance/logout` idempotente | ❌ ausente | **T14** |
| #2470 `mentionsEveryOne` honra `false` | ⚠️ verificar | backlog |
| `markMessageAsRead` JID; #2510 history sync race; #2493 business race; #2520 `remove.instance`; chatbot session; docker compose; chats `accountLid`; trailing slash; `maxRetries` verbose | ⚠️ verificar | backlog |

### 2.3.7 (base — já presentes)
proxy Undici (`makeProxyAgentUndici`), índice único `Chat(instanceId, remoteJid)`, remount do `messageProcessor`, MinIO/`messageContextInfo`, cache OnWhatsapp (LID), etc. → itens A07–A15 do doc de auditoria são de **validação**, não de portagem.

## Fases (ordem de execução)

| Fase | Prioridade | Correção | Arquivo(s) | Risco |
|---|---|---|---|---|
| **T08** | 🔴 Crítica | #2544 bypass `@lid` | `whatsapp.baileys.service.ts` | Baixo |
| **T09** | 🔴 Crítica | #2420 Evolution Channel `open` | `evolution.channel.service.ts`, `monitor.service.ts`, `instance.controller.ts` | Médio |
| **T10** | 🟠 Alta | #2516 áudio com `quoted` | `whatsapp.baileys.service.ts` | Baixo |
| **T11** | 🟠 Alta | #2546 `instanceName` trim | `instance.controller.ts` | Baixo |
| **T12** | 🟠 Alta | #2495 `getLastMessage` | `whatsapp.baileys.service.ts` | Baixo |
| **T13** | 🟠 Alta | #2461 list clone → `normalizeListType` | `whatsapp.baileys.service.ts` | Médio |
| **T14** | 🟡 Média | logout idempotente | `instance.controller.ts` | Baixo |
| **T15** | 🟡 Média | #2540 GIF nativo | `sendMessage.dto.ts`, `message.schema.ts`, `whatsapp.baileys.service.ts` | Médio |

## Modelo de cada fase
Cada `tNN/README.md` segue o padrão do fork: **Status → Data → Versão base → Origem → Arquivos → Sintoma → Causa raiz → Solução (diff exato) → Auditoria/efeitos colaterais → Como validar → Rollback**.

## Regras
- Uma fase por commit; mensagem no padrão `fix(scope): ...` (commitlint).
- Antes de subir: `npm run lint:check && npm run build`.
- Preservar **T02–T07** (não tocar nos fluxos de Chatwoot/edição).
- Ao terminar cada fase, mover o `tNN/` para o repositório em `evo-v1/tarefas/tNN/` e atualizar o índice `tarefas/README.md`.

## Backlog (Tier 3 — verificação, sem código novo)
- Testes de regressão T02–T07 (checklist do doc de auditoria).
- Validar ephemeral, S3/MinIO, grupos/LID, memória/listeners, índice `Chat`, fuso, filas/retry, sessão/restart.
- Triagem dos "⚠️ verificar" da 2.4.0.
