# T25 — Build: `NODE_OPTIONS=--max-old-space-size=2048` no Dockerfile

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0`
- **Arquivo:** `Dockerfile`
- **Linhas (~):** **1**
- **Ordem:** 5/8 · **Simplicidade:** 🟢 trivial · **Risco:** 🟢 muito baixo · **Importância:** 🟢 baixa

## 1. Objetivo
Evitar **OOM (heap)** durante o `npm run build` (tsc + tsup) em ambientes/CI com pouca memória, aumentando o heap do Node só no build.

## 2. Solução implementada (upstream)
```diff
- RUN npm run build
+ RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build
```

> **Escopo:** apenas a linha do build. **Não** trazer o resto do Dockerfile do 2.4.0 (`COPY ./patches`, `patch-package`, build-args de licensing) — a nossa versão usa `scripts/` (T06/T07) e não adota licensing.

## 3. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| Build | Passa a ter até 2 GB de heap (evita crash `JavaScript heap out of memory`) |
| Runtime | **Não** afeta (é só no `RUN` de build; a stage `final` não herda a var) |
| Risco | Trivial |

### 3.1 Fidelidade e escopo (auditado 2026-11-24)
- A linha ficou **idêntica** ao upstream (`RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build`).
- `git diff` do `Dockerfile`: **1 linha** (1+/1−). **Nada** mais tocado (mantido `COPY ./scripts`, sem `patches`/licensing).

### 3.2 Semântica do `NODE_OPTIONS`
- A var é aplicada **só àquele comando** (`npm run build` → `tsc --noEmit && tsup`); ambos são processos Node que herdam o `NODE_OPTIONS`.
- É um **teto** de heap (não reserva 2 GB). Se o build precisar menos, não usa mais; se precisar mais, falha em 2 GB.
- `NODE_OPTIONS="--max-old-space-size=2048" npm run build` testado localmente → **Build success** (o build usa < 2 GB).

### 3.3 Verificações adicionais (auditado 2026-11-24)
- **Semântica shell do `RUN`** (`/bin/sh -c`): `VAR="..." cmd` aplica a var só ao comando e o processo filho a herda — confirmado (`NODE_OPTIONS` visível no Node filho).
- **Flag válida:** `--max-old-space-size=2048` aceita; `heap_size_limit ≈ 2096 MB`.
- **Paridade com `Dockerfile.metrics`:** o upstream **também** usa `RUN npm run build` **sem** `NODE_OPTIONS` ali → **sem gap**; nosso `Dockerfile.metrics` foi mantido igual (não alterado).
- **Nuance:** é um **teto**. Em host grande, o default do V8 poderia ser maior; `2048` é suficiente para o nosso build (testado) e é o valor do upstream, então não regride.

## 4. Como validar
1. `docker build` conclui o build (sem OOM) em host com memória limitada.
2. `npm run build` local continua igual.

## 5. Rollback
Voltar `RUN npm run build`.