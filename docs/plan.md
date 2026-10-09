# Panel único de liderazgo — Plan de desarrollo (flujo 2)

Documento para el agente de codificación. **Este es el segundo flujo de trabajo:** construir las funcionalidades de negocio sobre la base técnica de `architecture.md`.

**Requisito para empezar:** la checklist de la sección 12 de `architecture.md` está completa. Si algo de esa checklist falta, se resuelve primero.

Donde diga **VERIFICAR**, no asumas: consultá la documentación vigente de Atlassian o probá contra la instancia.

---

## 1. Objetivo de negocio

Challenge "Panel único de liderazgo" del AI Day de Flockit: **unificar en una sola herramienta los informes de sprint, los informes de cliente y las métricas de equipo, conectada a la API real de Jira.**

La app le muestra a un líder técnico el trabajo de sus equipos a partir de **un único Jira Cloud**:

- **Equipos** con **integrantes** traídos desde Jira (nunca cargados a mano) y **proyectos**.
- **Proyectos** propios de la app: cada uno pertenece a **un solo equipo**, agrupa **épicas** de Jira y define **cómo se mide el trabajo**.
- **Dashboard por equipo** con avance, estados, carga y alertas; un apartado **"Fuera del equipo"**; e **informes** de sprint y de avance al cliente.
- Genérica: estados, tipos, tareas y subtareas se arman desde lo que devuelve Jira; lo que varía se configura.
- Solo lectura sobre Jira.

Ejemplo: el equipo **"Equipo Norte"** tiene el proyecto **"Plataforma"**, con las épicas `ABC-1234` y `ABC-5678`. Su dashboard muestra el trabajo de esas épicas asignado a los integrantes de Equipo Norte; lo sin asignar o asignado a otras personas aparece en "Fuera del equipo".

---

## 2. Modelo de organización

```
Equipo ──< Proyecto ──< Épica     (un proyecto: un solo equipo · una épica: un solo proyecto)
   │
   >──< Integrante                 (una persona puede estar en varios equipos)
```

### 2.1 Documento de configuración

Vive cifrado en `app_config` (ver `architecture.md` §5) y pasa siempre por `normalizeConfig` y `validateConfig`.

```ts
interface AppConfig {
  version: number;
  jira: {
    baseUrl: string;                       // https://<sitio>.atlassian.net
    email: string;                         // el token NO va acá
    epicLinkMode: 'parent' | 'epic_link' | 'auto';   // default 'auto'
    epicLinkFieldId: string | null;        // si epic_link
    timeoutMs: number;                     // default 15000
    maxRetries: number;                    // default 3
    statusCategoryOverrides: Record<string, 'todo' | 'doing' | 'done'>;  // por statusId
    componentLayers: Array<{ projectKey: string; componentId: string; componentName: string; layer: 'frontend' | 'backend' | 'functional' }>;  // capa por componente de Jira (informe de cierre)
  };
  settings: {
    staleBusinessDays: number;             // default 5
    agingBusinessDays: number;             // default 10
    fullRefreshMaxAgeHours: number;        // default 24
    ai: { enabled: boolean };              // default false (la API key va en safeStorage)
  };
  teams: Array<{
    id: string;                            // uuid estable
    name: string;
    description: string | null;
    active: boolean;
    members: Array<{
      accountId: string;                   // identidad
      displayName: string;                 // mantenido por la sincronización (architecture.md §6.7)
      emailAddress: string | null;         // ídem; puede faltar por privacidad
      jiraActive: boolean;                 // ídem
      active: boolean;                     // activo en este equipo
      refreshedAt: string;                 // ISO Z
    }>;
  }>;
  projects: Array<{
    id: string;                            // uuid estable
    teamId: string;                        // un solo equipo
    name: string;
    description: string | null;
    active: boolean;
    workUnit: 'task' | 'subtask' | 'both'; // default 'task'
    measure:
      | { kind: 'count' }                  // default
      | { kind: 'field'; fieldId: string; fieldName: string; valueType: 'number' | 'time_seconds' };
    epics: Array<{
      key: string;
      issueTypeId: string;
      summary: string;                     // mantenido por la sincronización (architecture.md §6.7)
      active: boolean;
      linkMethodUsed: 'parent' | 'epic_link' | null;   // ídem: resultado de 'auto'
    }>;
  }>;
}
```

