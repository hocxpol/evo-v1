# T19 — `deleteInstance`: instância "zumbi" quando o `logout` falha (#2520)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — PR [#2520](https://github.com/evolution-foundation/evolution-api/pull/2520) (relacionado: *"remove.instance event emitted even when logout fails"*)
- **Arquivo alterado:** `src/api/controllers/instance.controller.ts`
- **Simplicidade:** 🟢 alta (drop-in) · **Risco:** 🟢 baixo
- **Ordem:** **4º de 5**

## 1. Sintoma

Ao excluir uma instância cujo socket Baileys já morreu (mas cujo objeto ainda existe em `waMonitor.waInstances`), o `logoutInstance()` lança "Connection Closed". O `deleteInstance` não captura esse erro → **aborta antes do `remove.instance`**, deixando a instância "zumbi" em memória (some só com restart do processo).

## 2. Causa raiz

O `logout` é chamado **sem** `try/catch` dentro do `deleteInstance`:

```ts
// deleteInstance (~:466)
if (instance.state === 'connecting' || instance.state === 'open') {
  await this.logout({ instanceName });   // se lançar, aborta o delete
}
...
this.eventEmitter.emit('remove.instance', instanceName, 'inner'); // não executa
```

## 3. Solução implementada

Envolver o `logout` num `try/catch` e **prosseguir** com a limpeza:

```diff
  if (instance.state === 'connecting' || instance.state === 'open') {
-   await this.logout({ instanceName });
+   try {
+     await this.logout({ instanceName });
+   } catch (error) {
+     // logout can throw "Connection Closed" when the underlying Baileys
+     // socket is already dead but waInstances[name] still exists. We
+     // must continue to the remove.instance emit below — that is the
+     // only path that purges the in-memory entry and runs cleaningUp().
+     // Without this catch, the stale entry persists until the entire
+     // process restarts.
+     this.logger.warn({
+       message: 'logout failed during deleteInstance — proceeding with cleanup',
+       instanceName,
+       error,
+     });
+   }
  }
```

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Fluxo normal (logout OK) | Inalterado |
| Logout que falha | Antes: abortava (instância zumbi). Depois: loga `warn` e segue para `remove.instance` (`cleaningUp()`/limpeza) |
| `remove.instance` | Passa a ser emitido mesmo com falha no logout, evitando zumbis |
| `throw new BadRequestException` externo | Mantido para outros erros |
| Risco | Baixo — só adiciona robustez; nenhum caminho de sucesso muda |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

O método `deleteInstance` inteiro é **byte a byte idêntico** ao `2.4.0-rc2` (mesma linha de início `:460`, confirmado por `diff`), incluindo o `try/catch` e o `logger.warn`.

### 4.2 Não-regressão

- Fluxo normal (logout OK) inalterado.
- O `catch` externo (`BadRequestException`) e o `try/catch` do `sendDataWebhook` continuam intactos.
- `remove.instance` passa a ser emitido mesmo com falha no logout (elimina zumbis).

### 4.3 Higiene

- `git diff --check` limpo; `instance.controller.ts` com **15+/1−** (bloco de `try/catch`).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Simular socket morto (instância `open` mas conexão caída) e excluir → a instância deve ser removida (sem zumbi) e o log mostrar o `warn`.
3. Regressão: excluir instância saudável continua funcionando.

## 6. Rollback

Reverter para `await this.logout({ instanceName });` sem o `try/catch`.
