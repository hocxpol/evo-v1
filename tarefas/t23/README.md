# T23 — `createJid` não preserva JIDs de canal/newsletter (`@newsletter`)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0`
- **Arquivo:** `src/utils/createJid.ts`
- **Linhas (~):** **7**
- **Ordem:** 3/8 · **Simplicidade:** 🟢 alta · **Risco:** 🟢 baixo · **Importância:** 🟡 média (canais/newsletters)

## 1. Sintoma
JIDs terminados em `@newsletter` (canais/newsletters) não estão na lista de "já é JID" — passam pelo saneamento e são **transformados** indevidamente (viram `@s.whatsapp.net`, perdendo o canal), quebrando envio/recebimento com canais.

## 2. Causa raiz
`createJid` só reconhece `@g.us`, `@s.whatsapp.net` e `@lid` como JIDs prontos:

```ts
// createJid.ts (~:38)
if (number.includes('@g.us') || number.includes('@s.whatsapp.net') || number.includes('@lid')) {
  return number;
}
```

## 3. Solução implementada (upstream)
```diff
- if (number.includes('@g.us') || number.includes('@s.whatsapp.net') || number.includes('@lid')) {
+ if (
+   number.includes('@g.us') ||
+   number.includes('@s.whatsapp.net') ||
+   number.includes('@lid') ||
+   number.includes('@newsletter')
+ ) {
    return number;
  }
```

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| JIDs `@newsletter` | Passam a ser retornados **verbatim** (correção) |
| Grupos/PN/LID | Inalterados |
| Números puros (sem `@`) | Continuam sendo normalizados normalmente |
| Risco | Baixo — só adiciona uma condição de "já é JID" |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
`src/utils/createJid.ts` ficou **byte a byte idêntico** ao `2.4.0-rc2` (confirmado por `diff`).

### 4.2 Não-regressão (auditado — 25 call sites)
`createJid` tem **~25 chamadas** em `src`; amostragem mostra que todas passam **número ou JID** (nunca texto livre): `channel.service` (remoteJid de query), `meta/evolution/baileys` (number/jid do payload). Como um número/JID só contém `@newsletter` se **for** de canal, **não há risco de falso positivo**.
- A nova condição só muda entradas que **contêm `@newsletter`** (antes saneadas para `@s.whatsapp.net`).
- `@broadcast` continua em checagem **própria** (linha seguinte) — `status@broadcast` não casa no 1º bloco e cai no 2º, como antes.
- `number.replace(/:\d+/, '')` roda antes; o early-return do `@newsletter` ocorre **antes** do strip de dígitos (sem alterar o pipeline).

### 4.3 Higiene
- `git diff --check` limpo; ~7 linhas alteradas (só formatação da condição + `@newsletter`).
- `npm run lint:check` → **exit 0**; `npm run build` → **Build success**.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Chamar `createJid('123456@newsletter')` → retorna `123456@newsletter` (inalterado).
3. Regressão: `createJid('5511...')` → `5511...@s.whatsapp.net`.

## 6. Rollback
Reverter a condição para a forma de uma linha original.