### 2.2 Reglas de integridad (`validateConfig`)

- Nombres de equipo únicos; nombres de proyecto únicos.
- `project.teamId` debe existir.
- **Una épica en un solo proyecto:** la misma clave no puede aparecer en dos proyectos. Al intentar agregarla, la UI ofrece **moverla**.
- Una persona no puede estar dos veces en el mismo equipo (sí en equipos distintos).
- No se elimina un equipo con proyectos ni un proyecto con épicas: primero se mueven o eliminan. **Desactivar** es la acción por defecto y conserva el historial.
- Un proyecto se puede **reasignar** a otro equipo con confirmación.

### 2.3 Qué mueve claves de cache

Siguiendo `architecture.md` §8.3, el dataset de un proyecto (`source: 'projectIssues'`, `scopeId: project.id`) se identifica por los parámetros que cambian la consulta:

- Claves de épicas activas (ordenadas).
- Campos de medición del proyecto.
- `epicLinkMode` y `epicLinkFieldId`.

**No** mueven claves: integrantes de equipos, nombres, descripciones, filtros de vista, campos mantenidos por la sincronización y **overrides de categoría de estado**. Los overrides se aplican en el dominio (`effectiveCategory`, `architecture.md` §6.3), así que editarlos recalcula el dashboard sin volver a pedir datos.

---

## 3. Medición del trabajo (configurable por proyecto)

**Unidad: qué se mide**

| Opción | Qué cuenta |
|---|---|
| `task` (**default**) | Issues de nivel estándar (`hierarchyLevel = 0`): historias, tareas, bugs, etc. |
| `subtask` | Subtareas (`isSubtask = true`) |
| `both` | Las dos mediciones en paralelo, lado a lado ("Tareas 12/20 · Subtareas 40/55"). No se suman |

**Medida: cómo se cuantifica**

| Opción | Detalle |
|---|---|
| Cantidad (**default**) | Cada unidad vale 1 |
| Un campo de las issues | Elegido de los campos de la instancia con valor numérico (`schema.type = number`): story points o cualquier campo numérico. También la estimación original de time tracking: el valor llega en segundos y el dominio lo convierte a horas para mostrar (**VERIFICAR** id y formato) |

Reglas:
- La **cantidad** se muestra siempre como referencia.
- Unidades con `measures[fieldId] = null` se cuentan aparte y se avisa ("8 tareas sin story points"), con lista. `0` es un valor válido.
- En unidad `task`, estado y responsable son los de la tarea; en `subtask`, los de cada subtarea.
- **Tareas sin subtareas al medir por subtareas:** no aportan a esa medición. La UI lo muestra con contador y lista ("5 tareas no tienen subtareas y no están incluidas en la medición por subtareas").
- **Equipo con proyectos configurados distinto:** no se mezclan unidades ni medidas. El resumen del equipo muestra cada combinación por separado y el detalle por proyecto usa la configuración de cada uno.

Implementación: `shared/domain/work-units` convierte `IssueRow[]` + configuración del proyecto en unidades `{ key, unitType, projectId, teamId, epicKey, assigneeAccountId, statusCategory, measureValue, ... }`. Todo lo demás parte de ahí.

---

## 4. Alcance

Todo se mira **desde un equipo**. Para el equipo **T**:

```
unidad ∈ alcance de T  ⇔
      su épica está activa
  AND la épica pertenece a un proyecto activo de T
  AND assigneeAccountId ∈ integrantes activos de T

unidad ∈ fuera del equipo T  ⇔
      mismas condiciones de épica y proyecto
  AND ( assigneeAccountId = null                       → "Sin asignar"
        OR assigneeAccountId ∉ integrantes activos de T ) → "Asignado a otras personas"
```

- Una persona en varios equipos aparece en cada equipo solo con el trabajo de los proyectos de ese equipo.
- Las métricas principales no incluyen lo que está fuera del equipo. El encabezado muestra un acceso con contador: "12 unidades fuera del equipo".
- Funciones puras `teamScope()` y `teamOutside()` en `shared/domain`.

---

## 5. Diseño visual: Flock Design System

Toda la UI se construye con la skill **`flock-design-system`** (Flock Design System v1.1). Antes de escribir cualquier pantalla o componente, el agente lee `SKILL.md` de la skill y sigue sus reglas y su referencia.

