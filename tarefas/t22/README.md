# T22 — Bots/Ads: `getConversationMessage` quebra em localização e não lê Facebook Ads

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` (inclui o fix *"Facebook ads: externalAdReply"*)
- **Arquivo:** `src/utils/getConversationMessage.ts`
- **Linhas (~):** **24**
- **Ordem:** 2/8 · **Simplicidade:** 🟢 alta · **Risco:** 🟢 baixo · **Importância:** 🔴 alta (bots + Facebook Ads)

## 1. Sintomas
- **Localização sem `degreesLatitude`** lança exceção (`Cannot read properties of undefined (reading 'toString')`), podendo quebrar o processamento da mensagem.
- **Facebook Ads** (`externalAdReply` dentro de `extendedTextMessage.contextInfo`) **não** é lido → bots recebem conteúdo vazio/errado para anúncios.
- `getMessageContent` pode escolher a chave `messageType` como conteúdo.
- `getConversationMessage` pode retornar `undefined`.

## 2. Causa raiz
- `degreesLatitude.toString()` sem `?.`.
- `externalAdReply` só é lido em `msg.contextInfo`, não em `msg.message.extendedTextMessage.contextInfo`.
- Filtro de chaves não exclui `messageType`.
- Sem `?? ''` no retorno.

## 3. Solução implementada (upstream)
```diff
-   locationMessage: msg?.message?.locationMessage?.degreesLatitude.toString(),
+   locationMessage: msg?.message?.locationMessage?.degreesLatitude?.toString(),
```

```diff
-   externalAdReplyBody: msg?.contextInfo?.externalAdReply?.body
-     ? `externalAdReplyBody|${msg.contextInfo.externalAdReply.body}`
-     : undefined,
+   externalAdReplyBody: msg?.message?.extendedTextMessage?.contextInfo?.externalAdReply?.body
+     ? `externalAdReplyBody|${msg.message.extendedTextMessage.contextInfo.externalAdReply.body}`
+     : msg?.message?.extendedTextMessage?.contextInfo?.externalAdReply?.title
+       ? `externalAdReplyBody|${msg.message.extendedTextMessage.contextInfo.externalAdReply.title}`
+       : msg?.contextInfo?.externalAdReply?.body
+         ? `externalAdReplyBody|${msg.contextInfo.externalAdReply.body}`
+         : msg?.contextInfo?.externalAdReply?.title
+           ? `externalAdReplyBody|${msg.contextInfo.externalAdReply.title}`
+           : undefined,
```

```diff
- const typeKey = Object.keys(types).find((key) => key !== 'externalAdReplyBody' && types[key] !== undefined);
+ const typeKey = Object.keys(types).find(
+   (key) => key !== 'externalAdReplyBody' && key !== 'messageType' && types[key] !== undefined,
+ );
```

```diff
- return messageContent;
+ return messageContent ?? '';
```

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| Localização | Não lança mais exceção |
| Facebook Ads | Lê `body` e cai em `title` quando não há body; cobre `extendedTextMessage.contextInfo` |
| Conteúdo escolhido | Ignora a pseudo-chave `messageType` |
| Retorno | Sempre string (`?? ''`) → evita `undefined` em bots |
| Risco | Baixo (só extração de texto; não muda envio) |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
`src/utils/getConversationMessage.ts` ficou **byte a byte idêntico** ao `2.4.0-rc2` (incluindo os comentários `FIX FACEBOOK ADS START/END`).

### 4.2 Callers e não-regressão
Quem usa este util: `base-chatbot.controller.ts:802` e `typebot.service.ts:641` (ambos bots). Retornar `''` em vez de `undefined` é **mais seguro** (falsy continua tratado). O `getConversationMessage` do **Chatwoot** (`chatwoot.service.ts:2290`) é um método **diferente** e **não** foi tocado.
- `messageType` como pseudo-conteúdo: antes, se nada casasse, podia ser retornado (`'unknown'`); agora é **filtrado** (correção).
- `externalAdReplyBody`: o ternário acessa `...contextInfo.externalAdReply.body/title` só após o `?.body`/`?.title` ser truthy → **sem risco de undefined**.

### 4.3 Sinergia com T21
`getConversationMessage` agora retorna `''` para mensagem sem texto; o guard do T21 (`if (!normalizedContent) return null`) cobre esse caso → bots não disparam keyword em mídia.

### 4.4 Higiene
- `git diff --check` limpo. `npm run lint:check` → **exit 0**; `npm run build` → **Build success**.

### 4.5 Prevenção de crash no `processBot` (auditado — ganho extra)

O `base-chatbot.controller` passa o `content` (de `getConversationMessage`) para `processBot` (`:941`/debounce `:922`), e o serviço faz `content.toLowerCase().trim()` (`base-chatbot.service.ts:141`).

- **Antes da T22:** se `getConversationMessage` retornasse `undefined` (mensagem sem texto extraível), `undefined.toLowerCase()` lançava **TypeError** → capturado pelo `try/catch` do controller, **abortando o processamento da mensagem**.
- **Depois:** `''` → `''.toLowerCase()` funciona. **Elimina esse crash** silencioso.

Ou seja, a T22 é mais do que cosmética: corrige um caminho de exceção real nos bots.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Receber **localização** de contato → sem erro nos logs; bot trata.
3. Receber mensagem de **anúncio Facebook** (externalAdReply) → o conteúdo chega ao bot (body/title).
4. Regressão: texto/imagem com legenda continuam extraindo corretamente.

## 6. Rollback
Reverter as 4 mudanças (volta ao comportamento anterior).