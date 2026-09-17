/**
 * Cruce de los radares de la DGT con los nodos `highway=speed_camera` de OpenStreetMap
 * («Mejoras 1», spec §0/§1.4).
 *
 * El feed DATEX II de la DGT publica la posición del radar con la precisión del PK, no la del
 * poste: el usuario vio avisos a ~100 m del radar de verdad. OSM tiene los postes mapeados con
 * precisión de metros, así que si hay un `highway=speed_camera` a menos de [OSM_MATCH_MAX_M] del
 * punto de la DGT se publica el de OSM y se deja constancia en `source_position`.
 *
 * Todo lo de aquí es puro salvo [refreshOsmCameras], que recibe la función de red como parámetro:
 * los tests nunca salen a internet.
 */
import { cellOf } from './cells.ts';
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

/** Tiempo límite de cada consulta a Overpass (spec §2). */
export const OSM_QUERY_TIMEOUT_MS = 20_000;

/**
 * Margen con el que se ensancha la caja de cada celda: ~1,1 km, holgadamente más que
 * [OSM_MATCH_MAX_M]. Así un radar pegado al borde de su celda encuentra igual el nodo que cae justo
 * al otro lado, y [matchOsmCameras] solo necesita mirar en la lista de SU celda (decisión M13).
 */
export const OSM_BBOX_MARGIN_DEG = 0.01;

/** Metros por grado de latitud; el mismo número que usa el motor de la app (`engine/matching`). */
const M_PER_DEG_LAT = 111_320;

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
}

/**
 * Refresca la caché consultando Overpass **una vez por celda y en serie** (no en paralelo: son
 * ~30 consultas y el servidor público es de todos).
 *
 * Nunca lanza: una celda que falle conserva lo que ya había en la caché y se cuenta en `failed`. Si
 * fallan TODAS, la caché se devuelve intacta -con su `updatedAt` viejo, para que el intento se
 * repita mañana- en vez de quedarse vacía por un mal día de Overpass.
 */
export async function refreshOsmCameras(
  input: RefreshOsmCamerasInput,
): Promise<{ cache: OsmCameraCache; queried: number; failed: number }> {
  const cells: Record<string, OsmCamera[]> = { ...input.cache.cells };
  let queried = 0;
  let failed = 0;
  for (const cell of input.cells) {
    try {
      cells[cell] = await input.fetchCell(cell);
      queried++;
    } catch {
      failed++;
    }
  }
  if (queried === 0) return { cache: input.cache, queried, failed };
  return { cache: { updatedAt: input.now.toISOString(), cells }, queried, failed };
}

/** Metros entre dos puntos, plano equirectangular: sobra de sobra para distancias de metros. */
function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((aLat * Math.PI) / 180);
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLng - aLng) * mPerDegLng;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Sustituye la posición de cada radar por la del nodo de OSM más cercano si lo hay a menos de
 * [OSM_MATCH_MAX_M], y marca en `source_position` de dónde salió al final la posición publicada.
 *
 * De un radar de tramo solo se mueve el INICIO (`lat`/`lng`): `endLat`/`endLng` no se tocan nunca
 * (decisión M12). El resto de campos se copia tal cual. Devuelve también cuántos casaron, que es lo
 * que el CLI escribe en el log de publicación (spec §1.4).
 */
export function matchOsmCameras(radares: Radar[], cache: OsmCameraCache): { radares: Radar[]; matched: number } {
  let matched = 0;
  const out = radares.map((radar) => {
    const candidatas = cache.cells[cellOf(radar.lat, radar.lng)];
    if (!candidatas || candidatas.length === 0) return { ...radar, source_position: 'dgt' as const };
    let mejor: OsmCamera | undefined;
    let mejorM = Number.POSITIVE_INFINITY;
    for (const camara of candidatas) {
      const d = metersBetween(radar.lat, radar.lng, camara.lat, camara.lng);
      if (d < mejorM) {
        mejorM = d;
        mejor = camara;
      }
    }
    if (!mejor || mejorM > OSM_MATCH_MAX_M) return { ...radar, source_position: 'dgt' as const };
    matched++;
    return { ...radar, lat: mejor.lat, lng: mejor.lng, source_position: 'osm' as const };
  });
  return { radares: out, matched };
}