### 5.1 Disponibilidad de la skill
- Si el agente tiene la skill instalada, usarla directamente.
- Si no, copiar al repo nuevo los archivos de la skill: `assets/tokens.css`, `references/design-system.md` y los logos (`flock-logo.svg`, `flock-mark.svg`, `flock-mark-white.svg`) en `src/styles/flock/` y `docs/design/`. **No inventar tokens** si faltan los archivos: pedirlos.

### 5.2 Reglas obligatorias (de la skill)
- **Solo tokens documentados:** colores, radios, sombras y tamaños tipográficos salen de `tokens.css`, siempre como variables CSS (`var(--brand)`, `var(--text-soft)`), nunca hex sueltos en el código.
- **Tipografía del sistema, sin web fonts.** Encaja con la CSP de `architecture.md` §4.1, que no permite recursos remotos.
- **Espaciado base 4** y la escala de radios documentada.
- **Acción principal con `--brand`;** `--accent` solo para énfasis puntual.
- **Superficies escalonadas:** tarjetas y paneles sobre `--panel`, nunca sobre el tinte del lienzo (`--surface` / `--brand-softer`). Para la barra lateral persistente, usar el **sidebar oscuro de marca** (`--nav-gradient`).
- **Números y tablas densas con `.text-mono`** (`--font-mono` + `tabular-nums`): KPI, tablas de unidades, carga por persona, días en estado.
- **Componentes y patrones según la referencia** (`references/design-system.md` §5 y §6): botones, campos, chips, tarjetas, modales, toasts, pestañas, barra de filtros y tabla de datos. No improvisar variantes.
- **Modo oscuro** opcional vía `html.dark` (P1). Si se implementa, respetar que `--brand` cambia en oscuro.
- Íconos de línea según la referencia (§4): grilla de 24 px, `stroke-width: 1.7`, `currentColor`. Sin librerías de íconos externas.

### 5.3 Cómo se aplica en esta app

| Elemento | Componente o patrón del sistema |
|---|---|
| Barra lateral con selector Equipo → Proyecto → Épica | Sidebar oscuro de marca, con `flock-mark-white.svg` |
| Pestañas Integrantes / Proyectos y secciones del dashboard | Navegación por pestañas (§6) |
| Filtros de vista (rango de fechas, unidad/medida en pantalla) | Barra de filtros (§6) |
| Tablas de unidades, estancadas, "Fuera del equipo" | Tabla de datos (§6) con `.text-mono` en columnas numéricas |
| KPI principales (avance del equipo, en curso, estancadas) | Tarjetas; un único KPI destacado con la stat card con gradiente (`.stat-card-hero`) |
| Estado de cada unidad y categorías de estado | **Triplete de colores de estado** de `tokens.css` (fondo / texto / barra) |
| Formularios de administración | Campos de formulario y botones (§5) |
| Confirmaciones (eliminar, mover épica, reasignar proyecto) | Overlays / modal (§5) |
| Mensajes de error y éxito (conexión, sincronización) | Toasts (§5) |

**Mapeo de categorías a colores de estado:**

| Categoría de la app | Estado del sistema |
|---|---|
| `todo` | Pendiente |
| `doing` | En progreso |
| `done` | Completado |
| Estancada (marca adicional) | Bloqueado |

**Gráficos (Chart.js):** los colores se leen en tiempo de ejecución de las variables CSS (`getComputedStyle`) y usan los mismos tokens de estado y marca; nada de paletas por defecto de la librería. Tipografía de ejes y etiquetas con la pila del sistema y números en mono.

---

## 6. Pantallas

