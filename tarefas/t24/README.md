# T24 — `onWhatsappCache`: race condition gera `Unique constraint failed (remoteJid)`

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0`
- **Arquivo:** `src/utils/onWhatsappCache.ts`
- **Linhas (~):** **26**
- **Ordem:** 4/8 · **Simplicidade:** 🟢 alta · **Risco:** 🟢 baixo · **Importância:** 🟡 média

## 1. Sintoma
Sob concorrência (várias mensagens/instância processando número novo ao mesmo tempo), o `saveOnWhatsappCache` pode falhar com `Unique constraint failed on the fields: (remoteJid)` — o registro é criado por outro fluxo entre o `findFirst` e o `create`.

## 2. Causa raiz
`saveOnWhatsappCache` faz `findFirst` → (se não existe) `create`. É um **check-then-act** não atômico; a corrida viola o `unique(remoteJid)`.

## 3. Solução implementada (upstream)
Importar `Prisma` e tratar `P2002` no `create`, caindo para `update`:

```diff
+ import { Prisma } from '@prisma/client';
```

```diff
        await prismaRepository.isOnWhatsapp.create({
          data: dataPayload,
        });
```
```diff
+       try {
+         await prismaRepository.isOnWhatsapp.create({
+           data: dataPayload,
+         });
+       } catch (error: any) {
+         // Check for unique constraint violation (Prisma error code P2002)
+         if (
+           error instanceof Prisma.PrismaClientKnownRequestError &&
+           error.code === 'P2002' &&
+           (error.meta?.target as string[])?.includes('remoteJid')
+         ) {
+           logger.verbose(`[saveOnWhatsappCache] Race condition detected for ${remoteJid}, updating existing record instead.`);
+           await prismaRepository.isOnWhatsapp.update({
+             where: { remoteJid: remoteJid },
+             data: dataPayload,
+           });
+         } else {
+           throw error;
+         }
+       }
```

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| Caminho sem corrida | `create` normal, inalterado |
| Corrida (P2002 em `remoteJid`) | Faz `update` do registro existente (não perde dados) |
| Outros erros | Relançados (`throw`) — não mascara falhas |
| `update where remoteJid` | `remoteJid` é `@unique` no modelo `IsOnWhatsapp` → `where` válido |
| Risco | Baixo |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
`src/utils/onWhatsappCache.ts` ficou **byte a byte idêntico** ao `2.4.0-rc2` (confirmado por `diff`).

### 4.2 Pré-requisitos verificados
- `IsOnWhatsapp.remoteJid` é **`@unique`** → `update({ where: { remoteJid } })` é válido.
- Coluna `lid` existe (`lid String?`) → **sem migração** para esta fase.
- Import `{ Prisma } from '@prisma/client'` disponível; `@prisma/client` é external no tsup (sem inchaço de bundle).

### 4.3 Robustez do tratamento P2002
- `error.meta?.target` funciona tanto como **array** (`['remoteJid']`) quanto **string** (`'IsOnWhatsapp_remoteJid_key'`) — `String.includes` acha o substring.
- Se `meta.target` for `undefined` → `?.includes` curto-circuita → **rethrow** (não mascara outros erros P2002).
- Erros não-P2002 e falha do próprio `update` caem no `catch` externo do `saveOnWhatsappCache` (loga e segue) — comportamento inalterado.

### 4.4 Risco residual (igual ao upstream)
Consistência **eventual** do `jidOptions`: o `update` de fallback grava `dataPayload` sem merge com a linha criada pelo "vencedor" da corrida; o próximo `saveOnWhatsappCache` faz `findFirst` e **merge** (auto-corrige). Impacto baixo (é cache).

### 4.5 Higiene
- `git diff --check` limpo; ~26 linhas (import + try/catch).
- `npm run lint:check` → **exit 0**; `npm run build` → **Build success**.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Enviar várias mensagens simultâneas para o mesmo número "novo" → **sem** `Unique constraint failed` nos logs; cache populado uma vez.
3. Regressão: cache salvo/lido normalmente.

## 6. Rollback
Reverter o `try/catch` para o `create` simples (e remover o import `Prisma`).