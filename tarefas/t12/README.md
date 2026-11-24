# T12 — `getLastMessage`: filtro JSON do Prisma retorna a mensagem errada

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — PRs [#2495](https://github.com/evolution-foundation/evolution-api/pull/2495) / [#2515](https://github.com/evolution-foundation/evolution-api/pull/2515)
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

## 1. Sintoma

`getLastMessage(number)` não encontra a última mensagem da conversa (retorna `NotFoundException` ou um registro incorreto). Impacta `archiveChat` / `markChatAsUnread` (que usam `lastMessages`).

## 2. Causa raiz

O filtro JSON do Prisma usa o **atalho errado** `key: { remoteJid: number }`, que não aplica o *path* dentro do campo JSON `key`:

```ts
// :3928 (versão com bug)
const where: any = { key: { remoteJid: number }, instanceId: this.instance.id };
```

O correto é usar `path` + `equals`:

```ts
const where: any = { key: { path: ['remoteJid'], equals: number }, instanceId: this.instanceId };
```

## 3. Solução implementada

```diff
  public async getLastMessage(number: string) {
-   const where: any = { key: { remoteJid: number }, instanceId: this.instance.id };
+   const where: any = { key: { path: ['remoteJid'], equals: number }, instanceId: this.instanceId };

    const messages = await this.prismaRepository.message.findMany({
      where,
      orderBy: { messageTimestamp: 'desc' },
      take: 1,
    });
    ...
```

> Nota: `this.instance.id` e `this.instanceId` são equivalentes (getter). Alinhar ao upstream (`this.instanceId`) para consistência.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Consumidores | `getLastMessage` é usado em `archiveChat`/`markChatAsUnread` (via `data.lastMessage`); corrigir o filtro só melhora |
| Compat. Postgres/MySQL | Filtro JSON do Prisma é **agnóstico de provider** (mesmo padrão já usado em T02/T06) |
| Legibilidade | O laço `for` pós-`take:1` é inócuo (herdado do upstream); opcional remover, **não obrigatório** |
| Risco | Baixo |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

Linha **byte a byte idêntica** ao `2.4.0-rc2` (`whatsapp.baileys.service.ts:4212`), confirmado por `diff`. Ajuste também de `this.instance.id` → `this.instanceId` para alinhar ao upstream (equivalentes — `instanceId` é getter de `instance.id`).

### 4.2 Por que o filtro antigo falhava

No Prisma, filtrar campo **JSON** exige a forma `path` + `equals`; o atalho `{ key: { remoteJid: number } }` **não** percorre o path do JSON — na prática não casa nenhuma linha (retorno vazio → `NotFoundException('Messages not found')` em `getLastMessage`, ou mensagem incorreta). A forma corrigida (`{ key: { path: ['remoteJid'], equals: number } }`) é a mesma já usada em T02/T06 e é **agnóstica de provider** (Postgres/MySQL).

### 4.3 Consumidores e não-regressão

`getLastMessage` é chamado em **2** pontos: `archiveChat` (:3957) e `markChatUnread` (:3985), ambos quando `data.lastMessage` não é enviado. A correção só faz o filtro retornar a mensagem correta — não altera a assinatura nem o retorno.

### 4.4 Higiene

- `git diff --check` limpo; **1 linha** alterada (1+/1−); a linha tem ~95 chars (≤120).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

### 4.5 Varredura de filtros JSON irmãos (auditado 2026-11-24)

Procurei outros `where` do Prisma que filtrem o campo JSON `key` pelo atalho inválido — **nenhum outro foi encontrado**. Todos usam a forma correta `path` + `equals`:
- `channel.service.ts:626-629` e `:650-653` (`fetchMessages`)
- `chatwoot.service.ts:1550, 1764, 1795, 1851, 1928, 1969, 2011, 2375, 2688`
- `whatsapp.baileys.service.ts:565`
- `whatsapp.business.service.ts:761`

Os demais `key: { ... }` sem `path` **não são filtros** — são objetos de **dados** (payload de `create`/`update`, ex.: `evolution.channel.service.ts:336`, `whatsapp.business.service.ts:1136`) ou **definições de interface/schema** (`chatwoot.service.ts:2095`, `message.schema.ts`). Logo, a T12 cobriu o único ponto afetado.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Ter mensagens numa conversa e chamar `archiveChat` com `archive: true`:
   ```bash
   POST /chat/archiveChat/{instance} { "number": "<jid>", "archive": true }
   ```
   Esperado: arquiva a conversa (usa a última mensagem corretamente).
3. Conferir que não há mais `Messages not found` indevido.

## 6. Rollback

Reverter a linha do `where` para `{ key: { remoteJid: number }, instanceId: this.instance.id }`.
