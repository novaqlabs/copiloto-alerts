/**
 * CLI de copiloto-alerts.
 *
 *   node src/cli.ts run --out <dir> [--skip-supabase] [--radares <url|fichero>] [--incidencias <url|fichero>]
 *                       [--detectores-medidas <url|fichero>] [--detectores-ubicaciones <url|fichero>]
 *                       [--prev-meta <url|fichero>] [--prev-estado <url|fichero>]
 *                       [--prev-osm-cameras <url|fichero>] [--refresh-osm-cache]
 *
 * Variables de entorno (solo se leen en GitHub Actions; nunca hardcodeadas):
 *   SUPABASE_URL, SUPABASE_SECRET_KEY
 *
 * NOTA: URL del NAP verificadas el 2026-09-08; el catálogo de datasets está en
 * https://nap.dgt.es/dataset/radares-fijos-dgt y
 * https://nap.dgt.es/dataset/incidencias-dgt-datex2-v3-7
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadCatalogo, validateCatalogo } from './catalogo.ts';
import { parseRadares, type Radar } from './radares.ts';
import { parseIncidencias, type Incidencia } from './incidencias.ts';
import { buildOutputs, writeOutputs, type SourceMeta, type SourcesMeta, type TracesSourceMeta } from './outputs.ts';
import { cleanupTraces, existingTraceKm, insertTraceKm, listObjects, readObject, syncReportTypes, type SupabaseEnv } from './supabase.ts';
import { collectTraces, pendingTraceKm, updateTraces, userSites, type UserTrafficSite } from './trazas.ts';
import { isDailyMaintenanceWindow } from './schedule.ts';
import {
  OSM_CACHE_PATH,
  OSM_MATCH_MAX_M,
  OSM_QUERY_TIMEOUT_MS,
  OSM_SPAIN_TIMEOUT_MS,
  OVERPASS_ENDPOINT,
  OverpassAbortError,
  emptyOsmCameraCache,
  overpassCamerasQuery,
  overpassSpainQuery,
  parseOsmCameraCache,
  parseOverpassCameras,
  refreshAndMatchOsmCameras,
  type OsmCamera,
  type OsmCameraCache,
} from './osm-cameras.ts';
import {
  bearingForDetectors,
  buildTrafficSites,
  parseDetectorLocations,
  parseDetectorMeasurements,
  publicationTimeOf,
  type TrafficSite,
} from './detectores.ts';
import {
  bearingsFromEstado,
  emptyEstado,
  historicoSites,
  locationsAreStale,
  locationsFromEstado,
  parseEstado,
  pruneTraces,
  referenceFor,
  updateEstado,
  type Estado,
  type TrafficHistorySite,
} from './estado.ts';

const DEFAULT_RADARES_URL = 'http://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml';
const DEFAULT_INCIDENCIAS_URL = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml';
const DEFAULT_DETECTORES_MEDIDAS_URL = 'http://infocar.dgt.es/datex2/dgt/MeasuredDataPublication/detectores/content.xml';
const DEFAULT_DETECTORES_UBICACIONES_URL = 'http://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/detectores/content.xml';

const USER_AGENT = 'copiloto-alerts/1.0 (+https://buscagasolina.com)';
const FETCH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 10_000;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Lee un fichero local si `source` existe en disco; si no, lo trata como URL con un reintento tras 10 s. */
async function readSource(source: string): Promise<string> {
  if (existsSync(source)) return readFile(source, 'utf8');
  try {
    return await fetchOnce(source);
  } catch (e) {
    log(`reintento tras fallo (${e instanceof Error ? e.message : e})`);
    await sleep(RETRY_DELAY_MS);
    return fetchOnce(source);
  }
}

interface PrevMeta {
  sources?: {
    radares?: { fetchedAt?: string };
    incidencias?: { fetchedAt?: string };
    trafico?: { fetchedAt?: string };
  };
}

async function loadPrevMeta(source: string | undefined): Promise<PrevMeta | undefined> {
  if (!source) return undefined;
  try {
    const text = existsSync(source) ? await readFile(source, 'utf8') : await fetchOnce(source);
    return JSON.parse(text) as PrevMeta;
  } catch (e) {
    log(`prev-meta: no se pudo leer (${e instanceof Error ? e.message : e}), se ignora`);
    return undefined;
  }
}

