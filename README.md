# copiloto-alerts

Pipeline de datos abiertos de alertas oficiales de la DGT (radares fijos, incidencias de tráfico)
más el catálogo de tipos de reporte, para **Copiloto**, el navegador GPS nativo de Repostar.
Se publica como repositorio público independiente (`dismagest/copiloto-alerts`) con GitHub Pages,
siguiendo el mismo patrón que [`repostar-data`](https://github.com/dismagest/repostar-data) para
los precios de carburantes.

## Qué publica

- **Radares fijos y de tramo** (`src/radares.ts`): posiciones puntuales o secciones
  inicio/fin, carretera, sentido y velocidad si el feed la incluye.
- **Incidencias de tráfico** (`src/incidencias.ts`): accidentes, peligros en la vía, cortes y
  carriles cerrados, retenciones, obras y tiempo adverso, con el texto original de la DGT.
- **Catálogo de tipos de reporte** (`catalogo.json`): además de los tipos oficiales de la DGT
  anteriores, define los tipos que puede reportar el propio usuario en la app (policía, radar
  móvil, precio distinto...), con el texto que dice el asistente de voz, el color/icono del
  mapa y cuánto dura cada aviso antes de caducar (`ttlMin`) o de que otro usuario lo pueda
  refrescar (`extendMin`).
- **Tráfico en vivo** (`src/detectores.ts`): los 5.518 detectores de la DGT con medida reciente,
  fusionados por punto y sentido, con la velocidad, el nivel (`free`/`slow`/`jam`), el `ratio`
  contra la velocidad de referencia de esa vía y el rumbo de circulación calculado a partir del PK.
- **Histórico de tráfico** (`src/estado.ts`): perfil de 168 franjas (hora de la semana en hora de
  Madrid) por detector, acumulado con una media móvil exponencial; solo se publican los detectores
  con 20 muestras o más en alguna franja.
- **Tráfico de los propios usuarios** (`src/trazas.ts`): los trayectos anónimos que la app sube a
  Supabase Storage, agregados en cuadrículas de 100 m y ocho sectores de rumbo. Nunca se publica un
  punto suelto ni nada que identifique a nadie: solo la media y el recuento de cada cuadrícula.

Las capas se recortan en **celdas de un grado** (`src/cells.ts`, `cellOf`) sobre la caja que
cubre España peninsular, Baleares, Canarias y el entorno próximo (`CELL_BOUNDS`), para que
Copiloto solo descargue las celdas cercanas a la ruta en curso.

## Fuente y licencia

Los datos de radares e incidencias proceden del **NAP (National Access Point) de la DGT**, en
formato DATEX II (`https://nap.dgt.es/`). Se reutilizan citando la fuente («Dirección General de
Tráfico») y conforme al [aviso legal de la DGT](https://www.dgt.es/contenido/aviso-legal/). El
catálogo de tipos de reporte de usuario (policía, radar móvil, precio...) es contenido propio de
Copiloto, no de la DGT.

## Contrato de ficheros (v1)

Publicados en la raíz del sitio de GitHub Pages:

| Fichero | Contenido |
| --- | --- |
| `meta.json` | `{ contractVersion, generatedAt, sources, cells: { radares, incidencias, trafico, historico, usuarios }, discarded: { outOfCoverage, byType } }`. `cells.*` solo lista las celdas que tienen contenido; `sources.<radares\|incidencias>` es `{ fetchedAt, records, ok, error? }`, `sources.trafico` añade `withSpeed` y `sources.traces` es `{ fetchedAt, files, points, ok, error? }`. `discarded.byType` cuenta las incidencias descartadas por motivo. `contractVersion` sigue siendo **1**: la fase D solo AÑADE claves, y subirla dejaría sin capa de alertas a las versiones ya instaladas de la app. |
| `catalogo.json` | Copia tal cual de `catalogo.json` (raíz de este repo): catálogo de tipos de alerta. |
| `radares/<celda>.json` | Array de `Radar` (ver `src/radares.ts`) cuyo punto de inicio cae en esa celda de un grado (`${floor(lat)}_${floor(lng)}`), ordenado por `id`. Solo existen ficheros para celdas con contenido. |
| `incidencias/<celda>.json` | Array de `Incidencia` (ver `src/incidencias.ts`), mismo criterio de celda y orden. |
| `trafico/<celda>.json` | Array de `TrafficSite` (ver `src/detectores.ts`): `{ id, lat, lng, road, bearing, speedKmh, level, ratio, measuredAt }`, misma celda de un grado y mismo orden por `id`. |
| `trafico/historico/<celda>.json` | Array de `TrafficHistorySite` (ver `src/estado.ts`): `{ id, lat, lng, road, bearing, profile }` con 168 posiciones (`number \| null`), franja 0 = lunes 00:00 en hora de Madrid. |
| `trafico/usuarios/<celda>.json` | Array de `UserTrafficSite` (ver `src/trazas.ts`): igual que `trafico/<celda>.json` más `points`, con `id = "u:<celda100>_<sector>"`. |
| `trafico/estado.json` | Estado interno acumulado (`src/estado.ts`): referencia por detector, perfil horario, perfil de las cuadrículas de usuarios y ubicaciones cacheadas. La app **no** lo lee; lo recupera la vuelta siguiente con `--prev-estado`. |

Lo que cae fuera de `CELL_BOUNDS` (España peninsular, Baleares, Canarias y entorno próximo) se
descarta y se cuenta en `meta.json#discarded.outOfCoverage`.

## El catálogo de tipos y cómo apagar un tipo

`catalogo.json` es la fuente única: `buildOutputs` lo copia tal cual a `out/catalogo.json`, y
desde ahí la Tarea 6 lo copia a `copiloto-android/app/src/main/assets/catalogo.json` para que la
app lo lleve embebido. Cada tipo tiene:

- `key`, `name`, `family` (`police | radars | hazards | traffic | weather | price`), `icon`, `color`.
- `enabled`: si es `false`, Copiloto deja de ofrecer/anunciar ese tipo. **Para apagar un tipo sin
  tocar código**, edita `catalogo.json`, pon `"enabled": false` en la entrada correspondiente y
  haz commit; la siguiente ejecución del workflow lo publica y, si no es `official`, también lo
  sincroniza (`enabled=false`) en la tabla `report_types` de Supabase.
- `ttlMin` / `extendMin`: minutos que dura un aviso antes de caducar y minutos en los que otro
  conductor puede "refrescarlo" en vez de crear uno nuevo.
- `priority`: orden de aviso por voz cuando coinciden varias alertas.
- `official`: `true` marca los tipos que solo vienen de la DGT (p. ej. `fixed_camera`); esos no se
  ofrecen en la hoja de reporte del usuario ni se sincronizan contra `report_types`.
- `voice`: `announce` (obligatorio salvo `priority = 0`, con `{distance}` que rellena el motor de
  navegación con `spokenDistance`), `announceWithLimit` opcional con `{limit}`, `near` y
  `synonyms` para el reconocimiento de voz.
- `subtypes`: variantes que puede elegir el usuario al reportar (p. ej. accidente leve/grave).

`loadCatalogo()` (`src/catalogo.ts`) lee y parsea el fichero; `validateCatalogo()` comprueba que
no haya claves repetidas, que `family` sea una de las conocidas y que todo tipo con `priority`
distinta de 0 tenga `voice.announce`. El CLI aborta (`exit(5)`) si el catálogo no es válido.

## Sincronización con Supabase (`src/supabase.ts`)

Se ejecuta **solo en GitHub Actions**, nunca desde la app, con la clave secreta como secreto del
repositorio (`SUPABASE_SECRET_KEY`, más `SUPABASE_URL` en el propio workflow):

- `syncReportTypes(catalogo, env)`: hace *upsert* de los tipos no oficiales en `report_types` vía
  PostgREST (`Prefer: resolution=merge-duplicates,return=minimal`, `?on_conflict=key`).
- `cleanupTraces(env, now, maxAgeDays?, pageSize?)`: lista las carpetas `yyyy-mm-dd` del bucket
  `traces` (paginando por `offset`/`limit` hasta agotar el listado, igual que el listado de
  objetos dentro de cada carpeta) y borra los objetos de más de 30 días.

Ambas son caras o firman con la clave secreta con más frecuencia de la necesaria, así que
`cli.ts` solo las llama cuando `isDailyMaintenanceWindow(now)` (`src/schedule.ts`) es cierto: la
hora UTC actual cae entre las 04:00 y las 04:09 (una vez al día, en la ejecución de las 04:0x del
cron de 10 minutos), salvo `--skip-supabase` o si faltan las variables de entorno.

## Cómo se ejecuta

### En GitHub Actions

`.github/workflows/alerts.yml` corre cada 10 minutos (`*/10 * * * *`, más `workflow_dispatch`),
descarga las dos fuentes de la DGT, genera las salidas y las publica en GitHub Pages con
`actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages`. Usa
`--prev-meta` con la URL del propio `meta.json` publicado para poder conservar el `fetchedAt`
anterior si una fuente falla. `.github/workflows/keepalive.yml` hace un commit trivial semanal
para que GitHub no desactive el cron tras 60 días de inactividad en el repo.

El workflow descarga además `trafico/estado.json` del Pages anterior (`PREV_ESTADO`) y lo pasa con
`--prev-estado`: es el acumulado de referencias y perfiles horarios. Si falta (primera ejecución) o
la descarga falla, se parte de cero y el estado se reconstruye solo en unos días.

Secreto necesario en el repositorio de GitHub: `SUPABASE_SECRET_KEY`.

### En local

```bash
npm install
npx vitest run copiloto-alerts   # desde la raíz del monorepo (repo GASOLINERA APP)
npx tsc --noEmit -p copiloto-alerts
```

Este repo no lleva su propio `vitest` como dependencia (igual que `repostar-data`, no incluye un
test runner propio): los tests se ejecutan desde el monorepo, que sí lo tiene. Cuando se publique
como repositorio independiente (`dismagest/copiloto-alerts`), correr los tests requiere tener
`vitest` disponible (p. ej. `npx --package vitest vitest run`).

Requiere Node ≥ 24 (ejecuta TypeScript directo con *type stripping*, sin paso de compilación).
Única dependencia de producción: `fast-xml-parser`.

CLI, contra los fixtures (reproducible, sin tocar la red ni Supabase):

```bash
node src/cli.ts run --out out --skip-supabase \
  --radares fixtures/radares.xml --incidencias fixtures/incidencias.xml
```

Contra las fuentes reales (descarga con reintento y publica en Supabase si hay credenciales):

```bash
SUPABASE_URL=... SUPABASE_SECRET_KEY=... node src/cli.ts run --out out
```

Flags: `--out <dir>` (por defecto `out`), `--skip-supabase` (omite la sincronización aunque haya
credenciales), `--radares <url|fichero>` y `--incidencias <url|fichero>` (si la ruta existe en
disco se lee el fichero, si no se trata como URL con `AbortSignal.timeout(60_000)` y un
reintento tras 10 s), `--prev-meta <url|fichero>` (para recuperar el `fetchedAt` anterior si una
fuente falla). Si fallan las dos fuentes, el CLI sale con código 4 y no publica nada; si falla
solo una, publica la otra y dejan constancia del fallo en `meta.json#sources`.

`fixtures/radares.xml` y `fixtures/incidencias.xml` son descargas reales de los feeds del NAP,
usadas para validar los parsers contra la estructura real de la DGT (no ejemplos simplificados).

> Nota: URL del NAP verificadas el 2026-09-08; el catálogo de datasets está en
> https://nap.dgt.es/dataset/radares-fijos-dgt y
> https://nap.dgt.es/dataset/incidencias-dgt-datex2-v3-7
