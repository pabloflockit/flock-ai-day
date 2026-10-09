# Panel único de liderazgo — Arquitectura (flujo 1)

Documento para el agente de codificación. **Este es el primer flujo de trabajo:** dejar la base técnica lista y verificada. Las funcionalidades de negocio se construyen después, en el segundo flujo, siguiendo `plan.md`.

Donde diga **VERIFICAR**, no asumas: consultá la documentación vigente de Atlassian o probá contra la instancia antes de implementar.

---

## 0. Cómo usar este documento

### 0.1 Reglas de trabajo

1. **Nunca leer ni versionar** `.env`, `.cache/`, archivos `.db` ni nada que pueda contener tokens o datos reales de Jira.
2. **El token de Jira** se implementa como indica la sección 4.3: cifrado con `safeStorage`, nunca en el renderer.
3. **Adaptar a las reglas de este documento** (contrato `IssueRow`, identificadores en inglés, cifrado de contenido, secreto de sesión).
4. **Registrar las decisiones** relevantes en `docs/decisions.md`: qué se decidió, cuándo y por qué.

### 0.2 Piezas del flujo 1

| Pieza | Sección de este documento | Puntos a cuidar |
|---|---|---|
| Arranque del proxy en proceso, puerto dinámico, paso del puerto por `additionalArguments` | §2, §4.2 | Secreto de sesión; escuchar solo en `127.0.0.1` |
| Servidor `http` nativo y ruteo | §7 | Exigir `X-Proxy-Secret` |
| Cliente de Jira: paginación, concurrencia acotada, TTL de metadatos, clasificación de errores, `fetchImpl` inyectable | §6.1, §6.2 | `/search/jql` con `nextPageToken`; leer el token desde `secrets` |
| Proyección a filas planas | §6.3 | Contrato `IssueRow`; preservar `null` vs `0`; identidad por id |
| Cache con `node:sqlite`, clave `(scope_id, source, params_key)`, delta con margen, `PAYLOAD_VERSION`, degradación a desactualizado | §5, §6.5, §6.6 | Cifrar payloads (§4.5); sin `CHECK(source IN (...))` |
| `resolveTarget`, `normalizeConfig` | §8.3, §8.4 | Forma de configuración definida en `plan.md` |
| Store con signals, `ensureHydrated` por clave | §8.1, §8.2 | Hidratación por clave |
| Utilidades de fechas (UTC, fecha calendario vs instante) | §9 | Distinguir fecha calendario de instante |
| Script de validación predicado vs JQL | §10 | Generalizado al scope de proyecto |
| Configuración de Electron (ventana, hash routing, ubicación de la base en `userData` / `.cache/`) | §4.1, §5.1 | Flags de seguridad y CSP |

### 0.3 Pasos

1. Crear el proyecto y construir las piezas de la tabla 0.2 en el orden de la sección 13, siguiendo las reglas de este documento.
2. Corregir por prioridad de impacto: corrección de datos (secciones 6 y 9) > estado y cache (8) > seguridad (4 y 5) > tooling > estilo.
3. Trabajar en unidades chicas: una preocupación por commit, con tests junto al comportamiento. No mezclar un refactor con un cambio de comportamiento nuevo.
4. Si una regla no aplica, explicar por qué en `docs/decisions.md` en lugar de forzarla.
5. Recorrer la checklist de la sección 12 al cerrar el flujo.

**Resultado esperado del flujo 1:** una app que arranca, se conecta a Jira Cloud de forma segura, trae y cachea datos de una épica de prueba como filas planas, y los muestra en una página de diagnóstico. Sin pantallas de negocio todavía.

---

## 1. Contexto en una línea

App de escritorio para Windows que muestra a un líder el trabajo de sus equipos a partir de **un único Jira Cloud** (`https://example.atlassian.net`, confirmado `deploymentType: Cloud`). Solo lectura sobre Jira. Base local accesible solo desde la app. El detalle de negocio está en `plan.md`.

---

## 2. Arquitectura objetivo