/**
 * Estado acumulado de la vuelta anterior (`trafico/estado.json` del Pages publicado, decision D12).
 * Cualquier fallo -no existe todavia, la CDN devuelve 404, el JSON esta truncado- se traga aqui y
 * se parte de cero: el estado se reconstruye solo en unos dias.
 */
async function loadPrevEstado(source: string | undefined, now: Date): Promise<Estado> {
  if (!source) return emptyEstado(now);
  try {
    const text = existsSync(source) ? await readFile(source, 'utf8') : await fetchOnce(source);
    const estado = parseEstado(text);
    if (!estado) {
      log('prev-estado: contenido no valido o de otra version, se parte de cero');
      return emptyEstado(now);
    }
    return estado;
  } catch (e) {
    log(`prev-estado: no se pudo leer (${e instanceof Error ? e.message : e}), se parte de cero`);
    return emptyEstado(now);
  }
}

async function loadSource(
  name: 'radares' | 'incidencias' | 'trafico',
  source: string,
  now: Date,
  prevMeta: PrevMeta | undefined,
): Promise<{ text?: string; meta: SourceMeta }> {
  try {
    const text = await readSource(source);
    return { text, meta: { fetchedAt: now.toISOString(), records: 0, ok: true } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`${name}: fallo (${error})`);
    const fetchedAt = prevMeta?.sources?.[name]?.fetchedAt ?? now.toISOString();
    return { meta: { fetchedAt, records: 0, ok: false, error } };
  }
}

function supabaseEnvFromProcess(): SupabaseEnv | undefined {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  return url && secretKey ? { url, secretKey } : undefined;
}

/**
 * Ruta de la SEMILLA local de la caché de OSM, resuelta desde ESTE fichero (`src/`), no desde el
 * cwd: `data/osm-cameras.json`, commiteada en el repo como respaldo (item 7 del repaso final) y
 * como destino de `--refresh-osm-cache` para sembrarla en local.
 */
const OSM_CACHE_URL = new URL('../data/osm-cameras.json', import.meta.url);

/**
 * Publicación por defecto de `PREV_OSM_CAMERAS` (item 7 del repaso final): la caché de la vuelta
 * anterior en el Pages propio, mismo patrón que `PREV_META`/`PREV_ESTADO`
 * (`.github/workflows/alerts.yml`).
 */
const DEFAULT_PREV_OSM_CAMERAS_URL = 'https://novaqlabs.github.io/copiloto-alerts/osm-cameras.json';

/**
 * Carga la caché de OSM SIN depender de que nadie la commitee a mano (item 7 del repaso final,
 * Important I1 del informe original): primero intenta [source] -la publicación propia de
 * `out/osm-cameras.json` en GitHub Pages, `PREV_OSM_CAMERAS`, mismo patrón que
 * `loadPrevMeta`/`loadPrevEstado`, URL o fichero local según [existsSync]-; si la descarga falla o
 * el JSON no tiene la forma esperada (primera vez que se publica, CDN con 404, caché truncada) cae
 * al fichero SEMILLA del repo ([OSM_CACHE_URL]) como respaldo.
 */
async function loadOsmCameraCache(source: string | undefined): Promise<OsmCameraCache> {
  if (source) {
    try {
      const text = existsSync(source) ? await readFile(source, 'utf8') : await fetchOnce(source);
      const cache = parseOsmCameraCache(text);
      if (cache) return cache;
      log('osm: la publicacion previa no tiene el formato esperado, se usa la semilla del repo');
    } catch (e) {
      log(`osm: no se pudo leer la publicacion previa (${e instanceof Error ? e.message : e}), se usa la semilla del repo`);
    }
  }
  try {
    return parseOsmCameraCache(await readFile(OSM_CACHE_URL, 'utf8')) ?? emptyOsmCameraCache();
  } catch (e) {
    log(`osm: no se pudo leer la semilla del repo (${e instanceof Error ? e.message : e}), se parte de cero`);
    return emptyOsmCameraCache();
  }
}

