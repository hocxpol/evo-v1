# T15 — WhatsApp: GIF nativo (sem conversão para vídeo)

- **Status:** Planejada
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0-rc2` — PR [#2540](https://github.com/evolution-foundation/evolution-api/pull/2540)
- **Arquivos alterados:**
  - `src/api/dto/sendMessage.dto.ts`
  - `src/validate/message.schema.ts`
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

## 1. Sintoma / objetivo

Não é um bug, e sim uma **feature backward-compatible**: permitir enviar GIF nativo (`gifPlayback`), informando a origem do GIF (`gifAttribution`), sem forçar conversão para vídeo. Hoje o `gifPlayback` é **fixado em `false`** para vídeos.

## 2. Causa raiz / estado atual

No `prepareMedia` do envio de mídia, o GIF é sempre desabilitado:

```ts
// whatsapp.baileys.service.ts (~:3117)
if (mediaMessage.mediatype === 'video') {
  prepareMedia[mediaType].gifPlayback = false;
}
```

E o DTO/schema não expõem os campos.

## 3. Solução implementada

### 3.1 DTO (`sendMessage.dto.ts`) — `MediaMessage` e `SendMediaDto`

```diff
  export class MediaMessage {
    mediatype: MediaType;
    mimetype?: string;
    caption?: string;
    fileName?: string;
    media: string;
+   gifPlayback?: boolean | string;
+   gifAttribution?: number | string;
  }
```

```diff
  export class SendMediaDto extends Metadata {
    mediatype: MediaType;
    mimetype?: string;
    caption?: string;
    fileName?: string;
    media: string;
+   gifPlayback?: boolean | string;
+   gifAttribution?: number | string;
  }
```

### 3.2 Schema (`message.schema.ts`) — `mediaMessageSchema`

```diff
    fileName: { type: 'string' },
    caption: { type: 'string' },
+   gifPlayback: {
+     oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false'] }],
+   },
+   gifAttribution: {
+     oneOf: [
+       { type: 'integer', enum: [0, 1, 2] },
+       { type: 'string', enum: ['0', '1', '2'] },
+     ],
+   },
    delay: { type: 'integer', description: 'Enter a value in milliseconds' },
```

### 3.3 Baileys (`whatsapp.baileys.service.ts`) — usar os valores

```diff
  if (mediaMessage.mediatype === 'video') {
-   prepareMedia[mediaType].gifPlayback = false;
+   prepareMedia[mediaType].gifPlayback = mediaMessage.gifPlayback === true || mediaMessage.gifPlayback === 'true';
+
+   if (mediaMessage.gifAttribution !== undefined) {
+     const gifAttribution = Number(mediaMessage.gifAttribution);
+     if (gifAttribution === 0 || gifAttribution === 1 || gifAttribution === 2) {
+       prepareMedia[mediaType].gifAttribution = gifAttribution;
+     }
+   }
  }
```

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Backward-compat | **Preservada** — sem `gifPlayback`, o default continua `false` (`=== true` é falso) |
| Tipos aceitos | `boolean` **ou** string `'true'`/`'false'` (alguns clientes enviam string) |
| `gifAttribution` | Aceita `0/1/2` (número ou string); valores fora do range são ignorados |
| Canais Meta/Evolution | Não usam esses campos (mantêm `gifPlayback: false`) — não afetados |
| Risco | Médio (toca o preparo de mídia) — validar envio normal de vídeo |

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Enviar vídeo **normal** (sem campos) → comportamento atual (não-GIF).
3. Enviar com GIF nativo:
   ```bash
   POST /message/sendMedia/{instance}
   { "number":"<jid>", "mediatype":"video", "media":"<url>", "gifPlayback": true, "gifAttribution": 1 }
   ```
   Esperado: o vídeo roda como GIF no WhatsApp.
4. Enviar `gifPlayback: "true"` (string) → mesmo efeito.
5. `gifAttribution: 9` → ignorado (sem erro).

## 6. Rollback

Reverter os três arquivos. O `gifPlayback` volta a ser fixado em `false`.