```
┌──────────── Electron main process ──────────────────────┐
│  · genera secreto de sesión y clave de datos            │
│  · arranca el PROXY en proceso, en 127.0.0.1, primer    │
│    puerto libre desde 3100                              │
│  · pasa puerto + secreto al renderer por                │
│    additionalArguments (--proxy-port, --proxy-secret)   │
│                                                         │
│  ┌─ Renderer: Angular ───────┐   ┌─ Proxy: Node ───────┐ │
│  │ standalone + signals      │──▶│ http nativo, sin    │ │
│  │ hash routing, lazy pages  │   │ framework           │ │
│  │ un store como fuente de   │   │ Jira → filas planas │ │
│  │ verdad; derivaciones puras│   │ cache node:sqlite   │ │
│  └───────────────────────────┘   │ (contenido cifrado) │ │
│                                  └──────────┬──────────┘ │
└─────────────────────────────────────────────┼────────────┘
                                              ▼
                                     Jira Cloud REST v3
```

### Responsabilidades por capa (estrictas)

| Capa | Es dueña de | NO debe |
|---|---|---|
| **Main (Electron)** | Ventana, seguridad de Electron, secretos (`safeStorage`), arranque del proxy, puente acotado con el sistema operativo (§4.1) | Contener lógica de Jira o de negocio |
| **Proxy (Node)** | Armado de JQL, paginación, concurrencia, resolución de campos, proyección a filas planas, cache, cifrado del contenido, clasificación de errores, lectura del token | Exponer la forma cruda de las issues de Jira; devolver el token al cliente |
| **Cache (`node:sqlite`)** | Datasets persistidos por clave `(scope_id, source, params_key)`, configuración | Guardar valores derivados que se pueden recalcular |
| **Dominio puro (`shared/domain`)** | Métricas, alcance, días hábiles, agregaciones: funciones puras sobre filas planas | Hacer I/O |
| **Front (Angular)** | Store con signals, vistas, estado de vista | Hablar con Jira; re-implementar la proyección; ver el token |

### Elecciones sin dependencias

- **`node:sqlite`**: sin compilación nativa. **VERIFICAR** que la versión de Node embebida en la versión de Electron elegida lo trae disponible sin flags.
- **`http` nativo** para el proxy (sin Express).
- **`node --test`** para proxy, cache y dominio.
- **`crypto` nativo** (AES-256-GCM) para el cifrado del contenido.

---

## 3. Estructura del repositorio

```
panel-liderazgo/
  electron/
    main.(ts|js)          # ventana, flags de seguridad, arranque del proxy
    preload.(ts|js)       # expone { proxyBaseUrl, proxySecret } vía contextBridge
    secrets.(ts|js)       # safeStorage: token de Jira y clave de datos
  proxy/
    server.(ts|js)        # http nativo, ruteo, auth por secreto, CORS/allowlist
    routes/               # handlers por recurso (sección 7)
    jira/
      client.(ts|js)      # fetch inyectable, paginación, backoff, clasificación de errores
      projection.(ts|js)  # issue cruda → fila plana (sección 6.3)
      hierarchy.(ts|js)   # épica → hijos → subtareas
    cache/
      db.(ts|js)          # node:sqlite, migraciones, ubicación
      crypto.(ts|js)      # AES-256-GCM de payloads
      datasets.(ts|js)    # lectura/escritura por clave, delta, versión de payload
    config/
      normalize.(ts|js)   # normalizeConfig: único punto de migración de forma
      validate.(ts|js)    # reglas de integridad del negocio
  shared/
    cache-key.(ts|js)     # resolveTarget(): ÚNICA derivación de claves (proxy y front)
    domain/               # funciones puras: métricas, alcance, días hábiles, fechas
    contracts.(ts|js)     # tipos de filas, config y respuestas del proxy
  src/                    # Angular
    app/core/             # cliente del proxy, store (signals), hidratación
    app/pages/            # páginas lazy (en el flujo 1, solo "diagnóstico")
    styles/flock/         # tokens y logos del Flock Design System (ver plan.md §5)
  fixtures/               # respuestas de Jira grabadas y anonimizadas (modo demo y tests)
  tools/
    validate-scope.mjs    # validador predicado vs JQL (sección 10)
  test/                   # node --test (proxy, cache, dominio)
  docs/
    decisions.md
    design/               # referencia del Flock Design System si la skill no está instalada
```

**Lenguaje del proxy:** TypeScript compilado o JavaScript con JSDoc. `shared/` debe poder importarse desde el proxy y desde Angular sin duplicarse.