### 6.1 Administración
1. **Conexión Jira** — asistente la primera vez: URL con **"Verificar"** (`/api/connection/verify`), email y token con **"Probar"** (`/api/connection/test`), particularidades (método de vínculo de épicas propuesto en `auto`, mapeo de estados). Después, pantalla editable; el token solo se reemplaza.
2. **Equipos** — listado con cantidad de integrantes, proyectos y épicas; crear, editar, activar/desactivar, eliminar (si no tiene proyectos). Dentro de cada equipo, pestañas **Integrantes** y **Proyectos**.
3. **Integrantes** — buscador con autocompletado contra `/api/jira/users` (mínimo 2 caracteres, debounce ~300 ms). Resultado con iniciales, nombre y email si viene. "Agregar" toma los datos de Jira; si la persona ya está en otros equipos, se indica. Marca si la cuenta fue desactivada en Jira.
4. **Proyectos** — crear, editar, activar/desactivar, reasignar de equipo, eliminar (si no tiene épicas). **Medición:** unidad y medida (lista de campos numéricos de `/api/jira/fields`).
5. **Épicas del proyecto** — agregar por clave (validada con `/api/jira/epics/:key`: existe y es de nivel épica); ofrecer moverla si está en otro proyecto; activar/desactivar, mover, quitar; última sincronización (`lastOkAt` de `shardsMeta`), estado si falló, y método de vínculo detectado. Búsqueda por texto en P1.
6. **Configuración general** — días hábiles para estancada y envejecida; mapeo de estados (overrides de categoría); habilitar IA para informes (la API key se carga por `PUT /api/ai/key`, de solo escritura).
7. **Sincronización** — sincronizar ahora, carga completa, progreso (`/api/sync/status`), épicas con falla (`shardsMeta`) y fecha de datos.
8. **Diagnóstico** — la página del flujo 1 queda accesible desde administración para soporte.

### 6.2 Dashboard del equipo
- Barra lateral persistente: selector de **Equipo → Proyecto → Épica** (estado de vista). El equipo carga los datos de todos sus proyectos activos; proyecto y épica filtran en pantalla sin pedir datos.
- Encabezado: equipo, proyectos y épicas incluidos, integrantes, fecha de datos, aviso si el dataset no está al día, acceso a "Fuera del equipo".
- Métricas de la sección 7. Cada número abre la lista de unidades que lo componen; cada issue se abre en Jira con `openInJira` (`architecture.md` §4.1).

### 6.3 Fuera del equipo
- Bloques F1–F2 (sección 7), mismos filtros.
- En "Asignado a otras personas", acción **"Agregar al equipo"** que abre la búsqueda de integrantes precargada (el alta siempre sale de Jira).

### 6.4 Informes
- Ver sección 8.

---

## 7. Métricas

Funciones puras en `shared/domain/metrics`, con tests `node --test` sobre filas de ejemplo.

### Definiciones
- **Abierta:** `statusCategory !== 'done'`.
- **Días hábiles:** lunes a viernes, sin feriados (feriados como evolución).
- **Días en estado:** días hábiles desde `statusSince` hasta hoy.
- **Estancada:** unidad abierta con **más de `staleBusinessDays` días hábiles en el mismo estado** (default 5). Si cambia de estado, el contador vuelve a cero.
- **Fecha de cierre:** `doneAt`.

### P0 — corte mínimo

| # | Métrica | Definición | Visualización |
|---|---|---|---|
| M1 | **Avance por proyecto y por épica** | `hechas / total` en la medida del proyecto. Por proyecto: suma de unidades de sus épicas activas (no promedio de porcentajes) | Barra por proyecto, desplegable por épica, porcentaje y números absolutos |
| M2 | **Distribución por estado** | Unidades por estado real, agrupadas por categoría | Barra apilada por épica, tooltip con el nombre del estado |
| M3 | **Trabajo en curso** | Unidades en `doing`, total y por integrante | Tarjeta KPI + detalle |
| M4 | **Carga por persona** | Por integrante: abiertas por categoría (y medida si aplica), solo de los proyectos del equipo. **Capacidad**, orden alfabético, sin ranking | Barras horizontales apiladas |
| M5 | **Estancadas** | Abiertas con días en estado > umbral. Clave, resumen, estado, responsable, días | Tarjeta KPI + tabla |
| M6 | **Throughput semanal** | Unidades con `doneAt` por semana ISO, últimas 8 semanas | Barras |

### Fuera del equipo (P0)

| # | Bloque | Definición |
|---|---|---|
| F1 | **Sin asignar** | Abiertas sin responsable en las épicas del equipo |
| F2 | **Asignado a otras personas** | Abiertas asignadas a personas que no son del equipo, agrupadas por persona |

### P1 — si hay tiempo