/**
 * Los nodos `highway=speed_camera` de una celda, con el User-Agent propio y el mismo tiempo limite
 * por celda que el presupuesto agregado usa como unidad ([OSM_QUERY_TIMEOUT_MS], item 8).
 *
 * 429/504: Overpass esta saturado. En vez de un `Error` normal (que `refreshOsmCameras` tragaria y
 * seguiria con la siguiente celda) se lanza [OverpassAbortError], que le dice que abandone TODAS
 * las celdas que quedan de esta vuelta -no tiene sentido martillear con ~30 consultas mas un
 * servicio publico que ya esta diciendo que pares (revision de la Task 4, hallazgo Minor #4)-.
 */
async function fetchOverpassCameras(cell: string): Promise<OsmCamera[]> {
  // Siembra real del 2026-09-17: sin pausa entre celdas, Overpass devolvia 429 a la tercera
  // consulta y la vuelta abortaba con 2 de ~30 celdas. Una pausa corta entre consultas y UN
  // reintento tras esperar ante el primer 429 caben de sobra en el presupuesto de 120 s
  // (OSM_REFRESH_BUDGET_MS); un segundo 429, o un 504, siguen abortando la vuelta entera.
  if (overpassConsultas > 0) await esperar(OVERPASS_PAUSA_MS);
  overpassConsultas++;
  let res = await consultarOverpass(cell);
  if (res.status === 429) {
    await esperar(OVERPASS_ESPERA_429_MS);
    res = await consultarOverpass(cell);
  }
  if (res.status === 429 || res.status === 504) throw new OverpassAbortError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOverpassCameras(await res.text());
}

/** Consulta nacional única (ver `fetchAll` en osm-cameras.ts): una petición en vez de ~30. */
async function fetchOverpassSpain(): Promise<OsmCamera[]> {
  const res = await fetch(process.env.OVERPASS_ENDPOINT ?? OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: overpassSpainQuery() }),
    signal: AbortSignal.timeout(OSM_SPAIN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOverpassCameras(await res.text());
}

const OVERPASS_PAUSA_MS = 1_500;
const OVERPASS_ESPERA_429_MS = 20_000;
let overpassConsultas = 0;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consultarOverpass(cell: string): Promise<Response> {
  // OVERPASS_ENDPOINT en el entorno permite sembrar contra un espejo cuando el principal va saturado.
  return fetch(process.env.OVERPASS_ENDPOINT ?? OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: overpassCamerasQuery(cell) }),
    signal: AbortSignal.timeout(OSM_QUERY_TIMEOUT_MS),
  });
}

/**
 * Cruza los radares de la DGT con los de OpenStreetMap («Mejoras 1», spec §1.4). NUNCA lanza ni
 * bloquea la publicacion, y CADA radar publicado lleva `source_position` (revision de la Task 4,
 * hallazgo Important #2: la version anterior, si `writeFile` fallaba al escribir la cache en disco,
 * caia por el `catch` exterior y devolvia los radares SIN esa clave en absoluto).
 *
 * El grueso de la logica -refrescar la cache si toca (decision M10: mas de siete dias Y ventana
 * diaria de mantenimiento, o [forceOsmRefresh]) y cruzar, con presupuesto agregado de 120 s (item
 * 8)- vive en `refreshAndMatchOsmCameras` (osm-cameras.ts), que ya garantiza que un fallo al
 * escribir en disco no afecta al cruce ya calculado en memoria. Esta funcion aporta la red y el
 * disco de verdad, y el log.
 *
 * `out/osm-cameras.json` se escribe SIEMPRE, refresque o no esta vuelta (item 7): el deploy de
 * GitHub Pages sustituye el sitio entero en cada `deploy-pages`, asi que si solo se escribiera en
 * las vueltas que refrescan, la caché desaparecería de la publicación en la primera vuelta que no
 * lo hiciera -y la vuelta de mañana, que la lee de ahi mismo (`PREV_OSM_CAMERAS`), se quedaría sin
 * nada-. El fichero SEMILLA del repo ([OSM_CACHE_URL]) solo se reescribe con [forceOsmRefresh]
 * (`--refresh-osm-cache`, pensada para que el controlador la siembre en local).
 */