**Identificadores en inglés** desde el inicio. Los textos de la UI van en español (es-AR).

---

## 4. Seguridad

### 4.1 Electron
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- El preload expone **solo** esto, vía `contextBridge`:
  - `proxyBaseUrl` y `proxySecret`.
  - `openInJira(issueKey)`: el main arma la URL con la `baseUrl` configurada y la abre con `shell.openExternal`. El renderer nunca pasa URLs arbitrarias.
  - `copyText(text)`: copia al portapapeles con el módulo `clipboard` del main (para los informes).
  - `saveMarkdown(suggestedName, content)`: el main muestra el diálogo de guardado y escribe **solo** archivos `.md` en la ruta elegida por el usuario.
  - Nada más. Cada función valida sus argumentos en el main.
- CSP restrictiva: `connect-src` solo `http://127.0.0.1:<puerto>`; sin contenido remoto en la ventana.
- Bloquear navegación y `window.open`. Links externos solo mediante `openInJira`, hacia el host de Jira configurado.
- Routing por hash (`withHashLocation()`) para que recargar funcione bajo `file://`.

### 4.2 Proxy local
- Escucha **solo en `127.0.0.1`**, nunca en `0.0.0.0`.
- **Secreto de sesión:** el main genera un valor aleatorio en cada arranque. El proxy rechaza (401) cualquier request sin el header `X-Proxy-Secret` correcto. Esto evita que otro programa de la PC consulte el proxy.
- Allowlist de orígenes: el origen del renderer empaquetado y el del servidor de desarrollo de Angular. El secreto se exige siempre, también en desarrollo.
- Sin endpoints de escritura hacia Jira.

### 4.3 Token de Jira
- **El token nunca sale del main:** no se guarda en `localStorage` ni viaja en headers en los requests.
- Correcto: el token se cifra con `safeStorage` en el main y se guarda en un archivo en `userData`. El proxy lo lee directamente desde el proceso principal. **El renderer nunca lo ve.**
- El endpoint para cargarlo es de **solo escritura**: no existe forma de leerlo por la API del proxy.
- Nunca en logs, nunca en la base, nunca en el repo.
- **API key de IA** (informes con IA, `plan.md` §8.2): mismo tratamiento que el token. Se guarda con `safeStorage`, se carga por un endpoint de solo escritura y solo la usa el proxy.
- `.env` / `.env.local` solo en desarrollo; los builds empaquetados los ignoran; las variables de entorno reales tienen prioridad.

### 4.4 URL de Jira
- Debe ser `https://`.
- Blocklist de hosts: `localhost`, `127.0.0.1`, `::1` y cualquier IP privada (evita usar el proxy para alcanzar servicios locales).
- Al configurarla, verificar con `serverInfo` que `deploymentType` sea `Cloud`.
- **Salidas permitidas del proxy:** solo el host de Jira configurado y, únicamente si la IA está habilitada en la configuración, el host del proveedor de IA. Cualquier otra conexión saliente se rechaza en el cliente HTTP.

### 4.5 Base accesible solo desde la app
- La app genera una **clave de datos de 256 bits** al primer arranque y la guarda cifrada con `safeStorage` (atada al usuario de Windows). Nadie la tipea ni la ve.
- **Todo el contenido** (payloads de datasets y documento de configuración) se cifra con **AES-256-GCM**, con IV aleatorio por escritura. En la base solo quedan en claro las claves técnicas, fechas y versiones.
- Si la clave no está o no descifra: error claro, sin sobrescribir. Opciones: crear una base nueva (renombrando la anterior, nunca borrándola; siempre disponible) o importar configuración (solo si se implementó exportar/importar, ítem opcional de `plan.md` §9).
- La clave nunca se loguea ni sale del proceso principal / proxy.

### 4.6 Datos de Jira como datos no confiables
- Los textos de las issues se muestran siempre escapados. Nunca se interpretan como HTML ni como instrucciones (relevante para los informes con IA de `plan.md`).

---

## 5. Persistencia

### 5.1 Ubicación
- Empaquetada: `app.getPath('userData')` (sobrevive actualizaciones).
- Desarrollo: `.cache/` en el repo (en `.gitignore`).
- **Documentar que difieren:** cambiar entre ambos modos parece pérdida de datos.

