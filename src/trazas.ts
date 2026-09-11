/**
 * Telemetria propia agregada (spec fase D §3.5): los trayectos anonimos que la app sube a Supabase
 * Storage (`traces`, fase C) se agregan por celda de 100 m y sector de rumbo de 45 grados. Lo de los
 * ultimos 20 minutos se publica en `trafico/usuarios/<celda 1 grado>.json`; el perfil de 168 franjas
 * por celda-sector vive en `trafico/estado.json` (Task 2).
 *
 * NINGUN dato de aqui identifica a nadie: los ficheros de origen no llevan usuario ni dispositivo
 * (`TraceRecorder`, fase C) y lo que se publica es la media de una cuadricula, nunca un punto suelto.
 */
import { gunzipSync } from 'node:zlib';
import { levelOf, type TrafficSite } from './detectores.ts';
import { EMA_ALPHA, hourlySlot, madridDay, MIN_REFERENCE_SAMPLES, type Estado } from './estado.ts';
import { StorageError, type StorageObject } from './supabase.ts';

/** Ventana en vivo (spec §3.5): puntos y ficheros de los ultimos 20 minutos. */
export const TRACE_WINDOW_MS = 20 * 60_000;

/** Tope de ficheros que se descargan por vuelta (spec §3.5). */
export const TRACE_MAX_FILES = 500;

/** Puntos minimos de una celda de 100 m para publicarla en vivo (spec §3.5). */
export const TRACE_MIN_LIVE_POINTS = 3;

/** Sectores de rumbo: 8 de 45 grados (spec §3.5). */
export const TRACE_SECTORS = 8;

/** Grados de cada sector. */
const SECTOR_DEG = 360 / TRACE_SECTORS;

/** Sufijo de los objetos de trayecto en Storage (`TraceRecorder`, fase C). */
const TRACE_SUFFIX = '.json.gz';

export interface TracePoint {
  dtS: number;
  lat: number;
  lng: number;
  kmh: number;
  bearing: number;
}

export interface Trace {
  startedAtMs: number;
  points: TracePoint[];
}

/** Una celda de 100 m y un sector de rumbo, con lo agregado de esta vuelta. */
export interface AggregatedCell {
  /** `<celda100>_<sector>`, la clave de `Estado.traces` y el sufijo del `id` publicado. */
  key: string;
  cell100: string;
  sector: number;
  lat: number;
  lng: number;
  avgKmh: number;
  points: number;
  /** Instante del punto MAS RECIENTE de la celda (epoch ms): es su `measuredAt`. */
  atMs: number;
}

/** Un elemento de `trafico/usuarios/<celda>.json`: igual que un sitio de detector, mas `points`. */
export interface UserTrafficSite extends TrafficSite {
  points: number;
}

/**
 * Descomprime y lee un `.json.gz` de trayecto. El formato real (decision D2) es
 * `{"v":1,"session":…,"startedAt":…,"points":[[dtS,lat,lng,kmh,rumbo],…]}`: los puntos son TUPLAS.
 * Cualquier fichero corrupto, truncado o de otro formato devuelve `undefined` y se ignora.
 */
