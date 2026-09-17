/**
 * Cruce de los radares de la DGT con los nodos `highway=speed_camera` de OpenStreetMap
 * («Mejoras 1», spec §0/§1.4).
 *
 * El feed DATEX II de la DGT publica la posición del radar con la precisión del PK, no la del
 * poste: el usuario vio avisos a ~100 m del radar de verdad. OSM tiene los postes mapeados con
 * precisión de metros, así que si hay un `highway=speed_camera` a menos de [OSM_MATCH_MAX_M] del
 * punto de la DGT se publica el de OSM y se deja constancia en `source_position`.
 *
 * Todo lo de aquí es puro salvo [refreshOsmCameras] y [refreshAndMatchOsmCameras], que reciben la
 * red (y, la segunda, el disco) como parámetros: los tests nunca salen a internet ni tocan ficheros.
 */
import { cellOf } from './cells.ts';
import { isDailyMaintenanceWindow } from './schedule.ts';
import type { Radar } from './radares.ts';

/** Un nodo `highway=speed_camera` de OpenStreetMap: solo su posición, nada más. */
export interface OsmCamera {
  lat: number;
  lng: number;
}

/**
 * Caché de los nodos de OSM por celda de un grado, guardada en `data/osm-cameras.json` y
 * commiteada en el repo. `updatedAt` es la fecha del último refresco con éxito.
 */
export interface OsmCameraCache {
  updatedAt: string;
  cells: Record<string, OsmCamera[]>;
}

/** Instancia pública de Overpass, la misma que usa la app (`platform/OverpassHttp.kt`). */
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Ruta de la caché, relativa a la raíz de `copiloto-alerts/`. */
export const OSM_CACHE_PATH = 'data/osm-cameras.json';

/** Distancia máxima para dar por el mismo radar el de la DGT y el nodo de OSM (spec §0). */
export const OSM_MATCH_MAX_M = 250;

/** A partir de esta edad, la caché se refresca (spec §2). */
export const OSM_CACHE_MAX_AGE_DAYS = 7;

/** Tiempo límite de cada consulta a Overpass (repaso final de «Mejoras 1», Important I2/item 8). */
export const OSM_QUERY_TIMEOUT_MS = 10_000;

/**
 * Presupuesto de pared para el CONJUNTO de consultas a Overpass de una vuelta (repaso final de
 * «Mejoras 1», Important I2/item 8): con ~30 celdas en serie y 10 s de tope por consulta el peor
 * caso son 300 s, muy por encima de lo que el job del workflow puede permitirse sin dejar sin
 * publicar radares, incidencias y tráfico (`cruzarConOsm` se llama ANTES de `buildOutputs`).
 * Agotados los 120 s, las celdas que faltan se quedan con lo que ya hubiera en la caché -o sin
 * datos, que [matchOsmCameras] resuelve con la posición de la DGT- y la publicación sigue, igual
 * que con un [OverpassAbortError].
 */
export const OSM_REFRESH_BUDGET_MS = 120_000;

/**
 * Margen con el que se ensancha la caja de cada celda: ~1,1 km, holgadamente más que
 * [OSM_MATCH_MAX_M]. Así un radar pegado al borde de su celda encuentra igual el nodo que cae justo
 * al otro lado, y [matchOsmCameras] solo necesita mirar en la lista de SU celda (decisión M13).
 */
export const OSM_BBOX_MARGIN_DEG = 0.01;

/** Caché recién nacida: sin fecha útil, así que [osmCacheIsStale] la considera siempre caducada. */
export function emptyOsmCameraCache(): OsmCameraCache {
  return { updatedAt: '1970-01-01T00:00:00.000Z', cells: {} };
}

/**
 * La caché de `text`, o `undefined` si el fichero no existe con esa forma (JSON roto, sin
 * `updatedAt`, sin `cells`). Quien llama se queda entonces con [emptyOsmCameraCache].
 */
export function parseOsmCameraCache(text: string): OsmCameraCache | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.updatedAt !== 'string') return undefined;
  if (typeof obj.cells !== 'object' || obj.cells === null) return undefined;
  const cells: Record<string, OsmCamera[]> = {};
  for (const [cell, value] of Object.entries(obj.cells as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    cells[cell] = value
      .map((c) => c as Record<string, unknown>)
      .filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lng))
      .map((c) => ({ lat: c.lat as number, lng: c.lng as number }));
  }
  return { updatedAt: obj.updatedAt, cells };
}

