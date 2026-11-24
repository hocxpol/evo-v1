# T21 — Bots: `findBotByTrigger` casa keyword/regex em mensagem sem texto (mídia)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0`
- **Arquivo:** `src/utils/findBotByTrigger.ts`
- **Linhas (~):** **8** (1 + 5 guard, + formatação)
- **Ordem:** 1/8 · **Simplicidade:** 🟢 alta · **Risco:** 🟢 baixo · **Importância:** 🔴 alta (impacta todos os bots)

## 1. Sintoma
Mensagens **sem texto** (mídia, sticker, localização, ou conteúdo vazio/só espaços) **disparam** bots cujo trigger é `keyword`/`regex`/`contains` — porque a busca roda com `content` vazio e operadores como `includes('')`/`RegExp.test('')` casam. O bot responde indevidamente a fotos/áudios.

## 2. Causa raiz
Não há guarda para conteúdo vazio antes das buscas por keyword/regex; `advancedOperatorsSearch`/`content.includes`/`RegExp.test` recebem string vazia.

## 3. Solução implementada (upstream)
Adicionar normalização e um early-return após o bloco `all`/`none` (que deve continuar casando qualquer mensagem):

```diff
  export const findBotByTrigger = async (botRepository: any, content: string, instanceId: string) => {
+   const normalizedContent = content?.trim() || '';
+
    // Check for triggerType 'all' or 'none' (both should match any message)
    const findTriggerAllOrNone = await botRepository.findFirst({ ... });
    if (findTriggerAllOrNone) {
      return findTriggerAllOrNone;
    }
+
+   // If content is empty (null, undefined, whitespace-only, or media-only messages),
+   // only 'all'/'none' triggers apply — skip keyword/regex matching
+   if (!normalizedContent) {
+     return null;
+   }

    const findTriggerAdvanced = await botRepository.findMany({ ... });
```

> O restante do método continua usando `content` (o upstream **não** trocou por `normalizedContent` nas comparações).

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| Triggers `all`/`none` | **Continuam** casando qualquer mensagem (o guard vem **depois** deles) |
| Keyword/regex/equals/startsWith/endsWith/contains | **Não** casam mais com conteúdo vazio/mídia |
| Bots com trigger por keyword | Deixam de responder a mídia sem texto (correção) |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
`src/utils/findBotByTrigger.ts` ficou **byte a byte idêntico** ao `2.4.0-rc2` (confirmado por `diff`).

### 4.2 Não-regressão
- Triggers `all`/`none` casam **antes** do guard → continuam valendo para qualquer mensagem.
- O restante do método ainda usa `content` (não `normalizedContent`) — igual ao upstream.

### 4.3 Higiene
- `git diff --check` limpo; ~8 linhas alteradas.
- `npm run lint:check` → **exit 0**; `npm run build` → **Build success** (validado após `npm ci` + `db:generate`).

### 4.4 Chamador único e casos-limite (auditado)
- **Chamador único:** `chatbot.controller.findBotTrigger` (`:200`), que já trata `!findBot → return null` — o novo `return null` do guard é **seguro**.
- **Escopo:** `findBotByTrigger` só é chamado em **sessão nova** (`!session`); sessões existentes usam `session.botId` e **não** passam por aqui.
- **`content?.trim()` seguro:** com `content` `undefined`/`null` o optional chaining **não** chama `.trim` (retorna `undefined` → `|| ''`), sem exceção.
- **Mudança de comportamento (intencional):** um bot `triggerType:'keyword'` com regex **catch-all** (`.*`, `^$`) que antes casava mensagem vazia/mídia **deixa de casar** após o guard. Para "responder a tudo", o correto é usar `triggerType: 'all'`/`'none'` (que continuam casando). Mesmo comportamento do upstream.
- **Sinergia com T22:** `getConversationMessage` passa a retornar `?? ''`; o guard do T21 cobre esse caso vazio.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Bot com trigger `keyword` (ex.: `oi`); enviar **imagem sem legenda** → bot **não** responde.
3. Enviar texto `oi` → bot responde.
4. Bot com trigger `all`; enviar imagem → **responde** (inalterado).

## 6. Rollback
Remover `normalizedContent` e o bloco `if (!normalizedContent) return null;`.