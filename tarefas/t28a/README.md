# T28a — `fetchLatestWaWebVersion`: cache da versão (sem versão manual)

- **Status:** Concluída
- **Data:** 2026-11-24
- **Versão base:** Evolution API `2.3.7`
- **Origem:** portado da Evolution API `2.4.0` — **subset** (apenas o cache; a versão manual é a T28b)
- **Arquivos:** `src/utils/fetchLatestWaWebVersion.ts`
- **Linhas (~):** **~54** (arquivo de 37 → ~91 linhas)
- **Ordem:** 8a/8 · **Simplicidade:** 🟡 média · **Risco:** 🟡 médio (menor que a versão manual) · **Importância:** 🟡 média (resiliência/perf no connect)

## 1. Sintoma / objetivo
A função batia no `web.whatsapp.com/sw.js` em (quase) toda conexão de instância, sem cache — latência extra no connect e carga no `sw.js`. Sem cache também do fallback do Baileys.

## 2. Solução implementada (subset do 2.4.0)
- Cache da **versão do WhatsApp Web** em `whatsapp_web_version` e do **fallback Baileys** em `baileys_fallback_version`, via `CacheService` (`CacheEngine`, módulo `whatsapp-version`), **TTL 900 s** (15 min).
- Em sucesso (`client_revision` encontrado) → cacheia e retorna `{ version:[2,3000,rev], isLatest:true }`.
- Sem `client_revision` ou **erro** de rede → usa/cacheia o **fallback** do `fetchLatestBaileysVersion()`.
- Assinatura: `fetchLatestWaWebVersion(options, cache?)` — `cache` **opcional** (se não passado, cria um `CacheService` default).
- **NÃO inclui** a versão manual (`CONFIG_BAILEYS_VERSION`) — isso é a **T28b**.

Estado final (T28a + T28b): a função reproduz o upstream, **exceto 2 melhorias intencionais** — `CACHE_TTL_SECONDS = 900` (vs 3600) e `responseType: 'text'` (vs `'json'`, correto para o `sw.js`). O bloco de versão manual é a **T28b**.

## 3. Auditoria — efeitos e segurança
| Ponto | Avaliação |
|---|---|
| Engine por chamada | ✅ seguro: `RedisCache` usa **cliente Redis global** (`redisClient.getConnection()`); `LocalCache` usa `NodeCache` **static** → sem conexão nova nem perda de cache |
| Falha de cache | ✅ `RedisCache.get/set` têm `try/catch` (logam e seguem); `LocalCache` é in-memory |
| Fallback | ✅ preservado; agora também cacheado |
| Call sites | ✅ `index.router:204` e `whatsapp.baileys.service:825` chamam `fetchLatestWaWebVersion({})` — `cache` é opcional, sem mudança |
| Migração | ✅ nenhuma |
| Risco | 🟢 Uma versão ruim/antiga fica cacheada por até **15 min** (TTL 900, reduzido de 1 h). O fallback cobre falha |

### 3.1 Verificações forenses (auditado 2026-11-24)
- **Chave:** `buildKey` = `${PREFIX_KEY}:${module}:${key}` (Redis) / `${module}:${key}` (Local) → `whatsapp-version:whatsapp_web_version`. **Sem colisão** com outros módulos; é **global** (não por instância), correto para a versão do Web.
- **Shape cacheado:** `{ version:[2,3000,rev], isLatest:true }`. No Redis há JSON round-trip (continua **array**); `LocalCache` guarda o objeto direto. `CacheService.get` retorna o objeto.
- **Callers usam só `.version`:** `baileys.service:825` (`baileysVersion.version` → `.join('.')`) e `index.router:204` (`.version.join('.')`) → o cache é **transparente**. Ninguém usa `.isManual`/`.isLatest` hoje (então a ausência de `isManual` na T28a não afeta nada).
- **`CacheService.set`** não é aguardado internamente, mas `RedisCache.set` tem `try/catch` → **sem unhandled rejection**; `LocalCache.set` é síncrono.
- **`responseType`:** ajustado para **`'text'`** (antes `'json'`) — semântica correta para o `sw.js` (retorna string) → `data.match` garantido. (Melhoria intencional vs upstream.)
- **Concorrência:** dois connects simultâneos podem buscar o `sw.js` em duplicidade na 1ª vez (ambos dão miss) — inofensivo.

## 4. Como validar
1. `npm run lint:check && npm run build` (já validado: exit 0 / Build success).
2. Conectar instância → QR/conexão normal; reconectar e conferir que **não** rebusca o `sw.js` (cache quente).
3. (Opcional) Simular `sw.js` inacessível → fallback Baileys assume e fica cacheado.

## 5. Rollback
Reverter `src/utils/fetchLatestWaWebVersion.ts` para a versão simples (sem cache).