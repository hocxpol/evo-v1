# T26b — Webhook Meta: ACK já assíncrono + tratamento de erros no background

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** robustez derivada da auditoria da T26 (não é porte do upstream)
- **Arquivo:** `src/api/integrations/channel/meta/meta.controller.ts`
- **Linhas (~):** **20**
- **Risco:** 🟢 baixo · **Importância:** 🟡 média (evita crash por unhandled rejection no Cloud API)

## 1. Contexto — correção de um diagnóstico anterior
Na auditoria da **T26** eu apontei risco de "webhook Meta síncrono" (latência). **Reavaliando o código:** o `receiveWebhook` processa com `data.entry?.forEach(async (entry) => { … await connectToWhatsapp … })`. **`Array.forEach` NÃO aguarda** callbacks async — logo `receiveWebhook` retorna `{status:'success'}` **imediatamente** e a rota (`meta.router:17`) responde rápido. **O risco de latência NÃO se aplica** (o `await connectToWhatsapp` só ordena o processamento em background).

## 2. Risco real encontrado
Ainda no mesmo padrão, as promessas do `forEach(async…)` são **flutuantes e sem `catch`**: se `connectToWhatsapp` lançar (ex.: `createJid` com payload malformado, ou `prisma...findFirst` com DB indisponível), vira **unhandled rejection** — que, no Node atual, pode **derrubar o processo**.

## 3. Solução implementada
Manter o ACK rápido (fire-and-forget) e **capturar erros** de cada entry:

```diff
-      data.entry?.forEach(async (entry: any) => {
+      data.entry?.forEach((entry: any) => {
+        void (async () => {
          ... // número, instância
          await this.waMonitor.waInstances[instance.name].connectToWhatsapp(data);
-        return { status: 'success' };
+        })().catch((error) => {
+          this.logger.error('WebhookService -> receiveWebhookMeta -> processing error');
+          this.logger.error(error);
+        });
      });
```

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| ACK ao Meta | **Continua imediato** (`forEach` não aguarda; processamento em background) |
| Erros no background | Passam a ser **logados** (`catch`) → **sem unhandled rejection** |
| Ordem/negócio | Inalterada (mesmo processamento: Chatwoot→webhook→bot, via T26) |
| Escopo | Só Cloud API (`meta.controller`); Baileys/Evolution inalterados |

> **Observação (pré-existente, fora de escopo):** `connectToWhatsapp(data)` sempre processa `data.entry[0]`, mesmo dentro do `forEach` sobre `entry`. Para webhooks com múltiplos entries, `entry[0]` é reprocessado. Corrigir exigiria passar `entry` à função — **não** alterado nesta fase.

## 5. Como validar
1. `npm run lint:check && npm run build` (validado: exit 0 / Build success).
2. Instância **Cloud API** recebendo mensagem → processa em background; resposta do webhook é imediata.
3. Simular erro (ex.: derrubar DB) → log `processing error`, **sem** crash do processo.

## 6. Rollback
Reverter para `data.entry?.forEach(async (entry) => { … })` (volta ao risco de unhandled rejection).