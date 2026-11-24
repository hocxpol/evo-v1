# Segunda onda de portagem 2.4.0 → evo-v1 — fases T21–T28

- **Data:** 2026-11-24
- **Base do fork:** Evolution API `2.3.7` + customizações T02–T20
- **Upstream de referência:** `evolution-api-2.4.0-rc2` (pasta local `../../evolution-api-2.4.0-rc2`)
- **Método:** uma fase por vez → implementar → auditar → registrar → subir. Cada fase é independente.

> **Fonte desta rodada:** auditoria completa `evo-v1` × `2.4.0-rc2`. As fases T07–T20 já cobriram status ack, `@lid`, Evolution Channel, áudio quoted, trim, `getLastMessage`, list clone, logout, GIF, IPv6, `mentionsEveryOne`, chatbot sessão, `markMessageAsRead`, `deleteInstance` e chats `@lid`. Esta onda cobre o **que ainda faltava**.

## Decisões de escopo
- **Deploy é PostgreSQL** (`docker-compose` usa `postgres:15`) → o item **MySQL `fetchChats`** foi **excluído** (não se aplica).
- **Breaking do 2.4.0 NÃO é adotado:** licensing (`/license`, `RuntimeConfig`), Manager v2, `nginx.conf`, reorganização do compose.
- **Features (não são bugs):** `markMessageAsPlayed`, `decryptPollVote`, `updateMemberAddMode`, `sendCarousel`, `generateMessageID`, `messageId` custom, headers extras de webhook, evento `MESSAGING_HISTORY_SET`, Typebot `file`/`embed`, SQS `BASE_URL` — **não** entram nesta onda (ficam como backlog de feature).

## Fases — ordenadas por **menor risco → maior risco** (e por menor ajuste + importância)

| Fase | Item | ~Linhas | Importância | Risco | Código pronto (upstream)? |
|---|---|---|---|---|---|
| **T21** | `findBotByTrigger` ignora conteúdo vazio/mídia | ~8 | 🔴 alta (bots) | 🟢 baixo | ✅ drop-in |
| **T22** | `getConversationMessage` (optional chaining + Facebook Ads + `?? ''`) | ~24 | 🔴 alta (bots + Ads) | 🟢 baixo | ✅ drop-in |
| **T23** | `createJid` preserva `@newsletter` | ~7 | 🟡 média (canais) | 🟢 baixo | ✅ drop-in |
| **T24** | `onWhatsappCache` race `P2002` (update de fallback) | ~26 | 🟡 média | 🟢 baixo | ✅ drop-in |
| **T25** | `Dockerfile`: `NODE_OPTIONS=--max-old-space-size=2048` | 1 | 🟢 baixa | 🟢 trivial | ✅ 1 linha |
| **T26** | Meta/Business `#2493` (senderJid + ordem Chatwoot→bot) | ~47 | 🔴 alta (Cloud API) | 🟡 médio | ✅ (preservar T04) |
| **T27** | `Instance.token` 255→500 + migration | ~4 + migração | 🟡 média | 🟡 médio (migração) | ✅ |
| **T28** | `fetchLatestWaWebVersion` cache 1h + versão manual | ~77 | 🟡 média (resiliência) | 🟡 médio | ✅ |

### Justificativa da ordem
1. **T21/T22** — maiores ganhos funcionais com **poucas linhas** (bots e Facebook Ads), risco baixo.
2. **T23/T24** — correções pontuais pequenas.
3. **T25** — 1 linha, trivial (mas baixa importância → não lidera).
4. **T26** — médio porte, alto impacto **se usar Cloud API**; ordem de eventos sensível.
5. **T27** — exige **migração de banco** (risco operacional).
6. **T28** — maior arquivo (~77 linhas) e mexe no fluxo de conexão → último.

## Modelo de cada fase
`Status → Data → Versão base → Origem → Arquivos → Linhas → Sintoma → Causa → Solução (diff) → Auditoria/risco → Como validar → Rollback`.

## Regras
- Uma fase por commit (`fix/chore`), `npm run lint:check && npm run build` antes de subir.
- **Preservar T02–T20** (Chatwoot/edição/`@lid`/histórico etc.).
- Migração (T27) só com janela/backup.

## Backlog pós-T28 (opcional, não bloqueante)
- Features 2.4.0 (interactive/played/carousel/etc.).
- SQS `BASE_URL`.
- Validações A07–A16 do doc Glorium.