| # | Métrica | Definición |
|---|---|---|
| M7 | **Cycle time** | Cerradas en los últimos 60 días: días hábiles entre `firstDoingAt` y `doneAt`. Mediana y percentil 85 |
| M8 | **Antigüedad del trabajo en curso** | En `doing`, ordenadas por días hábiles desde `firstDoingAt`; resaltar las que superan `agingBusinessDays` |
| M9 | **Vencidas** | Abiertas con `dueDate` anterior a hoy (comparar como fecha calendario) |
| M10 | **Burn-up por épica** | Acumulado diario de unidades creadas vs. cerradas |
| F3 | **Cerrado por otras personas** | Cerradas en las últimas 4 semanas por personas fuera del equipo |

### Reglas transversales
- Si un dato no está disponible (sin valores en el campo de medida, sin historial, sin vencimientos), la tarjeta lo dice; nunca un 0 engañoso.
- En proyectos con unidad `both`, cada tarjeta muestra las dos mediciones.
- **Nada de rankings ni comparativas entre personas.**
- Fuera de alcance: predicción de desvíos, comparaciones entre equipos, presupuesto.

---

## 8. Informes

Cubren la parte de "informes de sprint" e "informes de cliente" del challenge.

### 8.1 Generación determinista (P0)
- Botones **"Informe de sprint"** e **"Informe para cliente"** en el dashboard del equipo, sobre un **rango de fechas** (por defecto, las últimas 2 semanas).
- Se arman en Markdown con plantillas, a partir de las métricas ya calculadas:
  - **Sprint (interno):** avance por proyecto y épica, cerrado en el período, en curso, estancadas, bloqueos visibles (estancadas + sin asignar), carga por persona.
  - **Cliente (externo):** avance por proyecto y épica, entregables cerrados en el período, próximos pasos (en curso). **Sin nombres de personas, sin "Fuera del equipo", sin estancadas ni detalles internos.**
- Vista previa en la app + **copiar al portapapeles** (`copyText`) y **guardar como `.md`** (`saveMarkdown`), ambos por el puente del preload (`architecture.md` §4.1).
- Fechas del período sobre el calendario local (`architecture.md` §9): "cerrado en el período" usa la fecha calendario local de `doneAt`.

### 8.2 Redacción con IA (opcional, desactivada por defecto)
- Si `settings.ai.enabled` y hay API key: botón "Redactar con IA" que envía **solo las métricas agregadas del informe ya generado** (y claves/títulos de issues si el informe los incluye) a `POST /api/reports/ai`. El proxy hace la llamada; la API key nunca llega al renderer.
- Aviso previo de qué datos se envían.
- El modelo **solo redacta**: no calcula cifras. Los números del texto final se comparan con los de la plantilla con una función pura del dominio; si no coinciden, se muestra una advertencia.
- El proxy solo puede salir hacia el proveedor de IA cuando la IA está habilitada (`architecture.md` §4.4).
- Textos de issues tratados como datos, nunca como instrucciones.
- Sin envío automático ni escritura en Jira: el usuario revisa y copia.

---

## 9. Fases del flujo 2

Tiempos orientativos con la base del flujo 1 lista.

### Fase A — Base visual, conexión y administración (≈ 1 h 30)
- **Primero, base visual con la skill `flock-design-system`** (sección 5): `tokens.css` en `:root`, tipografía del sistema, shell de la app con sidebar oscuro de marca y logo, y los componentes base (botón, campo, tarjeta, tabla, pestañas, modal, toast) según la referencia. Todas las pantallas siguientes los reutilizan.
- Asistente de conexión, equipos con pestañas, integrantes desde Jira, proyectos con medición, épicas por clave, reglas de integridad en `validateConfig`.

**Listo cuando:** la app usa los tokens del sistema (sin colores sueltos); con `example.atlassian.net` se crea un equipo con dos integrantes buscados en Jira y un proyecto con dos épicas validadas y medición configurada; persiste tras reiniciar; intentar cargar una épica en un segundo proyecto ofrece moverla.

### Fase B — Datasets de negocio (≈ 30 min)
- Fuente `projectIssues` por proyecto: épicas activas → hijos → subtareas, campos de medición del proyecto, proyección `IssueRow`.
- Refresco de los campos mantenidos por la sincronización: integrantes y datos de épicas (`architecture.md` §6.7).
- `POST /api/sync` para todos los proyectos activos, con progreso.

**Listo cuando:** `validate-scope.mjs` coincide por conjunto de claves con el JQL equivalente para un proyecto real, y un segundo refresco usa delta.