### 5.2 Esquema

```sql
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Documento de configuración único, cifrado
CREATE TABLE app_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  payload_enc BLOB NOT NULL,   -- AES-GCM(JSON normalizado)
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  updated_at  TEXT NOT NULL    -- ISO con Z
);

-- Datasets cacheados
CREATE TABLE datasets (
  scope_id        TEXT NOT NULL,     -- p. ej. id de proyecto, o 'global'
  source          TEXT NOT NULL,     -- p. ej. 'projectIssues', 'fields'
  params_key      TEXT NOT NULL,     -- hash estable de parámetros (sección 8.3)
  payload_version INTEGER NOT NULL,  -- PAYLOAD_VERSION al escribir
  payload_enc     BLOB NOT NULL,     -- AES-GCM(JSON de filas planas)
  iv              BLOB NOT NULL,
  tag             BLOB NOT NULL,
  fetched_at      TEXT NOT NULL,     -- ISO con Z
  full_fetched_at TEXT NOT NULL,     -- última carga completa
  is_current      INTEGER NOT NULL,  -- 0 si quedó desactualizado por fallas parciales
  shards_meta     TEXT NOT NULL,     -- JSON por épica: { key, status: ok|failed, lastOkAt, errorCode }
  PRIMARY KEY (scope_id, source, params_key)
);
```

- **Sin `CHECK(source IN (...))`**: las fuentes son datos, no una lista cerrada en el esquema.
- **No persistir valores derivados** (porcentajes, días en estado, totales). Todo se recalcula desde filas y configuración.
- Timestamps: siempre generados en código como ISO con `Z`. **No usar `datetime('now')` de SQLite** (devuelve sin zona y se interpreta como hora local).

---

## 6. Proxy: acceso a Jira

### 6.1 Cliente de Jira
- Toda función de red recibe `(config, fetchImpl = globalThis.fetch, deps = {})`. El handle de la base también es inyectable. Esto permite testear con `node --test` sin red.
- Autenticación: Basic `email:apiToken` (el token se lee de `secrets`).
- Timeout y reintentos configurables; backoff exponencial ante `429` (respetar `Retry-After`) y `5xx`.
- **Clasificación de errores** con códigos propios: `UNREACHABLE`, `TLS`, `AUTH`, `FORBIDDEN`, `NOT_FOUND`, `BAD_QUERY` (400 de JQL), `TIMEOUT`, `RATE_LIMIT`, `SERVER_ERROR`, `UNKNOWN`. Mensajes en español en el front.
- Lista blanca de endpoints (todos de lectura):

| Uso | Endpoint |
|---|---|
| Verificar instancia | `GET /rest/api/3/serverInfo` |
| Probar credenciales | `GET /rest/api/3/myself` |
| Buscar issues | `GET/POST /rest/api/3/search/jql` |
| Campos | `GET /rest/api/3/field` |
| Estados | `GET /rest/api/3/status` |
| Tipos de issue | `GET /rest/api/3/issuetype` |
| Una issue | `GET /rest/api/3/issue/{key}` |
| Historial de una issue | `GET /rest/api/3/issue/{key}/changelog` |
| Usuarios | `GET /rest/api/3/user/search`, `GET /rest/api/3/user` |
| Componentes de un proyecto | `GET /rest/api/3/project/{key}/components` (array simple, sin paginar) |

### 6.2 Búsqueda (Jira Cloud)
- El endpoint viejo `/rest/api/3/search` fue **removido**. Usar `/search/jql`: pagina con `nextPageToken` (no `startAt`), **no devuelve total**, requiere `fields` explícitos y es **eventualmente consistente**.
- **Fragmentar** las consultas: una por épica (y una más para las subtareas de cada lote de hijos), con **concurrencia acotada (~6)**.
- **Pedir de entrada todo campo que se vaya a usar** (resolución, `issuetype.id`, `assignee.accountId`, campos de medición, etc.). Olvidar uno obliga después a invalidar el cache de todos.
- Metadatos (`/field`, `/status`, `/issuetype`) cacheados con TTL de ~10 minutos.

### 6.3 Proyección a filas planas (contrato)

El proxy devuelve filas tipadas. **El cliente nunca lee `fields.customfield_*`.**

