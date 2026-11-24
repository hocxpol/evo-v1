# T12 — `getLastMessage`: filtro JSON do Prisma retorna a mensagem errada

- **Status:** Planejada
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