### Fase C — Dashboard y "Fuera del equipo" (≈ 1 h 45)
- `work-units`, `teamScope`, `teamOutside`, `businessDaysBetween`, métricas M1–M6 y F1–F2 con tests.
- Orden de implementación de la medición: `task` + cantidad → medida por campo → `subtask` → `both`.
- UI del dashboard, aviso de tareas sin subtareas, drill-down, "Fuera del equipo" con "Agregar al equipo".

**Listo cuando:** las cifras se verifican a mano contra Jira para una épica, cada número abre su lista, lo no asignado al equipo aparece solo en su apartado, y estados y gráficos usan los colores de estado del sistema.

### Fase D — Informes (≈ 45 min)
- Plantillas de sprint y cliente, vista previa, copiar y guardar.

**Listo cuando:** el informe de cliente no contiene ningún nombre de persona (test automático) y sus cifras coinciden con el dashboard.

### Fase E — Cierre (≈ 30 min)
- README: instalación, cómo obtener el API token de Atlassian, permisos recomendados (lectura), uso, arquitectura (resumen y enlace a `architecture.md`), seguridad de la base y recuperación, decisiones, limitaciones y evolución.
- Fixtures anonimizadas para el modo `--demo` (`architecture.md` §10.1) y capturas para la demo.

**Corte mínimo demostrable: fases A a E.** Total del flujo 2 ≈ 5 h; sumando el flujo 1 (≈ 2 h 30 a 3 h), ≈ 7 h 30 a 8 h.

### Si sobra tiempo (en este orden)
1. Redacción con IA de los informes (8.2).
2. Métricas P1 (M7–M10, F3).
3. Modo oscuro según la skill (`html.dark`).
4. Búsqueda de épicas por texto.
5. Exportar / importar configuración (sin token ni datos de issues), para recuperar la configuración si se pierde la clave.
6. Empaquetado con `electron-builder` y prueba de la app instalada.

### Evolución (documentar en el README, no construir)
Consultas MCP a Jira y Flocktools desde la app, sprints por la API Agile, feriados en días hábiles, tooling completo (Biome, husky, CI).

---

## 10. Reglas para el agente

1. Respetar `architecture.md`: el cliente nunca lee `customfield_*`, claves solo vía `resolveTarget`, configuración solo vía `normalizeConfig`, nada derivado persistido.
2. **No inventes** endpoints, campos ni parámetros de Jira. Ante la duda, **VERIFICAR** con una llamada real de solo lectura.
3. **Nunca** escribas en Jira. Nunca expongas el token, la clave de datos ni la API key de IA al renderer.
4. Métricas en funciones puras con tests; la IA nunca calcula cifras.
5. Lo que dependa de nombres de estados, tipos o campos debe ser configurable o derivado de la API, y manejado por id.
6. Al terminar cada fase, correr tests y app, y anotar en `docs/decisions.md`.
7. Ante una decisión de producto no cubierta, elegir la opción más simple, anotarla y seguir.
8. **UI solo con la skill `flock-design-system`:** leer su `SKILL.md` antes de construir pantallas, usar únicamente tokens vía variables CSS, y seguir la referencia para cada componente y patrón. Nada de colores, tamaños, fuentes ni librerías de componentes ajenas al sistema.

---

## 11. Decisiones tomadas con el usuario

- Un solo Jira Cloud; sin multi-cliente ni Data Center.
- Proyecto propio de la app, de **un solo equipo**; un equipo puede tener varios proyectos.
- Épica en un único proyecto.
- Integrantes traídos desde Jira por `accountId`; una persona puede estar en varios equipos.
- Alcance: solo integrantes del equipo revisado; el resto va a "Fuera del equipo".
- Medición configurable por proyecto: unidad (tareas por defecto, subtareas o ambas) y medida (cantidad o un campo numérico).
- Método de vínculo de épicas configurable (`parent`, `epic_link`, `auto`).
- Base accesible solo desde la app (contenido cifrado con clave protegida por Windows).
- Estancada: más de 5 días hábiles en el mismo estado, configurable.
- Diseño visual con la skill `flock-design-system` (Flock Design System v1.1).
- Arquitectura: proxy en proceso, `node:sqlite`, store con signals; el token nunca sale del proceso principal.