```ts
interface IssueRow {
  key: string;
  issueTypeId: string;          // identidad: por id, nunca por nombre
  issueTypeName: string;        // solo para mostrar
  hierarchyLevel: number;       // de /issuetype (VERIFICAR: 1 épica, 0 estándar, -1 subtarea)
  isSubtask: boolean;           // estricto: subtarea de Jira (no "hijo" en general)
  summary: string;
  parentKey: string | null;
  epicKey: string | null;       // resuelto: subtarea → padre → épica
  statusId: string;
  statusName: string;
  statusCategory: 'todo' | 'doing' | 'done';   // categoría de Jira mapeada, SIN overrides (ver nota)
  statusSince: string | null;   // ISO Z: última transición de estado
  firstDoingAt: string | null;  // ISO Z: primera entrada a categoría doing
  doneAt: string | null;        // ISO Z: última entrada a done; fallback resolutiondate
  resolvedAt: string | null;    // ISO Z
  assigneeAccountId: string | null;
  assigneeName: string | null;
  priorityName: string | null;
  measures: Record<string, number | null>;     // por fieldId; null = sin valor en Jira
  createdAt: string;            // ISO Z
  updatedAt: string;            // ISO Z
  dueDate: string | null;       // fecha calendario YYYY-MM-DD (sin hora)
}
```

- **Overrides de categoría de estado:** no se aplican en la proyección. Se aplican en el dominio con `effectiveCategory(row, config)`, así editar un override **no mueve claves ni obliga a volver a pedir datos** (`plan.md` §2.3). Ninguna métrica lee `statusCategory` directamente.
- **Valores de medición en crudo:** `measures` guarda el valor tal como viene de Jira (p. ej. segundos para la estimación original). Las conversiones de unidad (segundos → horas) se hacen en el dominio.
- `statusSince`, `firstDoingAt` y `doneAt` se calculan con la categoría de Jira. Si un override cambia la categoría de un estado, el dominio recalcula esos instantes desde el historial cuando hace falta (P1); para el corte mínimo se documenta la limitación.
- **`null` vs `0`:** `null` = Jira no tiene valor; `0` = alguien estimó cero. **Nunca** `value || null` ni `value ?? 0` en la proyección.
- **Historial de estados** (`statusSince`, `firstDoingAt`, `doneAt`): pedir `expand=changelog` en la búsqueda si `/search/jql` lo soporta (**VERIFICAR**, y verificar si trunca entradas). Si trunca o no lo soporta, completar con `/issue/{key}/changelog` solo para las issues que cambiaron en el delta. Fallback documentado: campo de fecha de cambio de categoría de estado (**VERIFICAR** su nombre en la instancia).
- Los derivados del historial son parte de la fila (se recalculan en cada fetch desde Jira), no configuración persistida.

### 6.4 Jerarquía épica → tarea → subtarea
- Hijos de cada épica según `jira.epicLinkMode` de la configuración:
  - `parent`: `parent = EPIC-1` (o `parent in (...)` por lote).
  - `epic_link`: `cf[XXXXX] = EPIC-1` con el id del campo configurado (**VERIFICAR** sintaxis).
  - `auto`: `parent`; si devuelve cero hijos, reintentar `epic_link` y registrar el método que funcionó.
- Subtareas: `parent in (<claves de hijos>)` por lotes.
- Tipos y estados **siempre por id**. Un sitio puede tener varios tipos con el mismo nombre visible, y el nombre en la API puede no ser el literal que funciona en JQL.

### 6.5 Refresco incremental
- Delta: `updated >= -Nm` (relativo, sin problemas de zona horaria), con N = minutos desde el último fetch + margen de seguridad de unos minutos. Se fusiona sobre las filas cacheadas.
- Carga completa si: no hay cache, la última carga completa supera una edad máxima (configurable, p. ej. 24 h), la `payload_version` no coincide, o el usuario la pide. La completa es la única que detecta issues borradas o movidas fuera de la épica.
- **`PAYLOAD_VERSION`**: constante en el proxy. Si cambia la forma de la fila, se incrementa y fuerza carga completa. Sin esto, el delta conserva filas con forma vieja para siempre.

