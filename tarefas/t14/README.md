# T14 — `/instance/logout` deve ser idempotente

- **Status:** Planejada
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
