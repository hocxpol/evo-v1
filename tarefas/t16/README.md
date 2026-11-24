# T16 — Pacote baixo risco: flag IPv6 no boot + alinhamento `everyOne`→`mentionsEveryOne`

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` (changelog: *"Networking: added `--network-family-autoselection-attempt-timeout`…"* e *"`mentionsEveryOne` honours `false` (#2470)"*)
- **Arquivos alterados:**
  - `package.json`
  - `src/validate/message.schema.ts`
- **Simplicidade:** 🟢 muito alta (config + rename) · **Risco:** 🟢 **muito baixo**
- **Ordem:** **1º de 5** (primeira da segunda onda)

## 1. Objetivo

Dois ajustes pequenos e independentes, sem efeito de risco.

### 1.1 Flag IPv6 no boot (`package.json`)

Em hosts com IPv6 quebrado, o `node dist/main` pode **travar no boot** (race IPv4/IPv6). O upstream adiciona uma flag:

```diff
- "start:prod": "node dist/main",
+ "start:prod": "node --network-family-autoselection-attempt-timeout=1000 dist/main",
```

### 1.2 Nome do campo no schema (`message.schema.ts`)

O DTO (`Metadata.mentionsEveryOne`) e o código (`options?.mentionsEveryOne`) já usam `mentionsEveryOne`, mas o **schema** declara `everyOne`. Ajustar o schema ao nome real do campo (o validador `jsonschema` não remove props extras, então hoje "funciona", mas a validação de tipo/enum recai sobre o campo errado):

```diff
- everyOne: { type: 'boolean', enum: [true, false] },
+ mentionsEveryOne: { type: 'boolean', enum: [true, false] },
```

(ocorre em **todas** as ocorrências de `everyOne:` no arquivo — ~9)

## 2. Auditoria — efeitos colaterais

| Ponto | Avaliação |
|---|---|
| Flag IPv6 | Só age em `start:prod` (Docker/produção); sem impacto em ambiente IPv4 saudável |
| `everyOne` no schema | Nenhum código lê `.everyOne` (verificado) → renomear é **seguro** |
| Contrato da API | Alinha o schema ao campo real (`mentionsEveryOne`) já enviado pelos clientes |
| `gifPlayback`/`gifAttribution` (T15) | Já usam o nome correto — não afetados |
| Risco | **Muito baixo** |

> A parte "trailing slashes em URLs" do changelog 2.4.0 mapeia, no upstream, ao suporte a `BASE_URL` do SQS — que **não existe** na nossa versão (nosso `sqs.controller.ts` fixa `https://sqs.<region>.amazonaws.com`). É **feature**, não correção; **fora do escopo**.

### 2.1 Fidelidade ao upstream (auditado 2026-11-24)

- **`start:prod`**: **idêntico** ao `2.4.0-rc2` (`node --network-family-autoselection-attempt-timeout=1000 dist/main`).
- **Schema**: as **9** ocorrências renomeadas para `mentionsEveryOne` batem **linha a linha** com o upstream (`diff` de `message.schema.ts:1-459` → idêntico, exceto uma linha em branco). Confirmação: `grep mentionsEveryOne` nosso == upstream (mesmos números de linha).

### 2.2 Nota sobre o `everyOne` remanescente no upstream

O upstream mantém **1** `everyOne` (`:504`) — mas está dentro do **`carouselMessageSchema`**, um schema **novo do 2.4.0** que **não temos** (é feature, fora de escopo). Para todos os schemas **compartilhados**, o upstream usa `mentionsEveryOne`, que é o que replicamos. Logo, nosso arquivo é consistente com o upstream na porção equivalente.

### 2.3 Higiene

- `git diff --check` limpo. Alterações: `package.json` (1+/1−) e `message.schema.ts` (9+/9−).
- ⚠️ `npm run lint:check && npm run build` **não executados** no ambiente de auditoria — rodar antes do deploy.

## 3. Como validar

1. `npm run lint:check && npm run build`.
2. `npm run start:prod` sobe normalmente (flag aceita pelo Node).
3. Enviar mensagem com `mentionsEveryOne: false` → não menciona todos; com `true` → menciona.

## 4. Rollback

Reverter as duas linhas (flag e `mentionsEveryOne:` → `everyOne:`).