### 6.6 Degradar a "desactualizado", nunca a "vacío"
- Si falla una épica (p. ej. un 400 de Jira), **se conservan sus filas cacheadas** en lugar de guardar un resultado vacío. Un fragmento que falló y uno vacío son indistinguibles una vez guardados.
- El dataset queda con `is_current = 0` y `shards_meta` marca las épicas afectadas (con su `lastOkAt`). El front lo muestra, y la pantalla de épicas usa `lastOkAt` como "última sincronización" de cada épica.

### 6.7 Campos de configuración mantenidos por la sincronización

`plan.md` guarda en la configuración algunos datos que vienen de Jira. La sincronización los actualiza; el usuario no los edita:

| Campo | Cómo se actualiza |
|---|---|
| `teams[].members[]`: `displayName`, `emailAddress`, `jiraActive`, `refreshedAt` | `GET /rest/api/3/user?accountId=` por integrante, con concurrencia acotada, en cada sincronización |
| `projects[].epics[]`: `summary`, `linkMethodUsed` | Resultado del fetch de cada épica (`linkMethodUsed` es lo que detectó `auto`) |

Reglas:
- La escritura relee la configuración vigente y **solo fusiona esos campos**; nunca pisa campos editados por el usuario.
- Pasa por `normalizeConfig` y `validateConfig`, como cualquier escritura.
- **No mueve claves de cache** (ninguno de estos campos forma parte de `params_key`).
- Si un integrante ya no existe en Jira, se marca `jiraActive: false`; no se elimina.

---

## 7. API del proxy

Todas las rutas exigen `X-Proxy-Secret`. Respuestas JSON con forma `{ ok: true, data } | { ok: false, error: { code, message } }`.

```
GET  /api/health

GET  /api/config                    # documento normalizado, sin secretos
PUT  /api/config                    # valida + normaliza + guarda; responde claves movidas
PUT  /api/connection/token          # solo escritura
PUT  /api/ai/key                    # solo escritura (plan.md §8.2)
GET  /api/config/export             # opcional: configuración sin secretos ni datos de issues
POST /api/config/import             # opcional: valida + normaliza antes de guardar
POST /api/connection/verify         # serverInfo → { deploymentType, baseUrl }
POST /api/connection/test           # /myself → { accountId, displayName }
GET  /api/connection/status         # { tokenStored, aiKeyStored } — solo presencia, nunca el valor

GET  /api/jira/fields               # cache TTL; incluye schema.type
GET  /api/jira/statuses
GET  /api/jira/issuetypes
GET  /api/jira/users?query=         # personas activas, sin apps/bots
GET  /api/jira/projects/:key/components  # [{ id, name }] por nombre; :key = clave de proyecto Jira (A-Z, 0-9, _)
GET  /api/jira/epics/:key           # validación de una épica
GET  /api/jira/epics?query=         # búsqueda por texto (flujo 2, fase P1)

GET  /api/datasets/:source?scopeId=           # { rows, fetchedAt, isCurrent, shardsMeta }
GET  /api/datasets/:source/meta?scopeId=      # { fetchedAt, isCurrent, shardsMeta } — sin rows (administración)
POST /api/datasets/:source/refresh?scopeId=&mode=delta|full
                                     # `memberIssues` (informe de cierre): scopeId = id de equipo y `since=AAAA-MM-DD` obligatorio
POST /api/sync                       # refresca todos los proyectos activos + campos de §6.7
GET  /api/sync/status                # progreso para polling

POST /api/reports/ai                 # solo si está habilitado; recibe métricas agregadas, devuelve texto (plan.md §8.2)
```

**Fuente `memberIssues` (informe de cierre).** El trabajo propio de los integrantes activos de un equipo desde el inicio del período: `assignee in (<integrantes>) AND updated >= "<since>"` con changelog (lotes de 50 integrantes). La épica sale del padre; una subtarea toma la de su padre, y si el padre no vino en el resultado se busca con `key in (...)` (sin changelog). El dataset es **todo** el trabajo de los integrantes: el modelo del informe separa lo que cae fuera de las épicas del equipo. Un solo shard (`members`) con delta, degradación y coalescencia iguales a `projectIssues`. Equipo inexistente o inactivo → 404; `since` ausente o inválido → 400 `VALIDATION_ERROR`. Se cuenta por el responsable **actual** de la issue.

`PUT /api/config` devuelve la lista de claves de cache que **cambiaron** por la edición, para que el front precaliente solo esas.

