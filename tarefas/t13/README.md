# T13 — List messages: clonagem JSON destrutiva quebra campos `Long` (`this.isZero`)

- **Status:** Concluída
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

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

**Helper** (`whatsapp.baileys.service.ts:228-232`) e **método** (`:906-910`) são **byte a byte idênticos** ao `2.4.0-rc2` (`:233-237` e `:786-790`), confirmado por `diff`.

### 4.2 Semântica da transformação

A diferença essencial é remover o `JSON.parse(JSON.stringify(message))`:
- **Antes:** `message` era substituído por um **deep clone serializado** e só então o `listType` era trocado — a serialização convertia campos `Long` do protobuf em objetos simples, quebrando métodos como `isZero`.
- **Depois:** `normalizeListType()` apenas **muta** `listMessage.listType` no mesmo objeto aninhado (`deviceSentMessage?.message?.listMessage` e `listMessage`).

Resultado funcional é **o mesmo** (troca `PRODUCT_LIST` → `SINGLE_SELECT`), sem o efeito colateral de serialização.

### 4.3 Varredura de clones destrutivos

Busca por `JSON.parse(JSON.stringify` no arquivo: resta **apenas** `:314` (`data.creds` com `BufferJSON.reviver`) — que é **correto** e não está no caminho de envio. Nenhum outro clone destrutivo em `patchMessageBeforeSending` ou no envio de mídia/list.

### 4.4 Não-regressão

Para mensagens que **não** são `PRODUCT_LIST`, as duas chamadas a `normalizeListType` são *no-op* (a condição não casa) — comportamento idêntico ao anterior.

### 4.5 Higiene

- `git diff --check` limpo. Alterações no arquivo: helper (+5 linhas) e método (bloco de 17 → 5 linhas).
- Nenhuma linha >120 introduzida (as longas pré-existentes ficam fora das regiões alteradas).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

### 4.6 Fiação do hook e nuance in-place vs clone

- **Fiação:** `patchMessageBeforeSending` (`:906`) faz parte do `socketConfig` (`:867`) passado a `makeWASocket(socketConfig)` (`:916`) — hook correto, chamado pelo Baileys antes de cada envio.
- **Quem gera `PRODUCT_LIST`:** `listMessage()` monta `listMessage: { …, listType: 2 }` (`:3677`; 2 = `PRODUCT_LIST`). O hook o normaliza para `SINGLE_SELECT` (comportamento intencional — o WhatsApp não aceita mais `PRODUCT_LIST`). O patch antigo e o novo fazem a **mesma** troca; o que muda é o *como*.
- **Nuance (in-place vs clone):** o código antigo **não** mutava o objeto recebido (devolvia um clone); o novo **muta in-place** o objeto de envio. Para o que vai no fio, o resultado é idêntico; a diferença é que, se a mensagem enviada for persistida/emitida, ela agora reflete o `listType` já normalizado (arguavelmente mais correto). É exatamente a escolha do upstream (#2461).
- **Escopo do fix:** `normalizeListType` existe **apenas** neste arquivo (verificado no upstream) — não há outras correções correlatas a portar.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Enviar `sendList` (`single_select`) → deve funcionar como antes.
3. Enviar list do tipo `PRODUCT_LIST` (catálogo) → esperado: **sem** `this.isZero`, com `listType` reescrito.
4. Conferir logs sem erro de serialização.

## 6. Rollback

Reintroduzir o bloco original com `JSON.parse(JSON.stringify(...))` e remover o helper.
