# T28b — `fetchLatestWaWebVersion`: versão manual (`CONFIG_BAILEYS_VERSION`)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — parte da versão manual (a T28a já trouxe o cache)
- **Arquivos:**
  - `src/utils/fetchLatestWaWebVersion.ts`
  - `src/config/env.config.ts`
- **Linhas (~):** **~15** (função) + **~4** (`env.config`)
- **Ordem:** 8b/8 · **Simplicidade:** 🟢 alta · **Risco:** 🟡 médio (**erro de configuração** do operador) · **Importância:** 🟢 baixa (só quem quer pinar versão)

## 1. Objetivo
Permitir **fixar** manualmente a versão do WhatsApp Web via env `CONFIG_BAILEYS_VERSION` (ex.: `2.3000.1023...`), pulando o fetch do `sw.js`.

## 2. Pré-requisito
**T28a** aplicada (cache). A T28b adiciona o bloco de versão manual **antes** do cache.

## 3. Solução (upstream)
`env.config.ts`:
```diff
+ export type Baileys = { VERSION?: string };
  // ... no tipo de config:
+ BAILEYS: Baileys;
  // ... na leitura de env:
+ BAILEYS: {
+   VERSION: process.env?.CONFIG_BAILEYS_VERSION,
+ },
```

`fetchLatestWaWebVersion.ts` (início da função):
```diff
  export const fetchLatestWaWebVersion = async (options, cache?) => {
+   // Check if manual version is set via configuration
+   const baileysConfig = configService.get<Baileys>('BAILEYS');
+   const manualVersion = baileysConfig?.VERSION;
+
+   if (manualVersion) {
+     const versionParts = manualVersion.split('.').map(Number);
+     if (versionParts.length === 3 && !versionParts.some(isNaN)) {
+       return {
+         version: versionParts as WAVersion,
+         isLatest: false,
+         isManual: true,
+       };
+     }
+   }
+
    let versionCache = cache || null;
    ...
```
> Com a T28b, a função fica **byte a byte igual** ao `2.4.0-rc2`.

## 4. Auditoria — riscos
| Ponto | Avaliação |
|---|---|
| Versão manual inválida (formato) | ✅ ignorada (só aplica se 3 partes numéricas) |
| Versão manual **válida porém desatualizada** | ⚠️ **todas** as conexões usam essa versão → WhatsApp pode **rejeitar** a conexão (erro do operador) |
| Desligado por padrão | ✅ sem `CONFIG_BAILEYS_VERSION`, cai no cache/fetch (T28a) |
| Risco | 🟡 médio — **opt-in**; documentar bem |

### 4.1 Fidelidade ao upstream (auditado 2026-11-24)
- `src/utils/fetchLatestWaWebVersion.ts` reproduz o `2.4.0-rc2`, **exceto 2 melhorias intencionais** (vale para o conjunto T28a+T28b): `CACHE_TTL_SECONDS = 900` (vs 3600) e `responseType: 'text'` (vs `'json'`). Todo o resto (incl. o bloco de versão manual) é **idêntico** ao upstream.
- `env.config.ts`: adicionados `export type Baileys = { VERSION?: string }` (linha 299), `BAILEYS: Baileys` na interface (423) e o loader `BAILEYS: { VERSION: process.env?.CONFIG_BAILEYS_VERSION }` (857). **Conteúdo igual** ao upstream; a posição é adaptada porque o nosso `env.config` é customizado (sem licensing). O `LogBaileys`/`LOG.BAILEYS` existente **não** conflita com o `BAILEYS` de topo (build passou).

### 4.2 Comportamento (opt-in)
- Sem `CONFIG_BAILEYS_VERSION` → **T28a** (cache/fetch).
- Com valor **válido** (3 partes numéricas) → retorna `{ version, isLatest:false, isManual:true }` **sem** fetch/cache.
- Com valor **inválido** (não 3 partes / NaN) → **ignora** e segue cache/fetch.

### 4.3 Risco
- 🟡 **Config válida porém desatualizada** → **todas** as conexões usam essa versão; o WhatsApp pode rejeitar. É **opt-in** (default desligado).
- Callers usam só `.version`; `isManual` não é consumido → sem efeito colateral.

### 4.4 Higiene
- `git diff --check` limpo. `npm run lint:check` → **exit 0**; `npm run build` → **Build success**.

### 4.5 Verificações forenses (auditado 2026-11-24)
- **Custo do `configService.get('BAILEYS')`:** é simplesmente `this.env[key]`, sobre o objeto montado **uma vez** no boot (`loadEnv`→`envProcess`). Não relê o env, não é assíncrono, e retorna sempre a mesma referência → custo **desprezível** por connect e versão estável em runtime.
- **`CONFIG_BAILEYS_VERSION` nos env examples:** ✅ **documentado** (correção desta auditoria) no `.env.example` (seção "Whatsapp Web version") e no `env.example` (seção de sessão). Fica **vazio por padrão**; vazio é falsy → sem efeito (detecta/cacheia). O upstream não documentava (nosso fork documenta como melhoria de UX).
- **Validação do formato:** exige **3 partes numéricas** (`2.3000.<rev>`). Qualquer outro formato (2 partes, texto, NaN) é **ignorado** → segue o cache/fetch (T28a).
- **`import type`:** `Baileys` é `export type` e é importado junto de `configService`; com o `tsup`/`esbuild` o build passou, e o upstream usa a mesma forma.

## 5. Como validar
1. `npm run lint:check && npm run build`.
2. Sem a env → comportamento da T28a.
3. Com `CONFIG_BAILEYS_VERSION=2.3000.x` válido → conexão usa versão fixa (`isManual: true`).
4. Com valor inválido → ignorado (segue o fetch/cache).

## 6. Rollback
Remover o bloco manual e o `BAILEYS`/`Baileys` do `env.config.ts`.