---

## 8. Front (Angular)

### 8.1 Store
- **Un store con signals** (`providedIn: 'root'`) como única fuente de verdad: configuración, datasets por clave de cache, estado de sincronización, estado de vista.
- Páginas lazy que derivan con `computed()` y funciones puras de `shared/domain`.

### 8.2 Hidratación por clave, no por ciclo de vida
- La barra lateral persistente (selector de equipo/proyecto) no recrea la página. Patrón: `ensureHydrated(source, params)` llamado desde un `effect()` en el constructor que sigue el scope activo.
- **Vista de equipo:** el equipo seleccionado hidrata los datasets `projectIssues` de **todos sus proyectos activos**. Los filtros de proyecto y épica de la barra lateral se aplican en el cliente, sin pedir datos nuevos.
- Idempotente por clave (`Set<string>`): no repite claves con refresco en curso o ya cargadas, y se rearma ante error de transporte (el proxy puede estar arrancando).

### 8.3 Claves de cache
- **Una sola función** `resolveTarget(scope, source, params) → { paramsKey, cacheKey }` en `shared/cache-key`, usada por proxy y front. Nunca armar claves a mano.
- `params_key` = hash estable de los parámetros **que cambian la consulta** (listas ordenadas antes de hashear).
- **La configuración es parte de la clave** solo donde cambia la consulta: épicas del proyecto, campos de medición, método de vínculo. Lo que solo filtra en el cliente (integrantes del equipo, filtros de vista, orden) **no** mueve claves.
- Al guardar configuración, precalentar **solo las claves que se movieron**, del scope **editado** (no del activo).

### 8.4 Configuración
- **Una sola función** `normalizeConfig(raw)`: lista blanca, idempotente, descarta claves desconocidas. Es el único lugar donde se migra la forma de la configuración.
- `validateConfig` aplica las reglas de integridad de negocio (definidas en `plan.md`).
- **Capas por componente** (informe de cierre): `jira.componentLayers: Array<{ projectKey, componentId, componentName, layer: 'frontend' | 'backend' | 'functional' }>`, default `[]`. Se mapea por clave de proyecto Jira + id de componente (los nombres cambian entre proyectos). `normalizeConfig` descarta entradas mal formadas y repetidas (gana la última); `validateConfig` rechaza claves y capas inválidas (`COMPONENT_LAYER_*`). **No mueve la clave de cache**: las filas ya traen todos sus componentes y la capa se resuelve al armar el informe.

### 8.5 Estado de vista
- Filtros de vista (equipo seleccionado, proyecto y épica, rango de fechas) son **estado de vista** persistido por scope. No son configuración ni reglas.
- Se persisten en `localStorage` **solo como ids y preferencias de UI**. Nunca datos de Jira, nombres de personas ni nada sensible.

---

## 9. Dominio puro y fechas

- Todas las métricas, el alcance y las agregaciones viven en `shared/domain` como **funciones puras** sobre `IssueRow[]` + configuración. Testeadas con `node --test`.
- **Aritmética de fechas en UTC** (los constructores locales se corren un día con cambios de horario).
- **Dos tipos de fecha, dos formateadores:**
  - Fecha calendario (`YYYY-MM-DD`, p. ej. `dueDate`): se muestra con `timeZone: 'UTC'`.
  - Instante (ISO con `Z`): se muestra en la zona local del usuario.
  - Mezclarlos muestra el día anterior en UTC-3.
- **Días hábiles y semanas sobre el calendario local:** antes de contar días hábiles o agrupar por semana ISO, cada instante se convierte a **fecha calendario en la zona horaria del sistema**; recién después se hace la aritmética, en UTC, sobre esas fechas. Así una transición a las 22:00 en UTC-3 cuenta para ese día y no para el siguiente.
- **Días hábiles:** utilidad `businessDaysBetween(fromISO, toISO)` (lunes a viernes, sin feriados), con tests, incluido el caso de instantes cerca de la medianoche local.

---

## 10. Validación contra Jira

Herramienta reutilizable `tools/validate-scope.mjs` (también usable como test):

