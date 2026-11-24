# T13 — List messages: clonagem JSON destrutiva quebra campos `Long` (`this.isZero`)

- **Status:** Planejada
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — PR [#2461](https://github.com/evolution-foundation/evolution-api/pull/2461)
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

## 1. Sintoma

Ao enviar **list messages** (Product List / catálogo), o envio falha com `this.isZero is not a function` (ou erro equivalente ao serializar o payload). Ocorre porque a mensagem contém campos tipados `Long` do protobuf.

## 2. Causa raiz

O `patchMessageBeforeSending` do socket Baileys usa `JSON.parse(JSON.stringify(message))` para "reescrever" o `listType`. A serialização JSON **converte os `Long` em strings/objetos** e **quebra** os métodos do protobuf (`isZero`, etc.):

```ts
// :900-916 (versão com bug)
patchMessageBeforeSending(message) {
  if (message.deviceSentMessage?.message?.listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST) {
    message = JSON.parse(JSON.stringify(message));
    message.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
  }
  if (message.listMessage?.listType == proto.Message.ListMessage.ListType.PRODUCT_LIST) {
    message = JSON.parse(JSON.stringify(message));
    message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
  }
  return message;
},
```

## 3. Solução implementada

Extrair um helper que **muta in-place**, sem serializar:

```diff
+function normalizeListType(listMessage?: proto.Message.IListMessage | null): void {
+  if (listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST) {
+    listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
+  }
+}
+
 export class BaileysStartupService extends ChannelStartupService {
```

E substituir o corpo do método:

```diff
  patchMessageBeforeSending(message) {
-   if (message.deviceSentMessage?.message?.listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST) {
-     message = JSON.parse(JSON.stringify(message));
-     message.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
-   }
-   if (message.listMessage?.listType == proto.Message.ListMessage.ListType.PRODUCT_LIST) {
-     message = JSON.parse(JSON.stringify(message));
-     message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
-   }
+   normalizeListType(message.deviceSentMessage?.message?.listMessage);
+   normalizeListType(message.listMessage);
    return message;
  },
```

> Inserir `normalizeListType` logo **antes** de `export class BaileysStartupService` (o arquivo já importa `proto` de `baileys`).

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Comportamento funcional | **Idêntico** — só troca `listType` de `PRODUCT_LIST` → `SINGLE_SELECT` nos mesmos casos |
| Campos `Long` | Deixam de ser serializados/deserializados → não quebram mais |
| Outros tipos de mensagem | Não entram nas condições → inalterados |
| Teste de regressão | Enviar list/single-select e product list (catálogo) |
| Risco | Médio (mexe no caminho de envio de list) — validar em homologação |

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Enviar `sendList` (`single_select`) → deve funcionar como antes.
3. Enviar list do tipo `PRODUCT_LIST` (catálogo) → esperado: **sem** `this.isZero`, com `listType` reescrito.
4. Conferir logs sem erro de serialização.

## 6. Rollback

Reintroduzir o bloco original com `JSON.parse(JSON.stringify(...))` e remover o helper.