export function parseTrace(gz: Uint8Array): Trace | undefined {
  try {
    const raw = JSON.parse(gunzipSync(gz).toString('utf8')) as { startedAt?: unknown; points?: unknown };
    const startedAtMs = typeof raw.startedAt === 'string' ? Date.parse(raw.startedAt) : Number.NaN;
    if (!Number.isFinite(startedAtMs) || !Array.isArray(raw.points)) return undefined;
    const points: TracePoint[] = [];
    for (const tuple of raw.points) {
      if (!Array.isArray(tuple) || tuple.length < 5) continue;
      const [dtS, lat, lng, kmh, bearing] = tuple as unknown[];
      if (![dtS, lat, lng, kmh, bearing].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      points.push({ dtS: dtS as number, lat: lat as number, lng: lng as number, kmh: kmh as number, bearing: bearing as number });
    }
    return { startedAtMs, points };
  } catch {
    return undefined;
  }
}

/** Celda de 100 m: `floor(lat x 1000)_floor(lng x 1000)` (spec §3.5). */
export function traceCellKey(lat: number, lng: number): string {
  return `${Math.floor(lat * 1000)}_${Math.floor(lng * 1000)}`;
}

/** Centro de una celda de 100 m: el punto que se publica en la capa. */
export function cellCenterOf(cell100: string): { lat: number; lng: number } {
  const [latRaw, lngRaw] = cell100.split('_');
  return { lat: (Number(latRaw) + 0.5) / 1000, lng: (Number(lngRaw) + 0.5) / 1000 };
}

/** Sector de rumbo 0..7 (0 = 0-44 grados, 4 = 180-224 grados). */
export function sectorOf(bearing: number): number {
  const normalized = ((bearing % 360) + 360) % 360;
  return Math.floor(normalized / SECTOR_DEG) % TRACE_SECTORS;
}

/** Rumbo publicado de un sector: su centro, en grados enteros. */
export function sectorBearing(sector: number): number {
  return sector * SECTOR_DEG + 22;
}

export function aggregateTraces(input: { files: { bytes: Uint8Array }[]; now: Date; windowMs?: number }): AggregatedCell[] {
  const windowMs = input.windowMs ?? TRACE_WINDOW_MS;
  const from = input.now.getTime() - windowMs;
  const acc = new Map<string, { cell100: string; sector: number; sum: number; points: number; atMs: number }>();
  for (const file of input.files) {
    const trace = parseTrace(file.bytes);
    if (!trace) continue;
    for (const p of trace.points) {
      // La ventana se aplica a CADA PUNTO, no al fichero: un trayecto de una hora subido hace un
      // minuto solo aporta su ultimo tramo al trafico en vivo.
      const atMs = trace.startedAtMs + p.dtS * 1000;
      if (atMs < from) continue;
      const cell100 = traceCellKey(p.lat, p.lng);
      const sector = sectorOf(p.bearing);
      const key = `${cell100}_${sector}`;
      const previous = acc.get(key);
      if (previous) {
        previous.sum += p.kmh;
        previous.points += 1;
        previous.atMs = Math.max(previous.atMs, atMs);
      } else {
        acc.set(key, { cell100, sector, sum: p.kmh, points: 1, atMs });
      }
    }
  }
  const out: AggregatedCell[] = [];
  for (const [key, v] of acc) {
    const center = cellCenterOf(v.cell100);
    out.push({ key, cell100: v.cell100, sector: v.sector, lat: center.lat, lng: center.lng, avgKmh: v.sum / v.points, points: v.points, atMs: v.atMs });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Suma las celdas de esta vuelta al perfil de 168 franjas del estado (spec §3.5). Muta `estado`.
 * Tambien marca `traceSeenDays[key]` con el dia de Madrid de esta celda: es lo que permite podarla
 * mas adelante si deja de visitarse (I2, ver `TRACE_MAX_AGE_DAYS` en `estado.ts`).
 */
export function updateTraces(estado: Estado, cells: AggregatedCell[]): Estado {
  for (const cell of cells) {
    const seenAt = new Date(cell.atMs);
    const slot = String(hourlySlot(seenAt));
    let bySlot = estado.traces[cell.key];
    if (!bySlot) {
      bySlot = {};
      estado.traces[cell.key] = bySlot;
    }
    const previous = bySlot[slot];
    bySlot[slot] = previous
      ? [previous[0] + EMA_ALPHA * (cell.avgKmh - previous[0]), previous[1] + cell.points]
      : [cell.avgKmh, cell.points];
    estado.traceSeenDays[cell.key] = madridDay(seenAt);
  }
  return estado;
}

/**
 * Referencia de una celda-sector: el maximo de las franjas MADURAS de su perfil (>= 20 puntos).
 * `undefined` mientras ninguna lo sea; ahi la celda se publica como `free` sin ratio (decision D9).
 */
export function traceReferenceFor(estado: Estado, key: string): number | undefined {
  const bySlot = estado.traces[key];
  if (!bySlot) return undefined;
  let best: number | undefined;
  for (const [ema, count] of Object.values(bySlot)) {
    if (count < MIN_REFERENCE_SAMPLES) continue;
    if (best === undefined || ema > best) best = ema;
  }
  return best;
}

export function userSites(cells: AggregatedCell[], estado: Estado): UserTrafficSite[] {
  const out: UserTrafficSite[] = [];
  for (const cell of cells) {
    if (cell.points < TRACE_MIN_LIVE_POINTS) continue;
    const reference = traceReferenceFor(estado, cell.key);
    const ratio = reference !== undefined && reference > 0 ? cell.avgKmh / reference : undefined;
    out.push({
      id: `u:${cell.key}`,
      lat: cell.lat,
      lng: cell.lng,
      road: null,
      bearing: sectorBearing(cell.sector),
      speedKmh: Math.round(cell.avgKmh),
      level: ratio === undefined ? 'free' : levelOf(ratio),
      ratio: ratio === undefined ? null : Math.round(ratio * 100) / 100,
      measuredAt: new Date(cell.atMs).toISOString(),
      points: cell.points,
    });
  }
  return out;
}

/** Fecha UTC `yyyy-mm-dd`: el primer segmento de la ruta de un trayecto en Storage (decision D3). */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Lista las carpetas de ayer y hoy, se queda con los objetos modificados dentro de la ventana, los
 * descarga (como mucho [TRACE_MAX_FILES], los mas recientes primero) y los agrega. `list` y `read`
 * se inyectan para que el test no toque la red.
 */
export async function collectTraces(input: {
  list: (prefix: string) => Promise<StorageObject[]>;
  read: (path: string) => Promise<Uint8Array>;
  now: Date;
  windowMs?: number;
  maxFiles?: number;
}): Promise<{ cells: AggregatedCell[]; files: number }> {
  const { list, read, now } = input;
  const windowMs = input.windowMs ?? TRACE_WINDOW_MS;
  const maxFiles = input.maxFiles ?? TRACE_MAX_FILES;
  const from = now.getTime() - windowMs;
  const folders = [utcDay(new Date(now.getTime() - 86_400_000)), utcDay(now)];

  const candidates: { path: string; updated: number }[] = [];
  for (const folder of folders) {
    let objects: StorageObject[];
    try {
      objects = await list(folder);
    } catch (err) {
      // Un 404 real es una carpeta que todavia no existe (justo despues de medianoche): Supabase
      // Storage devuelve 200 con [] para un prefijo inexistente, asi que un 404 solo puede venir de
      // un endpoint caido, y eso NO es un fallo de la recogida (ruling R65). CUALQUIER OTRO fallo
      // (500, 403, red) SI debe abortar `collectTraces`: lo captura el catch de cli.ts, que marca
      // `sources.traces.ok = false` en vez de publicar en silencio 0 ficheros como si fuera normal.
      if (err instanceof StorageError && err.status === 404) continue;
      throw err;
    }
    for (const o of objects) {
      if (!o.name.endsWith(TRACE_SUFFIX)) continue;
      const updated = o.updated_at ? Date.parse(o.updated_at) : Number.NaN;
      if (!Number.isFinite(updated) || updated < from) continue;
      candidates.push({ path: `${folder}/${o.name}`, updated });
    }
  }
  candidates.sort((a, b) => b.updated - a.updated);

  const files: { bytes: Uint8Array }[] = [];
  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      files.push({ bytes: await read(candidate.path) });
    } catch {
      // Un objeto borrado entre el listado y la lectura: se salta y se sigue con el resto.
    }
  }
  return { cells: aggregateTraces({ files, now, windowMs }), files: files.length };
}
