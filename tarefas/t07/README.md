# T07 — Baileys: instância para de receber (stanzas `<status>` sem ack)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portada da Evolution API `2.3.8` (upstream) — commits `2f06ff24` (*ack incoming status stanzas*) e `821d511b` (*keep the offline queue running when a status ack fails*), merge PR [#2805](https://github.com/evolution-foundation/evolution-api/pull/2805)
- **Arquivos alterados/adicionados:**
  - `scripts/patch-baileys-status-ack.js` *(novo)*
  - `package.json` (`postinstall`)
  - `Dockerfile.metrics` (correção do local de aplicação do patch)
- **Tarefas relacionadas:** T06 (edição de mensagens — usa o outro patch de baileys, `scripts/patch-baileys-message-secret.js`)

## 1. Sintoma

Instâncias ficam com status `open` e continuam **enviando** mensagens, mas param de **receber** (ou recebem com horas de atraso). Observado também como queda de conexão com `stream errored out` (`ack class="status"`) a cada ~50 minutos. As mensagens retidas só chegam depois de nova leitura de QR ou de atualizar o serviço.

## 2. Causa raiz

O WhatsApp passou a enviar stanzas de topo `CB:status` (atualizações de status de contatos) pelo socket. O Baileys `7.0.0-rc.9` **não** registra handler para `CB:status`, então esses stanzas nunca são reconhecidos (*ack*). A fila de processamento de nós offline não tem `catch`: um erro de ack em `status` tende a travar o loop para aquele socket.

Código publicado do baileys (`node_modules/baileys/lib/Socket/messages-recv.js`, rc.9) — sem o handler:

```js
        finally {
            await sendMessageAck(node);
        }
    };
    const handleNotification = async (node) => {
```

## 3. Solução implementada

O pacote npm publica `lib/**` já compilado, então a correção não pode ser feita em TypeScript. Seguindo o padrão do fork (script de postinstall idempotente e *fail-soft*, como o de `messageSecret`), foi adicionado `scripts/patch-baileys-status-ack.js`, que reescreve o arquivo compilado com três transformações — **idênticas** ao patch oficial da 2.3.8:

1. define `handleStatus` (com `try/catch` para nunca derrubar a fila offline) antes de `handleNotification`;
2. registra `['status', handleStatus]` no `nodeProcessorMap` da fila offline;
3. registra o listener `ws.on('CB:status', …)`.

Diff equivalente (patch oficial 2.3.8):

```diff
@@ -911,6 +911,15 @@
             await sendMessageAck(node);
         }
     };
+    const handleStatus = async (node) => {
+        // The offline queue loop has no catch: a throw here would stall it for this socket
+        try {
+            await sendMessageAck(node);
+        }
+        catch (error) {
+            onUnexpectedError(error, 'acking status');
+        }
+    };
     const handleNotification = async (node) => {
@@ -1171,7 +1180,8 @@
             ['call', handleCall],
             ['receipt', handleReceipt],
-            ['notification', handleNotification]
+            ['notification', handleNotification],
+            ['status', handleStatus]
         ]);
@@ -1220,6 +1230,9 @@
     ws.on('CB:notification', async (node) => {
         await processNode('notification', node, 'handling notification', handleNotification);
     });
+    ws.on('CB:status', async (node) => {
+        await processNode('status', node, 'handling status', handleStatus);
+    });
```

`postinstall` passa a encadear os dois patches (o do `messageSecret` e o de status), já que tocam arquivos diferentes e não conflitam:

```json
"postinstall": "node scripts/patch-baileys-message-secret.js && node scripts/patch-baileys-status-ack.js"
```

### Correção adicional: `Dockerfile.metrics`

O `Dockerfile.metrics` aplicava o patch na stage `base`, mas a stage `final` só copia `dist` — e o baileys é `external` no `tsup` (não é embutido no bundle). Logo, o patch em `node_modules/baileys` nunca chegava à imagem final (bug pré-existente, que também afetava o patch do `messageSecret`). Os patches foram movidos para a stage `final`, onde o `node_modules` persiste. Como os scripts são idempotentes, é seguro mesmo se a imagem base já vier patchada.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| `handleStatus` processa conteúdo? | **Não** — apenas faz `sendMessageAck`. Não emite eventos nem cria mensagens, então não há novos webhooks/eventos. |
| Fluxos existentes (`message`/`call`/`receipt`/`notification`) | Inalterados; adiciona-se apenas a entrada `status`. |
| `onUnexpectedError` / `sendMessageAck` em escopo | Sim (import/definição no próprio arquivo, rc.9). |
| Conflito com o patch de `messageSecret` (T06) | Nenhum — arquivos distintos (`messages-recv.js` vs `decode-wa-message.js`). |
| Idempotência / *fail-soft* | Reexecução detecta `already patched`; se os anchors mudarem, apenas loga aviso e não quebra `npm install`. |
| Aplicação parcial | Impossível: o `patchSource` só grava se os **três** anchors forem encontrados (*all-or-nothing*). |
| Risco de upgrade do baileys | O script é pinado para `7.0.0-rc.9`; versões futuras exigem regenerar/atualizar o script. |

## 5. Como validar

1. Instalação limpa: `rm -rf node_modules && npm ci` (ou `npm install`).
   - Esperado nos logs: `[patch-baileys] applied status ack fix: baileys/lib/Socket/messages-recv.js`.
2. Conferir o arquivo patchado:

```bash
grep -n "handleStatus\|CB:status\|'status', handleStatus" \
  node_modules/baileys/lib/Socket/messages-recv.js
```

3. Reexecutar o script: deve logar `already patched` (idempotência):

```bash
node scripts/patch-baileys-status-ack.js
```

4. Auto-teste da transformação (não toca no filesystem):

```bash
node scripts/patch-baileys-status-ack.js --self-test
```

Deve imprimir 6 linhas `self-test ok` e sair com código `0`.

5. **Modo estrito (opcional, para CI):** o `postinstall` é *fail-soft* por padrão (nunca quebra o install). Para o CI falhar quando o fix **não estiver presente** — nem aplicado, nem já detectado (ex.: após upgrade/renomeação do baileys) — use `--strict` (sai com código `1`):

```bash
node scripts/patch-baileys-status-ack.js --strict
```

Já está ligado no `.github/workflows/check_code_quality.yml` (passo *Verify Baileys patches applied*), que roda ambos os scripts (`message-secret` e `status-ack`) com `--strict` logo após o `npm ci`.

6. Build/lint: `npm run lint:check && npm run build`.
7. Em runtime: instância conectada deve continuar recebendo mensagens após longos períodos e não cair com `stream errored out (class="status")`.

## 6. Rollback

- Remover `node scripts/patch-baileys-status-ack.js` do `postinstall` no `package.json`.
- (Opcional) remover `scripts/patch-baileys-status-ack.js` e reverter o `Dockerfile.metrics`.
- Reaplicar `node_modules`: `rm -rf node_modules && npm install`.
- Reverter a correção do `Dockerfile.metrics` só se quiser manter o comportamento anterior (não recomendado: a imagem de métricas ficaria sem nenhum patch do baileys).
