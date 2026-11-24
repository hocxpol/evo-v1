# T27 — `Instance.token` 255→500 (`increase_token_length`) + migração

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` (migração `increase_token_length`)
- **Arquivos:**
  - `prisma/postgresql-schema.prisma`, `prisma/mysql-schema.prisma`, `prisma/psql_bouncer-schema.prisma`
  - `prisma/postgresql-migrations/20251216143054_increase_token_length/migration.sql` (novo)
  - `prisma/mysql-migrations/20251216143054_increase_token_length/migration.sql` (novo)
- **Linhas (~):** **3** (schemas) + **2** arquivos de migração (1 linha cada)
- **Ordem:** 7/8 · **Simplicidade:** 🟢 alta (código) · **Risco:** 🟡 médio (**migração de banco**) · **Importância:** 🟡 média

## 1. Sintoma
Tokens/`hash` de instância mais longos que 255 chars são **truncados/rejeitados** na coluna `Instance.token` (`VarChar(255)`), podendo invalidar a autenticação por instância.

## 2. Causa raiz
Coluna `token` com `@db.VarChar(255)` insuficiente para tokens maiores (ex.: chaves longas/novos formatos).

## 3. Solução implementada (upstream)
**Schemas** (3 arquivos): `token ... @db.VarChar(255)` → `@db.VarChar(500)`.

**Migração PostgreSQL:**
```sql
-- AlterTable
ALTER TABLE "Instance" ALTER COLUMN "token" TYPE VARCHAR(500);
```
**Migração MySQL:**
```sql
-- AlterTable
ALTER TABLE `Instance` MODIFY `token` VARCHAR(500);
```

Aplicar com `npm run db:deploy` (copia a migração e roda `prisma migrate deploy`).

## 4. Auditoria — efeitos
| Ponto | Avaliação |
|---|---|
| Coluna `Instance.token` | Alargada para 500 (não quebra dados existentes) |
| Migração | **Aditiva/alargamento** — sem perda; rollback exigiria reverter tipo (evitar) |
| `psql_bouncer-schema` | Manter os 3 schemas em sincronia |
| Risco | Médio — **alteração de schema** (backup + janela) |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
- A linha `token ... @db.VarChar(500)` ficou **idêntica** ao upstream nos **3** schemas (`postgresql`, `mysql`, `psql_bouncer`).
- As **2 migrações** (`increase_token_length`) foram copiadas **byte a byte** do upstream (`diff` vazio).

### 4.2 Validação dos schemas (feita de verdade)
- `DATABASE_PROVIDER=postgresql npm run db:generate` → **Generated** ✅
- `DATABASE_PROVIDER=mysql npm run db:generate` → **Generated** ✅
- `prisma validate --schema psql_bouncer-schema.prisma` (com as envs `DATABASE_BOUNCER_CONNECTION_URI`/`DATABASE_CONNECTION_URI`) → **valid** ✅

### 4.3 Natureza da migração (Postgres)
- `ALTER COLUMN "token" TYPE VARCHAR(500)` — **aumentar** varchar é **metadata-only** no Postgres (sem reescrita da tabela); pega um `ACCESS EXCLUSIVE` por milissegundos.
- MySQL: `MODIFY token VARCHAR(500)` (não usado no nosso deploy; mantido por paridade).

### 4.4 Rollback
Só é seguro reverter para `(255)` **se** nenhum token >255 existir. Preferir **não** reverter após aplicar.

### 4.5 Observação (fora do escopo)
O `psql_bouncer-schema.prisma` **não** possui o índice `@@unique([instanceId, remoteJid])` em `Chat` que o `postgresql-schema` tem (diferença **pré-existente**, não relacionada à T27).

### 4.6 Ordenação, escopo e premissa de deploy (auditado)
- **Ordenação:** a nova migração `20251216143054_increase_token_length` ordena **após** a última existente (`20251122003044_add_chat_instance_remotejid_unique`) → aplicada por último, sobre a tabela já existente. ✅
- **Só `Instance.token`:** o outro `token ... VarChar(100)` é do model **`Chatwoot`** (token da API do Chatwoot), **não** é `Instance.token` — deve permanecer 100 (o upstream também não altera). ✅
- **Premissa de deploy:** `db:deploy` usa `_prisma_migrations` (migrations como fonte de verdade). Se o banco tiver sido criado via `prisma db push` (sem histórico), `migrate deploy` pode acusar drift/conflito — é premissa **operacional** pré-existente do fork, não introduzida pela T27.

## 5. Como validar
1. Backup do banco.
2. `npm run db:deploy` → sem erro.
3. `SELECT character_maximum_length FROM information_schema.columns WHERE table_name='Instance' AND column_name='token';` → **500**.
4. Criar instância com token >255 → persistido sem truncar.

## 6. Rollback
Alterar de volta para `VARCHAR(255)` **somente** se nenhum token >255 existir (senão há truncamento). Preferir não reverter.