/** `true` si la caché tiene más de [OSM_CACHE_MAX_AGE_DAYS] días (o una fecha ilegible). */
export function osmCacheIsStale(cache: OsmCameraCache, now: Date): boolean {
  const at = Date.parse(cache.updatedAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= OSM_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Las celdas de un grado que de verdad tienen radares, sin repetir y ordenadas (decisión M13). */
export function cellsWithRadares(radares: Radar[]): string[] {
  const cells = new Set<string>();
  for (const r of radares) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    cells.add(cellOf(r.lat, r.lng));
  }
  return [...cells].sort();
}

/**
 * La consulta de Overpass para una celda `${floor(lat)}_${floor(lng)}`: los nodos
 * `highway=speed_camera` de su caja de un grado, ensanchada [OSM_BBOX_MARGIN_DEG]. `out skel qt`
 * devuelve id y coordenadas y nada más -las etiquetas no se usan para nada aquí-.
 */
export function overpassCamerasQuery(cell: string): string {
  const [latText, lngText] = cell.split('_');
  const lat = Number(latText);
  const lng = Number(lngText);
  const sur = (lat - OSM_BBOX_MARGIN_DEG).toFixed(4);
  const oeste = (lng - OSM_BBOX_MARGIN_DEG).toFixed(4);
  const norte = (lat + 1 + OSM_BBOX_MARGIN_DEG).toFixed(4);
  const este = (lng + 1 + OSM_BBOX_MARGIN_DEG).toFixed(4);
  const segundos = Math.round(OSM_QUERY_TIMEOUT_MS / 1000);
  return `[out:json][timeout:${segundos}];node["highway"="speed_camera"](${sur},${oeste},${norte},${este});out skel qt;`;
}

/** Los nodos con coordenadas de una respuesta de Overpass; lista vacía ante cualquier sorpresa. */
/** Caja de toda España (península, Baleares y Canarias) para la consulta nacional única. */
export const OSM_SPAIN_BBOX = { sur: 27.5, oeste: -18.5, norte: 44.0, este: 4.5 };
/** Tiempo límite de la consulta nacional: una sola petición, cabe de sobra en el presupuesto. */
export const OSM_SPAIN_TIMEOUT_MS = 90_000;

/** Una única consulta con todos los nodos `highway=speed_camera` de España (ver `fetchAll`). */
export function overpassSpainQuery(): string {
  const { sur, oeste, norte, este } = OSM_SPAIN_BBOX;
  const segundos = Math.round(OSM_SPAIN_TIMEOUT_MS / 1000);
  return `[out:json][timeout:${segundos}];node["highway"="speed_camera"](${sur},${oeste},${norte},${este});out skel qt;`;
}

/**
 * Reparte las cámaras de la consulta nacional en las celdas pedidas (las mismas claves que
 * [cellsWithRadares]); una celda pedida sin cámaras queda como lista vacía, que para el cruce
 * significa «consultada y sin cámara cerca», no «sin datos».
 */
export function splitCamerasByCell(cameras: OsmCamera[], cells: string[]): Record<string, OsmCamera[]> {
  const out: Record<string, OsmCamera[]> = {};
  for (const cell of cells) out[cell] = [];
  for (const camera of cameras) {
    const cell = cellOf(camera.lat, camera.lng);
    if (cell in out) out[cell].push(camera);
  }
  return out;
}

export function parseOverpassCameras(body: string): OsmCamera[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const elements = (raw as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  const out: OsmCamera[] = [];
  for (const el of elements) {
    const node = el as Record<string, unknown>;
    if (node?.type !== 'node') continue;
    const lat = node.lat;
    const lng = node.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ lat, lng });
  }
  return out;
}

/** Entrada de [refreshOsmCameras]: las celdas a pedir, la caché previa, el reloj y la red. */
export interface RefreshOsmCamerasInput {
  cells: string[];
  cache: OsmCameraCache;
  now: Date;
  /** Devuelve los nodos de una celda; lanza si la consulta falla (HTTP, tiempo límite, JSON raro). */
  fetchCell: (cell: string) => Promise<OsmCamera[]>;
  /**
   * Si existe, UNA sola consulta con todas las cámaras del país ([overpassSpainQuery]) sustituye a
   * las ~30 consultas por celda: la siembra real del 2026-09-17 demostró que Overpass devuelve 429
   * o agota los 10 s por celda en cuanto se encadenan unas pocas, y una consulta nacional de
   * `highway=speed_camera` pesa menos de 1 MB. Si falla, la vuelta se queda con la caché previa
   * (no se dispara el camino por celdas: sería martillear a un servidor que ya ha fallado).
   */
  fetchAll?: () => Promise<OsmCamera[]>;
  /**
   * Reloj de pared para [OSM_REFRESH_BUDGET_MS] (item 8 del repaso final): milisegundos desde
   * cualquier origen fijo, inyectable para los tests -nunca `Date.now` de verdad en ellos-. Por
   * defecto `Date.now`.
   */
  clockMs?: () => number;
}