1. Traer el scope real con todos los campos relevantes.
2. Reconstruir las filas exactamente como la proyección del proxy.
3. Aplicar el predicado del cliente (p. ej. "abiertas del proyecto X").
4. Ejecutar el JQL equivalente.
5. **Comparar por conjuntos de claves** (`onlyPredicate` / `onlyJql`), nunca por cantidades: totales iguales pueden esconder errores que se compensan.

Si de golpe devuelve 0 coincidencias, sospechar primero del propio script (escape de expresiones regulares, comillas en JQL).

### 10.1 Modo demo

- `--demo` hace que el proxy use un `fetchImpl` que responde con las respuestas grabadas y anonimizadas de `fixtures/` (mismo patrón de inyección que los tests). No hay red ni token.
- Usa una base separada (`.cache/demo/` en desarrollo), para no mezclar datos de demo con reales.
- Las fixtures se generan grabando respuestas reales y reemplazando nombres, emails, resúmenes y claves por valores ficticios. Nunca se versionan respuestas sin anonimizar.

---

## 11. Tooling para el día

- **Sí:** `node --test` para proxy, cache y dominio (rápido, sin navegador, con `fetchImpl` inyectado y base en memoria); runner de Angular solo para lo imprescindible de UI.
- **Después del evento** (documentar como evolución): Biome + Prettier con husky/lint-staged, CI en un solo job, umbrales de cobertura.

---

## 12. Checklist de salida del flujo 1

- [ ] El proxy arranca en proceso, en `127.0.0.1`, puerto dinámico, y exige el secreto de sesión.
- [ ] El renderer recibe puerto y secreto por el preload; nunca ve el token.
- [ ] El preload expone solo `proxyBaseUrl`, `proxySecret`, `openInJira`, `copyText` y `saveMarkdown`, con validación en el main.
- [ ] El proxy solo sale hacia el host de Jira (y el de IA si está habilitada).
- [ ] Token y clave de datos con `safeStorage`; endpoint de token de solo escritura.
- [ ] URL de Jira validada (https, blocklist, `deploymentType: Cloud`).
- [ ] Configuración y payloads cifrados con AES-256-GCM; el `.db` abierto con una herramienta externa no muestra contenido.
- [ ] Base en `userData` empaquetada y `.cache/` en desarrollo, documentado.
- [ ] El proxy devuelve filas planas; el cliente nunca lee `customfield_*`.
- [ ] Tipos y estados por id; `isSubtask` estricto.
- [ ] Overrides de categoría aplicados en el dominio (`effectiveCategory`), no en la proyección.
- [ ] La proyección preserva `null` vs `0`.
- [ ] Payload versionado; una diferencia fuerza carga completa.
- [ ] Una épica que falla conserva sus filas cacheadas (desactualizado, no vacío).
- [ ] Timestamps salen del proxy como ISO con `Z`.
- [ ] `resolveTarget` única, usada por proxy y front.
- [ ] Hidratación por clave desde un `effect()`, no desde `ngOnInit`.
- [ ] `normalizeConfig` única e idempotente.
- [ ] No hay valores derivados persistidos.
- [ ] Fechas en UTC; formateadores separados para fecha calendario e instante; días hábiles y semanas sobre la fecha calendario local.
- [ ] La sincronización actualiza solo los campos de §6.7 de la configuración, sin mover claves.
- [ ] Modo `--demo` funcional con fixtures anonimizadas y base separada.
- [ ] Routing por hash.
- [ ] `validate-scope.mjs` funciona contra una épica real y compara por conjuntos de claves.
- [ ] Identificadores en inglés.
- [ ] **Página de diagnóstico:** muestra el estado de conexión y las filas de una épica de prueba con su `fetchedAt` e `isCurrent`.

---

## 13. Orden de trabajo del flujo 1 (≈ 2 h 30 a 3 h)

1. Proyecto con el esqueleto: Electron, proxy en proceso, hash routing, store.
2. Seguridad: secreto de sesión, token con `safeStorage`, validación de URL.
3. Cache + cifrado de payloads y configuración + esquema de la sección 5.
4. Cliente de Jira y proyección según el contrato `IssueRow`, jerarquía por `epicLinkMode`, versión de payload, degradación a desactualizado (más tiempo si el historial de estados requiere el fallback por issue).
5. Página de diagnóstico, validador, mecanismo de modo demo (las fixtures completas se arman en el flujo 2) y checklist completa.
