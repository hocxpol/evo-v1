# T14 — `/instance/logout` deve ser idempotente

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0`
- **Arquivo alterado:** `src/api/controllers/instance.controller.ts`

## 1. Sintoma

O fluxo de **delete** do Manager chama `logout` **antes** de `delete`. Se a instância já estiver desconectada (`close`), o `logout` retorna `400 — "instance is not connected"`, exibindo um erro enganoso na UI ("falha ao remover") mesmo quando a exclusão prossegue.

## 2. Causa raiz

`logout` lança exceção quando o estado já é `close`:

```ts
// :439-441 (versão com bug)
if (instance.state === 'close') {
  throw new BadRequestException('The "' + instanceName + '" instance is not connected');
}
```

## 3. Solução implementada

Tornar idempotente — retornar **SUCCESS** quando já estiver desconectada:

```diff
  public async logout({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });

+   // Idempotente: se já está desconectada, retorna sucesso silenciosamente.
+   // Evita falhar o fluxo de delete do painel, que sempre chama logout antes do delete.
    if (instance.state === 'close') {
-     throw new BadRequestException('The "' + instanceName + '" instance is not connected');
+     return { status: 'SUCCESS', error: false, response: { message: 'Instance was already disconnected' } };
    }

    try {
      await this.waMonitor.waInstances[instanceName]?.logoutInstance();
      return { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } };
    } catch (error) {
      throw new InternalServerErrorException(error.toString());
    }
  }
```

> Esta fase também **desbloqueia a T09** parcialmente: com o Evolution Channel sempre `open` (T09), o `logout` deixa de falhar; e com T14, mesmo se estiver `close`, retorna SUCCESS.

## 4. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Contrato HTTP | Muda de `400` para `200 SUCCESS` no caso "já desconectada" — **é o comportamento desejado** |
| `deleteInstance` | Passa a não receber exceção do `logout` nesse caso |
| Chamada direta `POST /instance/logout` em instância `close` | Retorna `200` em vez de `400` |
| Risco | Baixo |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)

O bloco `logout` é **byte a byte idêntico** ao do `2.4.0-rc2` (incluídos os 2 comentários), confirmado por `diff`.

### 4.2 Status HTTP e fluxo

- A rota `DELETE /instance/logout/:instance` responde com `HttpStatus.OK` (`instance.router.ts:86`) → o retorno `SUCCESS` sai como **200**.
- **`deleteInstance`** (`:467`) só chama `logout` quando `instance.state` é `connecting`/`open`; nesse caso o comportamento é inalterado. A idempotência cobre o chamado direto (rota) e o fluxo do painel que chama `logout` antes de `delete` com a instância já `close`.

### 4.3 Fora de escopo (relacionado, não incluído)

O `deleteInstance` do upstream envolve o `logout` num `try/catch` interno (log de "Connection Closed" e seguimento do `remove.instance`) — é o PR **#2520**, item **separado** (na lista de "verificar" do plano). **Não** faz parte da T14; aqui o `deleteInstance` permanece igual ao 2.3.7.

O `restartInstance` **continua** lançando `BadRequestException` quando `state === 'close'` (`:362`) — é **intencional**: o próprio `2.4.0-rc2` manteve assim. A idempotência aplica-se **apenas** ao `logout`. Os outros 17 usos de `BadRequestException` no arquivo permanecem (import não fica órfão).

### 4.4 Não-regressão

Para instâncias `open`/`connecting`, o `logout` continua exatamente como antes (chama `logoutInstance()` no `try` e pode lançar `InternalServerErrorException`). Apenas o ramo `close` mudou de `throw` para `return`.

### 4.5 Higiene

- `git diff --check` limpo; alterações: 2 comentários + 1 linha trocada (`throw` → `return`) = 3+/1−.
- Linha do `return` tem ~110 chars (≤120).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

## 5. Como validar

1. `npm run lint:check && npm run build`.
2. Chamar `logout` duas vezes seguidas na mesma instância:
   ```bash
   DELETE /instance/logout/{instance}   # 1ª: SUCCESS
   DELETE /instance/logout/{instance}   # 2ª: SUCCESS (antes era 400)
   ```
3. No Manager: excluir uma instância já desconectada → sem erro "not connected".

## 6. Rollback

Reverter para o `throw new BadRequestException('The "' + instanceName + '" instance is not connected')`.
