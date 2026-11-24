# T08 — WhatsApp: envio para contatos `@lid` pode lançar `BadRequestException`

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0-rc2` — PR [#2544](https://github.com/evolution-foundation/evolution-api/pull/2544)
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
- **Tarefas relacionadas:** T07 (ack `<status>`); base 2.3.7 já tem `@lid` no `whatsappNumber`

## 1. Sintoma

Após a migração para LID (Linked Identity) do WhatsApp, ao enviar para um contato cujo JID termina em `@lid`, o `onWhatsApp` da Baileys pode retornar `exists: false`, fazendo `sendMessageWithTyping` (envio de texto/mídia) e `sendPresence` lançarem `BadRequestException` — mesmo o contato existindo (o envio falha com "número inexistente").

## 2. Causa raiz

As guardas de validação pulam o `throw` apenas para grupos e `@broadcast`. O `@lid` não estava contemplado:

```ts
// sendMessageWithTyping (~:2533) e sendPresence (~:2807)
if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
  throw new BadRequestException(isWA);
}
```

**Observação:** nosso `whatsappNumber()` (base 2.3.7) já retorna `exists: true` para `@lid` (`:3821-3830`), então o sintoma provavelmente já é evitado na maioria dos fluxos. Ainda assim, o bypass explícito do #2544 é o fix oficial e elimina o risco residual (ex.: `additionalNodes`/variações de JID).

## 3. Solução implementada

Adicionar `&& !isWA.jid.includes('@lid')` às **duas** guardas:

```diff
- if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
+ if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast') && !isWA.jid.includes('@lid')) {
    throw new BadRequestException(isWA);
  }
```

Ocorrências alteradas: `sendMessageWithTyping` (:2533) e `sendPresence` (:2807).

> **Auditoria da 3ª ocorrência:** existe uma terceira guarda idêntica em `blockUser` (:4354). O upstream (#2544) **não** a alterou — foi mantida como está, para espelhar o comportamento oficial. Não usar `replaceAll` cego aqui.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Números normais (`@s.whatsapp.net`) | Inalterado — a condição continua lançando se `exists: false` |
| Grupos (`@g.us`) e `status@broadcast` | Já pulavam; inalterado |
| `@lid` | Passa a pular o `throw` (fix oficial) |
| Outras validações (criação de chat/contato) | Não são afetadas |
| Risco | Baixo — só remove um bloqueio indevido |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

- As duas guardas alteradas são **byte a byte idênticas** às do `2.4.0-rc2` (`:2563` e `:2847`), confirmado por `diff`.
- Escopo do #2544 reconferido: existem **3** guardas `!isWA.exists …`; o upstream alterou **só 2**. A de `blockUser` (:4354 = upstream :4638) permanece **sem** `@lid` — replicado corretamente. As guardas `!onWhatsapp.exists` (`fetchProfile` :2308, :5145, :5214) também **não** foram tocadas, igual ao upstream.

### 4.2 Ressalva — correção **defensiva** (não muda o comportamento hoje)

O `whatsappNumber()` — **idêntico ao upstream** (nosso :3821-3830 = upstream :4087-4096) — já retorna `exists: true` para `@lid`:

```ts
if (user.jid.includes('@lid')) {
  return new OnWhatsAppDto(user.jid, true, ..., 'lid'); // exists = true
}
```

Como `!isWA.exists` já é `false` para `@lid`, o `throw` **não ocorria** — logo o sintoma do #2544 não se reproduz na prática neste fork (nem no próprio upstream 2.4.0-rc2). O valor da T08 é **paridade com o fix oficial** + **defesa em profundidade** (protege contra mudança futura do `whatsappNumber` ou variações de JID), sem custo. **Sem bloqueadores.**

### 4.3 Riscos residuais

| Risco | Avaliação |
|---|---|
| Enviar para `@lid` inexistente/malformado | Passa a não dar `400` — falha depois, no Baileys (mesmo trade-off aceito pelo upstream) |
| `includes('@lid')` casar algo inesperado | Improvável; idêntico ao upstream |
| `isWA === undefined` (`whatsappNumber` vazio) | `TypeError` pré-existente — **não** introduzido pela T08 |

### 4.4 Higiene

- `git diff --check` limpo; `src` com exatamente **2 linhas** alteradas (2+/2−).
- Largura das linhas: 114 e 116 chars (≤120).
- ⚠️ `npm run lint:check && npm run build` **não executados no ambiente de auditoria** (sem `node_modules`) — rodar antes do deploy.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Enviar texto e `sendPresence` para um JID `@lid` conhecido:
   ```bash
   POST /message/sendText/{instance}   { "number": "<id>@lid", "text": "teste" }
   POST /message/sendPresence/{instance} { "number": "<id>@lid", "presence": "composing" }
   ```
   Esperado: **200** (sem `BadRequestException`), mensagem entregue.
3. Regressão: enviar para número inexistente normal (`0000@s.whatsapp.net`) → deve continuar retornando erro.

## 6. Rollback

Reverter as duas linhas removendo `&& !isWA.jid.includes('@lid')`.
