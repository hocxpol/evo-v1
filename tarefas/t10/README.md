# T10 — WhatsApp: áudio com `quoted` não é enviado como resposta encadeada

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0-rc2` — PR [#2516](https://github.com/evolution-foundation/evolution-api/pull/2516) (corrige [#2485](https://github.com/evolution-foundation/evolution-api/issues/2485))
- **Arquivo alterado:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

## 1. Sintoma

Ao enviar **áudio** (`/message/sendWhatsAppAudio`) com o campo `quoted` (resposta a uma mensagem), o áudio chega como **mensagem solta**, sem citar a mensagem original. Os demais tipos (texto, imagem, vídeo, documento) citam corretamente.

## 2. Causa raiz

`audioWhatsapp()` monta as opções de envio **sem** repassar `quoted` (e `quoted` existe em `Metadata`, do qual `SendAudioDto` herda):

```ts
// audioWhatsapp (~:3460 e ~:3473)
{ presence: 'recording', delay: data?.delay },
```

Comparado aos outros métodos, que fazem:

```ts
{ ..., quoted: data?.quoted },
```

## 3. Solução implementada

Adicionar `quoted: data?.quoted` nos **dois** caminhos (encoded e direct):

```diff
  const result = this.sendMessageWithTyping<AnyMessageContent>(
    data.number,
    { audio: convert, ptt: true, mimetype: 'audio/ogg; codecs=opus' },
-   { presence: 'recording', delay: data?.delay },
+   { presence: 'recording', delay: data?.delay, quoted: data?.quoted },
    isIntegration,
  );
```

```diff
  return await this.sendMessageWithTyping<AnyMessageContent>(
    data.number,
    { audio: ..., ptt: true, mimetype: 'audio/ogg; codecs=opus' },
-   { presence: 'recording', delay: data?.delay },
+   { presence: 'recording', delay: data?.delay, quoted: data?.quoted },
    isIntegration,
  );
```

> **Nota:** a 2.4.0-rc2 também injeta `seconds`/`waveform` via `getAudioMetadata()` no áudio. Isso é **outro** PR (não é o #2516). Não incluir nesta fase — se quiser, tratar em fase separada.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Áudio **sem** `quoted` | `quoted: undefined` → comportamento idêntico ao atual |
| Caminho `encoding: true` (convertido) e direct | Ambos ajustados (paridade com upstream) |
| Formato do payload `quoted` | Mesmo tipo `Quoted` já usado pelos demais envios |
| Risco | Baixo — 1 campo aditivo |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

As duas linhas de opções são **byte a byte idênticas** ao `2.4.0-rc2` (confirmado por `diff`):
- caminho `encoded` → upstream `:3572`
- caminho `direct` → upstream `:3598`

### 4.2 Escopo

Há exatamente **2** ocorrências de `presence: 'recording'` no arquivo, ambas dentro de `audioWhatsapp` (os dois caminhos). Ambas foram alteradas; nenhum outro método de envio foi tocado.

### 4.3 Efeitos colaterais e riscos residuais

| Ponto | Avaliação |
|---|---|
| Validação de número | `sendMessageWithTyping` já valida antes (guarda do T08) — `quoted` não interfere |
| Interpolação/assinatura | Nenhuma; `quoted` é apenas encaminhado ao Baileys |
| `getAudioMetadata` (`seconds`/`waveform`) | **Não** incluído (é outro PR, não o #2516) — o áudio continua sem esses metadados, como antes |
| Caminho `encoding: false` | Também ajustado |

### 4.4 Higiene

- `git diff --check` limpo; **2 linhas** alteradas (2+/2−) no arquivo.
- Comprimento: 76 chars (ambas ≤120).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

### 4.5 Cobertura ponta a ponta (auditado 2026-11-24)

Confirmado que o `quoted` **não é descartado** em nenhuma camada — o fix funciona de fato, não apenas compila:

| Camada | Verificação |
|---|---|
| Rota | `sendWhatsAppAudio` usa `audioMessageSchema` (`sendMessage.router.ts:88-96`) |
| **Schema** | `audioMessageSchema` **inclui** `quoted: { ...quotedOptionsSchema }` (`message.schema.ts:161`) → não é removido na validação |
| Controller | `sendWhatsAppAudio(instance, bodyData, file)` → `audioWhatsapp(data, file)` (`sendMessage.controller.ts:67-70`) |
| DTO | `SendAudioDto extends Metadata`, com `quoted?: Quoted` (`sendMessage.dto.ts:42`) |
| Método | repassa `quoted: data?.quoted` (esta fase) |
| `sendMessageWithTyping` | resolve `options.quoted` — usa `m.message` ou busca por `m.key` (`whatsapp.baileys.service.ts:2581-2589`) |

**Consistência:** mesmo padrão dos demais envios de mídia (imagem/vídeo/documento), que já repassavam `quoted` — só o áudio faltava.

**Ressalva (pré-existente, não introduzida pela T10):** em `multipart/form-data` o `quoted` chega como *string* (vale para todos os endpoints de mídia); envie via **JSON** para a citação correta.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Enviar áudio com `quoted` (copiando `key`/`message` de uma mensagem existente):
   ```bash
   POST /message/sendWhatsAppAudio/{instance}
   {
     "number": "<jid>",
     "audio": "<url-ou-base64>",
     "quoted": { "key": { ... }, "message": { ... } }
   }
   ```
   Esperado: no WhatsApp, o áudio aparece **citando** a mensagem original.
3. Testar com `encoding: true` e `encoding: false`.

## 6. Rollback

Remover `quoted: data?.quoted` das duas chamadas.
