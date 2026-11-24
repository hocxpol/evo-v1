# T09 — Evolution Channel: instâncias ficam presas em `close`

- **Status:** Planejada
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0-rc2` — PR [#2420](https://github.com/evolution-foundation/evolution-api/pull/2420) (corrige [#2419](https://github.com/evolution-foundation/evolution-api/issues/2419))
- **Arquivos alterados:**
  - `src/api/integrations/channel/evolution/evolution.channel.service.ts`
  - `src/api/services/monitor.service.ts`
  - `src/api/controllers/instance.controller.ts`

## 1. Sintoma

Instâncias do **Evolution Channel** ficam com `connectionStatus = close` e não voltam para `open`, mesmo sendo integração **webhook-only** (passiva — deveria estar sempre `open`). Consequência: endpoints que exigem instância "conectada" (`/instance/logout`, `/instance/restart`, envios) retornam erro; a instância parece "morta" no Manager.

## 2. Causa raiz

Três pontos:

1. `EvolutionStartupService.connectToWhatsapp()` não altera `stateConnection` — só processa o evento (ou `loadChatwoot()`), então nunca promove de `close` → `open`.
2. No boot do monitor, `setInstance()` só autoconecta quando `connectionStatus` é `open`/`connecting`; `EVOLUTION` era ignorado.
3. Na criação da instância (`createInstance`), só o Baileys (`WHATSAPP_BAILEYS`) chamava `connectToWhatsapp()`; `EVOLUTION` não.

## 3. Solução implementada (3 pontos)

### 3.1 `evolution.channel.service.ts` — promover a `open` + persistir

```diff
  public async connectToWhatsapp(data?: any): Promise<any> {
    if (!data) {
+     this.stateConnection = { state: 'open' };
+
+     if (this.instanceId) {
+       await this.prismaRepository.instance.update({
+         where: { id: this.instanceId },
+         data: { connectionStatus: 'open' },
+       });
+     }
+
      this.loadChatwoot();
      return;
    }
    ...
  }
```

### 3.2 `monitor.service.ts` — autoconectar `EVOLUTION` no boot

```diff
   if (
     instanceData.connectionStatus === 'open' ||
-    instanceData.connectionStatus === 'connecting'
+    instanceData.connectionStatus === 'connecting' ||
+    instanceData.integration === Integration.EVOLUTION
   ) {
     this.logger.info(`Auto-connecting instance "${instanceData.instanceName}" (status: ${instanceData.connectionStatus})`);
     await instance.connectToWhatsapp();
   } else {
     ...
   }
```

> `Integration` já é importado em `monitor.service.ts` (`@api/types/wa.types`).

### 3.3 `instance.controller.ts` — conectar na criação (EVOLUTION)

Dentro do bloco `if (!instanceData.chatwootAccountId || ...)`, logo após o trecho do QR do Baileys (~:157):

```diff
      if (instanceData.qrcode && instanceData.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.connectToWhatsapp(instanceData.number);
        await delay(5000);
        getQrcode = instance.qrCode;
      }
+
+     if (instanceData.integration === Integration.EVOLUTION) {
+       await instance.connectToWhatsapp();
+     }
```

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Baileys / Meta / Business | Não afetados (condições específicas por integração) |
| Instâncias EVOLUTION existentes em `close` no banco | Serão promovidas a `open` no próximo boot (comportamento desejado) |
| **Atenção (upstream):** quem usava `close` do Evolution Channel como "gate" manual terá o estado sobrescrito | Documentar; se necessário, usar outro mecanismo de pausa |
| `closeClient()` / `logoutInstance()` | Inalterados; `connectToWhatsapp()` sem `data` restaura `open` |
| Risco | Médio — muda estado persistido; validar em homologação |

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Criar instância `EVOLUTION` → resposta `status: open`.
3. Conferir no banco:
   ```sql
   SELECT name, "connectionStatus", integration FROM "Instance" WHERE integration = 'EVOLUTION';
   ```
   Esperado: `open`.
4. Reiniciar o serviço → instância EVOLUTION volta `open` automaticamente (sem erro no boot).
5. `GET /instance/connectionState/{instance}` → `{ state: 'open' }`.

## 6. Rollback

Reverter os três blocos. O `closeClient()` volta a ser o único a mexer no estado do canal Evolution.