/**
 * Señal de «para todo, no sigas»: Overpass está devolviendo 429 (demasiadas peticiones) o 504
 * (tiempo límite en el propio servidor), así que seguir martilleando con las celdas que quedan de
 * esta vuelta sería una falta de respeto con un servicio público compartido (revisión de la Task 4,
 * hallazgo Minor #4). Quien construye `fetchCell` la lanza (`fetchOverpassCameras` en `cli.ts`);
 * [refreshOsmCameras] la reconoce y abandona el resto de celdas de esta vuelta sin reintentar ni
 * esperar -la caché vieja de esas celdas sigue sirviendo, y se reintentará en la próxima ventana
 * diaria-. Cualquier OTRO error (tiempo límite del cliente, JSON raro, otro HTTP) se sigue tratando
 * celda a celda, como antes.
 */
export class OverpassAbortError extends Error {}

/**
 * Refresca la caché consultando Overpass **una vez por celda y en serie** (no en paralelo: son
 * ~30 consultas y el servidor público es de todos).
 *
 * Nunca lanza: una celda que falle conserva lo que ya había en la caché y se cuenta en `failed`. Si
 * fallan TODAS, la caché se devuelve intacta -con su `updatedAt` viejo, para que el intento se
 * repita mañana- en vez de quedarse vacía por un mal día de Overpass. Un [OverpassAbortError] corta
 * el bucle: las celdas que quedaban ni se piden ni se cuentan como fallidas, simplemente se quedan
 * con lo que ya hubiera en la caché previa.
 *
 * Presupuesto agregado (item 8 del repaso final, Important I2): antes de CADA celda se comprueba
 * si ya se ha gastado [OSM_REFRESH_BUDGET_MS] desde que empezó esta vuelta; si es así, el bucle
 * sale exactamente igual que con un [OverpassAbortError] -las celdas que faltan ni se piden ni se
 * cuentan como falladas, se quedan con lo que ya hubiera en la caché previa- y `budgetExceeded`
 * sale en `true` para que quien llama lo pueda anotar en el log.
 */
export async function refreshOsmCameras(
  input: RefreshOsmCamerasInput,
): Promise<{ cache: OsmCameraCache; queried: number; failed: number; budgetExceeded: boolean }> {
  const cells: Record<string, OsmCamera[]> = { ...input.cache.cells };
  const clockMs = input.clockMs ?? Date.now;
  const startMs = clockMs();
  let queried = 0;
  let failed = 0;
  let budgetExceeded = false;
  if (input.fetchAll) {
    try {
      const todas = await input.fetchAll();
      const porCelda = splitCamerasByCell(todas, input.cells);
      for (const cell of input.cells) cells[cell] = porCelda[cell] ?? [];
      queried = input.cells.length;
    } catch {
      failed = 1;
    }
    if (queried === 0) return { cache: input.cache, queried, failed, budgetExceeded };
    return { cache: { updatedAt: input.now.toISOString(), cells }, queried, failed, budgetExceeded };
  }
  // Primero las celdas que la cache aun no tiene: con Overpass lento, cada vuelta agota el
  // presupuesto tras unas pocas consultas, y si el orden fuera siempre el mismo las celdas del
  // final nunca llegarian a entrar (siembra real del 2026-09-17: 5 celdas por vuelta). Asi cada
  // vuelta avanza sobre lo que falta y solo despues refresca lo que ya habia.
  const orden = [...input.cells].sort((a, b) => Number(a in cells) - Number(b in cells));
  for (const cell of orden) {
    if (clockMs() - startMs >= OSM_REFRESH_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }
    try {
      cells[cell] = await input.fetchCell(cell);
      queried++;
    } catch (e) {
      failed++;
      if (e instanceof OverpassAbortError) break;
    }
  }
  if (queried === 0) return { cache: input.cache, queried, failed, budgetExceeded };
  return { cache: { updatedAt: input.now.toISOString(), cells }, queried, failed, budgetExceeded };
}

