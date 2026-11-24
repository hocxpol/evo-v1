# T11 — API de instância: nome com espaços causa `404`

- **Status:** Planejada
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0-rc2` — PR [#2546](https://github.com/evolution-foundation/evolution-api/pull/2546) (corrige [#2543](https://github.com/evolution-foundation/evolution-api/issues/2543))
- **Arquivo alterado:** `src/api/controllers/instance.controller.ts`

## 1. Sintoma

Criar instância com **espaços no início/fim** do nome (ex.: `"Minha Instancia "`) persiste o nome com os espaços no banco. Ao chamar a instância pela URL (`DELETE /instance/delete/:name`, `GET /instance/connectionState/:name`), os espaços são normalizados no path, gerando **`404` — "The ... instance does not exist"** por *mismatch* de nome.

## 2. Causa raiz

`createInstance` persiste `instanceData.instanceName` **sem trim**. O nome com espaços vai ao banco e ao `waMonitor.waInstances[...]`, mas o path HTTP chega sem os espaços → o `instanceExistsGuard` (`instance.guard.ts`) não encontra a instância.

## 3. Solução implementada

Trimar o nome logo no início do `createInstance`:

```diff
  public async createInstance(instanceData: InstanceDto) {
    try {
+     instanceData.instanceName = instanceData.instanceName?.trim();
+
      const instance = channelController.init(instanceData, {
        ...
```

Assim o nome é trimado **antes** de: gerar `hash`, `waMonitor.saveInstance(...)`, `instance.setInstance(...)`, `waMonitor.waInstances[...]` e o registro no cache — tudo passa a usar o nome normalizado.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Nomes sem espaços | Inalterados |
| Nomes com espaços **internos** (ex.: `"Minha Instancia"`) | **Não** são alterados (só `trim` nas bordas) — permanecem válidos, pois a URL os codifica corretamente |
| `instanceSchema` | Continua aceitando `type: string`; sem quebra de contrato |
| Outros pontos que criam instância | `waMonitor.saveInstance` é chamado **depois** do trim (usa o nome já normalizado) |
| Risco | Baixo |

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Criar instância com espaços nas bordas:
   ```bash
   POST /instance/create  { "instanceName": "  Minha Instancia  ", "integration": "WHATSAPP-BAILEYS", ... }
   ```
3. Conferir no banco/response: `instanceName` = `"Minha Instancia"` (sem espaços nas bordas).
4. `GET /instance/connectionState/Minha%20Instancia` → **200** (não 404).
5. Regressão: nome sem espaços continua funcionando.

## 6. Rollback

Remover a linha `instanceData.instanceName = instanceData.instanceName?.trim();`.