async function cruzarConOsm(
  radares: Radar[],
  now: Date,
  outDir: string,
  prevOsmCamerasSource: string | undefined,
  forceOsmRefresh: boolean,
): Promise<Radar[]> {
  if (radares.length === 0) return radares;
  try {
    const cache = await loadOsmCameraCache(prevOsmCamerasSource);
    const resultado = await refreshAndMatchOsmCameras({
      radares,
      cache,
      now,
      fetchCell: fetchOverpassCameras,
      fetchAll: fetchOverpassSpain,
      forceRefresh: forceOsmRefresh,
      writeCache: async (c) => {
        if (forceOsmRefresh) await writeFile(OSM_CACHE_URL, JSON.stringify(c));
      },
    });

    // En su propio try/catch: un fallo aqui (disco lleno, permisos) no puede tirar por el `catch`
    // exterior y perder el cruce YA calculado -mismo motivo que el `cacheWriteError` interno de
    // `refreshAndMatchOsmCameras` (revision de la Task 4, Important #2)-.
    const outPath = join(outDir, 'osm-cameras.json');
    try {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(resultado.cache));
    } catch (e) {
      log(`osm: no se pudo escribir out/osm-cameras.json (${e instanceof Error ? e.message : e}), la publicacion de Pages se queda sin la cache esta vuelta`);
    }

    if (resultado.refreshed) {
      const presupuesto = resultado.budgetExceeded
        ? ' (presupuesto de 120 s agotado, el resto sigue con la cache o la posicion de la DGT)'
        : '';
      log(`osm: ${resultado.queried} celdas consultadas a Overpass, ${resultado.failed} fallidas${presupuesto}`);
      if (resultado.cacheWriteError) {
        log(`osm: no se pudo escribir la semilla en ${OSM_CACHE_PATH} (${resultado.cacheWriteError}), se sigue con el cruce ya calculado en memoria`);
      } else if (resultado.queried > 0) {
        log(`osm: cache escrita en out/osm-cameras.json${forceOsmRefresh ? ` y sembrada en ${OSM_CACHE_PATH}` : ''}`);
      }
    } else {
      log(`osm: cache del ${cache.updatedAt}, no se consulta Overpass en esta vuelta`);
    }
    log(
      `radares: ${resultado.matched} cruzados con OpenStreetMap, ${resultado.tooFar} sin camara a menos de ${OSM_MATCH_MAX_M} m, ${resultado.withoutOsmData} sin datos de OSM en su celda (de ${radares.length})`,
    );
    return resultado.radares;
  } catch (e) {
    // Red de seguridad ultima: aunque algo de aqui arriba fallase de forma inesperada, cada radar
    // publicado tiene que llevar `source_position` igualmente (revision de la Task 4, Important #2).
    log(`osm: fallo en el cruce (${e instanceof Error ? e.message : e}), se publica la posicion de la DGT`);
    return radares.map((r) => ({ ...r, source_position: 'dgt' as const }));
  }
}