/** Radio medio de la Tierra (m), para el haversine de [metersBetween]. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Metros entre dos puntos con la fórmula de haversine (grados a radianes primero; revisión de la
 * Task 4, hallazgo Minor #5: a las distancias en juego aquí -250-400 m- una proyección plana ya
 * daba el mismo resultado, pero esta es la fórmula correcta sin aproximar).
 */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const a = sinDLat * sinDLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Sustituye la posición de cada radar por la del nodo de OSM más cercano si lo hay a MENOS de
 * [OSM_MATCH_MAX_M] -en sentido estricto: a exactamente [OSM_MATCH_MAX_M] NO sustituye, revisión de
 * la Task 4, hallazgo Minor #3-, y marca en `source_position` de dónde salió al final la posición
 * publicada.
 *
 * De un radar de tramo solo se mueve el INICIO (`lat`/`lng`): `endLat`/`endLng` no se tocan nunca
 * (decisión M12). El resto de campos se copia tal cual.
 *
 * Devuelve TRES recuentos, no solo `matched` (revisión de la Task 4, hallazgo Important #1: el log
 * de publicación tiene que poder distinguir "no había ningún nodo de OSM en su celda" de "había
 * nodos, pero el más cercano estaba a 250 m o más"):
 * - `matched`: se sustituyó por un nodo de OSM.
 * - `tooFar`: su celda SÍ tenía nodos de OSM, pero el más cercano estaba a 250 m o más.
 * - `withoutOsmData`: su celda no tiene ninguna entrada en la caché (o está vacía).
 */
export function matchOsmCameras(
  radares: Radar[],
  cache: OsmCameraCache,
): { radares: Radar[]; matched: number; tooFar: number; withoutOsmData: number } {
  let matched = 0;
  let tooFar = 0;
  let withoutOsmData = 0;
  const out = radares.map((radar) => {
    const candidatas = cache.cells[cellOf(radar.lat, radar.lng)];
    if (!candidatas || candidatas.length === 0) {
      withoutOsmData++;
      return { ...radar, source_position: 'dgt' as const };
    }
    let mejor: OsmCamera | undefined;
    let mejorM = Number.POSITIVE_INFINITY;
    for (const camara of candidatas) {
      const d = metersBetween(radar.lat, radar.lng, camara.lat, camara.lng);
      if (d < mejorM) {
        mejorM = d;
        mejor = camara;
      }
    }
    // Estricto: a exactamente OSM_MATCH_MAX_M no sustituye ("menos de 250 m", no "como mucho").
    if (!mejor || mejorM >= OSM_MATCH_MAX_M) {
      tooFar++;
      return { ...radar, source_position: 'dgt' as const };
    }
    matched++;
    return { ...radar, lat: mejor.lat, lng: mejor.lng, source_position: 'osm' as const };
  });
  return { radares: out, matched, tooFar, withoutOsmData };
}

/** Entrada de [refreshAndMatchOsmCameras]: una vuelta completa, con la red y el disco inyectados. */
export interface RefreshAndMatchOsmCamerasInput {
  radares: Radar[];
  cache: OsmCameraCache;
  now: Date;
  fetchCell: (cell: string) => Promise<OsmCamera[]>;
  /**
   * Si existe, UNA sola consulta con todas las cámaras del país ([overpassSpainQuery]) sustituye a
   * las ~30 consultas por celda: la siembra real del 2026-09-17 demostró que Overpass devuelve 429
   * o agota los 10 s por celda en cuanto se encadenan unas pocas, y una consulta nacional de
   * `highway=speed_camera` pesa menos de 1 MB. Si falla, la vuelta se queda con la caché previa
   * (no se dispara el camino por celdas: sería martillear a un servidor que ya ha fallado).
   */
  fetchAll?: () => Promise<OsmCamera[]>;
  /**
   * Persiste la caché refrescada en disco. Un fallo aquí NUNCA debe impedir el cruce: ver la nota
   * de [refreshAndMatchOsmCameras] (revisión de la Task 4, hallazgo Important #2).
   */
  writeCache: (cache: OsmCameraCache) => Promise<void>;
  /**
   * `true` fuerza el refresco ignorando antigüedad y ventana diaria (item 7 del repaso final: la
   * opción de CLI `--refresh-osm-cache`, pensada para sembrar la caché en local). `false` por
   * defecto: se sigue la regla de siempre (caché caducada Y ventana diaria de mantenimiento).
   */
  forceRefresh?: boolean;
  /** Reloj de pared para el presupuesto agregado de Overpass; ver [refreshOsmCameras]. */
  clockMs?: () => number;
}

export interface RefreshAndMatchOsmCamerasResult {
  radares: Radar[];
  matched: number;
  tooFar: number;
  withoutOsmData: number;
  /** Si esta vuelta ha llegado a intentar refrescar la caché (caché caducada Y ventana diaria). */
  refreshed: boolean;
  queried: number;
  failed: number;
  /** `true` si el presupuesto de [OSM_REFRESH_BUDGET_MS] se agotó antes de acabar las celdas. */
  budgetExceeded: boolean;
  /**
   * La caché EFECTIVAMENTE usada para el cruce -la refrescada si `refreshed`, la recibida en
   * `input.cache` si no-. Item 7 del repaso final: quien llama (`cli.ts`) la publica en
   * `out/osm-cameras.json` en CADA vuelta, no solo en las que refrescan (el deploy de GitHub Pages
   * sustituye el sitio entero, así que si no se escribiera siempre el fichero desaparecería de la
   * publicación en la primera vuelta que no refresca).
   */
  cache: OsmCameraCache;
  /** Mensaje del fallo si `writeCache` ha lanzado; ausente si no se ha intentado o ha ido bien. */
  cacheWriteError?: string;
}

/**
 * Orquesta una vuelta completa: refresca la caché si toca (decisión M10: más de
 * [OSM_CACHE_MAX_AGE_DAYS] días Y ventana diaria de mantenimiento, `isDailyMaintenanceWindow`; o
 * `input.forceRefresh`, que salta las dos condiciones -item 7 del repaso final, la opción de CLI
 * `--refresh-osm-cache` para sembrar la caché en local-) y cruza los radares con ella. Recibe la
 * red (`fetchCell`) y el disco (`writeCache`) como parámetros, igual que [refreshOsmCameras]: los
 * tests nunca tocan Overpass ni el sistema de ficheros.
 *
 * El cruce ([matchOsmCameras]) se calcula SIEMPRE con la caché ya refrescada EN MEMORIA, antes de
 * intentar persistirla en disco: si `writeCache` falla (disco lleno, permisos, ruta de solo
 * lectura en el runner), el cruce de esta vuelta ya está hecho y no se ve afectado -solo se pierde
 * el refresco para la PRÓXIMA vuelta, que se reintentará mañana- (revisión de la Task 4, hallazgo
 * Important #2: antes, un fallo de `writeFile` tiraba por el `catch` exterior de `cli.ts` y
 * publicaba los radares SIN `source_position` en absoluto, ni `"osm"` ni `"dgt"`).
 */
export async function refreshAndMatchOsmCameras(
  input: RefreshAndMatchOsmCamerasInput,
): Promise<RefreshAndMatchOsmCamerasResult> {
  if (input.radares.length === 0) {
    return {
      radares: input.radares,
      matched: 0,
      tooFar: 0,
      withoutOsmData: 0,
      refreshed: false,
      queried: 0,
      failed: 0,
      budgetExceeded: false,
      cache: input.cache,
    };
  }
  let cache = input.cache;
  let refreshed = false;
  let queried = 0;
  let failed = 0;
  let budgetExceeded = false;
  let cacheWriteError: string | undefined;
  if (input.forceRefresh || (osmCacheIsStale(cache, input.now) && isDailyMaintenanceWindow(input.now))) {
    refreshed = true;
    const celdas = cellsWithRadares(input.radares);
    const refresco = await refreshOsmCameras({
      cells: celdas,
      cache,
      now: input.now,
      fetchCell: input.fetchCell,
      fetchAll: input.fetchAll,
      clockMs: input.clockMs,
    });
    cache = refresco.cache;
    queried = refresco.queried;
    failed = refresco.failed;
    budgetExceeded = refresco.budgetExceeded;
    if (refresco.queried > 0) {
      try {
        await input.writeCache(cache);
      } catch (e) {
        cacheWriteError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  const { radares, matched, tooFar, withoutOsmData } = matchOsmCameras(input.radares, cache);
  return {
    radares,
    matched,
    tooFar,
    withoutOsmData,
    refreshed,
    queried,
    failed,
    budgetExceeded,
    cache,
    ...(cacheWriteError ? { cacheWriteError } : {}),
  };
}
