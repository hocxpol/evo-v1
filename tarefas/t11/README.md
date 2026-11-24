# T11 — API de instância: nome com espaços causa `404`

- **Status:** Concluída
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

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

A linha é **byte a byte idêntica** à do `2.4.0-rc2` (`instance.controller.ts:39`), confirmado por `diff` (indentação inclusive).

### 4.2 Ordem de uso (garantia do efeito)

O trim ocorre na primeira linha do `try`, **antes** de todos os usos do nome: `saveInstance` (:67), `instance.setInstance` (:78), chave `waMonitor.waInstances[...]` (:86), `eventManager.setInstance` (:90), webhook (:93) e `nameInbox`/webhook Chatwoot (:304-305). Logo, tudo usa o nome já normalizado.

**Ponto único de criação:** há apenas um `createInstance` (o do controller) e `waMonitor.saveInstance` é chamado **somente** ali (`instance.controller.ts:64`) — não existe outro caminho de criação que também precise do trim.

### 4.3 Edge case / risco residual (aceito, igual ao upstream)

O `instanceLoggedGuard` roda **antes** do controller e checa duplicidade com o nome **não trimado** (`instance.guard.ts:45`). Cenário `" X "` quando já existe `"X"`:
- o guard **passa** (não encontra `" X "`);
- o trim converte para `"X"` → `saveInstance` → **violação do `@unique` de `Instance.name`** (`prisma/postgresql-schema.prisma`: `name ... @unique`);
- o `catch` externo do `createInstance` (`:308-312`) converte em `BadRequestException` (400, com a mensagem do Prisma) e chama `this.waMonitor.deleteInstance(...)`.

Ou seja: o caso "duplicado por espaços" retorna 400 (não o 403 amigável do guard). **É o comportamento do upstream** (o #2546 só trimou no controller) — não é regressão do fluxo principal (criar uma instância com espaços nas bordas agora funciona).

**Cenário "só espaços":** um nome `"   "` passa na validação (`isNotEmpty` → `minLength: 1`; 3 espaços = ok) e o trim o reduz a `""` → instância com nome vazio (URL nunca casa → 404). Antes do trim o problema era equivalente (nome com espaços), então **não é regressão**; o upstream também não bloqueia esse caso.

### 4.4 Higiene

- `git diff --check` limpo; **1 linha** adicionada; ~62 chars (≤120).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

### 4.5 Hardening opcional (não implementado)

Para eliminar os dois edge cases acima (duplicado por espaços e "só espaços"), seria preciso **desviar do upstream**:
1. trimar também no `instanceLoggedGuard` (antes de checar duplicidade); e
2. rejeitar nome vazio após o trim (`BadRequestException`).

Não implementado — mantida a paridade com o #2546.

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