async function run(): Promise<void> {
  const outDir = arg('out', 'out')!;
  const radaresSource = arg('radares', DEFAULT_RADARES_URL)!;
  const incidenciasSource = arg('incidencias', DEFAULT_INCIDENCIAS_URL)!;
  const medidasSource = arg('detectores-medidas', DEFAULT_DETECTORES_MEDIDAS_URL)!;
  const ubicacionesSource = arg('detectores-ubicaciones', DEFAULT_DETECTORES_UBICACIONES_URL)!;
  const prevMetaSource = arg('prev-meta');
  const prevEstadoSource = arg('prev-estado');
  // Item 7 del repaso final: a diferencia de `prev-meta`/`prev-estado`, esta SI tiene un valor por
  // defecto en el propio codigo (no solo en el `env` del workflow) para que `--refresh-osm-cache`
  // en local -sin pasar por `alerts.yml`- tambien la use.
  const prevOsmCamerasSource = arg('prev-osm-cameras', DEFAULT_PREV_OSM_CAMERAS_URL);
  const forceOsmRefresh = has('refresh-osm-cache');
  const skipSupabase = has('skip-supabase');
  const now = new Date();

  log(`inicio: radares=${radaresSource} incidencias=${incidenciasSource} salida=${outDir}`);

  const catalogo = loadCatalogo();
  const catalogoCheck = validateCatalogo(catalogo);
  if (!catalogoCheck.ok) {
    console.error(`ERROR: catalogo.json invalido: ${catalogoCheck.problems.join('; ')}`);
    process.exit(5);
  }

  const prevMeta = await loadPrevMeta(prevMetaSource);
  const [radaresRes, incidenciasRes, medidasRes] = await Promise.all([
    loadSource('radares', radaresSource, now, prevMeta),
    loadSource('incidencias', incidenciasSource, now, prevMeta),
    loadSource('trafico', medidasSource, now, prevMeta),
  ]);

  const estado = await loadPrevEstado(prevEstadoSource, now);
  // Las ubicaciones (18,8 MB) solo se descargan una vez al dia (spec §3.2): el resto de vueltas
  // salen del estado. Un fallo de descarga tampoco es fatal: se sigue con las cacheadas.
  let ubicacionesText: string | undefined;
  if (locationsAreStale(estado, now)) {
    try {
      ubicacionesText = await readSource(ubicacionesSource);
    } catch (e) {
      log(`detectores: fallo al leer las ubicaciones (${e instanceof Error ? e.message : e})`);
    }
  } else {
    log(`detectores: ubicaciones cacheadas del ${estado.locationsAt}, no se vuelven a descargar`);
  }

  if (!radaresRes.text && !incidenciasRes.text) {
    console.error('ERROR: fallaron las dos fuentes, no se publica nada.');
    process.exit(4);
  }

  let radares: Radar[] = [];
  if (radaresRes.text) {
    radares = parseRadares(radaresRes.text);
    radaresRes.meta.records = radares.length;
    log(`radares: ${radares.length} registros`);
    // «Mejoras 1» (spec §1.4): la posicion de OSM cuando la hay. No bloquea la publicacion: si algo
    // falla, `cruzarConOsm` devuelve los radares tal cual y la vuelta sigue.
    radares = await cruzarConOsm(radares, now, outDir, prevOsmCamerasSource, forceOsmRefresh);
  }

  let incidencias: Incidencia[] = [];
  let discardedIncidencias: Record<string, number> = {};
  if (incidenciasRes.text) {
    const { items, discarded } = parseIncidencias(incidenciasRes.text, now);
    incidencias = items;
    discardedIncidencias = discarded;
    incidenciasRes.meta.records = items.length;
    const descartados = Object.values(discarded).reduce((a, b) => a + b, 0);
    log(`incidencias: ${items.length} registros (${descartados} descartados)`);
  }

  // La poda de `traces` no depende de que la DGT haya respondido (re-revision de I2): si el feed
  // de medidas se cae varios dias, `updateTraces` sigue metiendo celdas y la poda tiene que seguir
  // quitandolas.
  pruneTraces(estado, now);

  let trafico: TrafficSite[] = [];
  let traficoWithSpeed = 0;
  let historico: TrafficHistorySite[] = [];
  const locations = ubicacionesText ? parseDetectorLocations(ubicacionesText) : locationsFromEstado(estado);
  const bearings = ubicacionesText ? bearingForDetectors(locations) : bearingsFromEstado(estado);
  if (medidasRes.text && locations.length > 0) {
    const measurements = parseDetectorMeasurements(medidasRes.text);
    const publishedRaw = publicationTimeOf(medidasRes.text);
    const publishedMs = publishedRaw ? Date.parse(publishedRaw) : Number.NaN;
    const publishedAt = Number.isFinite(publishedMs) ? new Date(publishedMs) : now;
    trafico = buildTrafficSites({
      locations,
      measurements,
      publishedAt,
      bearings,
      referenceKmh: (loc) => referenceFor(estado.detectors[loc.id]),
    });
    traficoWithSpeed = trafico.filter((s) => s.speedKmh !== null).length;
    medidasRes.meta.records = trafico.length;
    updateEstado({
      estado,
      sites: trafico,
      now,
      ...(ubicacionesText ? { locations, bearings } : {}),
    });
    historico = historicoSites(estado);
    log(`detectores: ${locations.length} ubicaciones, ${measurements.length} medidas, ${trafico.length} sitios (${traficoWithSpeed} con velocidad), ${historico.length} con historico`);
  } else if (medidasRes.text) {
    medidasRes.meta.ok = false;
    medidasRes.meta.error = 'sin ubicaciones de detectores';
  }

  const env = supabaseEnvFromProcess();

  // Telemetria propia (spec §3.5): solo con la clave secreta en el entorno y sin --skip-supabase.
  // Un fallo aqui NUNCA aborta la vuelta: se anota en meta.sources.traces y se publica el resto.
  let usuarios: UserTrafficSite[] = [];
  let tracesMeta: TracesSourceMeta | undefined;
  if (!skipSupabase && env) {
    try {
      const { cells, files, trips } = await collectTraces({
        list: (prefix) => listObjects(env, prefix),
        read: (path) => readObject(env, path),
        now,
      });
      updateTraces(estado, cells);
      usuarios = userSites(cells, estado);
      const points = cells.reduce((acc, c) => acc + c.points, 0);
      tracesMeta = { fetchedAt: now.toISOString(), files, points, ok: true };
      log(`trazas: ${files} ficheros, ${points} puntos, ${usuarios.length} celdas publicadas`);

      // Kilometros por trayecto (fase E, spec §3.6): la app los reclama despues con `claim_km`. Va
      // en su PROPIO try/catch (fix round 1): la recogida de trazas de arriba ya tuvo exito -tiene
      // su `files`/`points` y su `ok: true`-, y un fallo escribiendo trace_km (por ejemplo, la tabla
      // todavia no existe porque no se ha aplicado la migracion 0007) es un fallo DISTINTO que no
      // debe pisar `sources.traces` con `ok: false` y `files: 0` como si la recogida hubiera fallado.
      // Se preguntan primero las sesiones que ya estan para no reescribir una fila que quiza ya esta
      // reclamada -el `Prefer: resolution=ignore-duplicates` de `insertTraceKm` es la segunda red-.
      try {
        const existentes = await existingTraceKm(env, trips.map((t) => t.session));
        const nuevos = pendingTraceKm(trips, existentes);
        const kmEscritos = nuevos.length ? await insertTraceKm(env, nuevos) : 0;
        log(`trace_km: ${kmEscritos} trayectos con km nuevos`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // No se anota en meta.json (TracesSourceMeta no cambia de forma, decision D1): la traza en
        // el log es la unica senal de este fallo, deliberadamente separada de "trazas: fallo (...)".
        log(`trace_km: fallo (${error})`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log(`trazas: fallo (${error})`);
      tracesMeta = { fetchedAt: now.toISOString(), files: 0, points: 0, ok: false, error };
    }
  }

  const sources: SourcesMeta = {
    radares: radaresRes.meta,
    incidencias: incidenciasRes.meta,
    trafico: { ...medidasRes.meta, withSpeed: traficoWithSpeed },
    ...(tracesMeta ? { traces: tracesMeta } : {}),
  };
  const out = buildOutputs({ radares, incidencias, catalogo, now, sources, discardedIncidencias, trafico, historico, usuarios, estado });
  const bytes = await writeOutputs(outDir, out);
  log(`escritos ${out.size} ficheros (${(bytes / 1000).toFixed(0)} KB) en ${outDir}`);

  if (skipSupabase) {
    log('supabase: --skip-supabase, se omite sincronizacion');
    return;
  }
  if (!env) {
    log('supabase: faltan SUPABASE_URL/SUPABASE_SECRET_KEY en el entorno, se omite sincronizacion');
    return;
  }

  // report_types (barato, pero firma con la clave secreta) y la limpieza de trazas (cara: lista
  // y borra por carpeta) solo hace falta sincronizarlos una vez al dia, no en cada ejecucion
  // cada 10 minutos: se hacen ambos en la misma ventana 04:00-04:09 UTC.
  if (isDailyMaintenanceWindow(now)) {
    try {
      const n = await syncReportTypes(catalogo, env);
      log(`supabase: report_types sincronizados (${n})`);
    } catch (e) {
      log(`supabase: fallo sincronizando report_types: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const n = await cleanupTraces(env, now);
      log(`supabase: ${n} objetos de trazas antiguas eliminados`);
    } catch (e) {
      log(`supabase: fallo en la limpieza de trazas: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    log('supabase: fuera de la ventana diaria (04:00-04:09 UTC), se omiten report_types y la limpieza de trazas');
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'run';
  if (cmd !== 'run') {
    console.error(`comando desconocido: "${cmd}" (solo se admite "run")`);
    process.exit(1);
  }
  await run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
