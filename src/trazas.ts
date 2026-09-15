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
import { haversineKm, levelOf, type TrafficSite } from './detectores.ts';
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

/** Un trayecto mas corto que esto no se apunta en `trace_km`: no da ni para un decimal de km. */
export const TRIP_MIN_KM = 0.2;

/** Una fila de `trace_km` (fase E, spec §3.6): kilometros y minutos de UNA sesion, sin geometria. */
export interface TraceKmRow {
  session: string;
  km: number;
  minutes: number;
}

/** `<fecha>/<uuid>.json.gz` -> `<uuid>`; `undefined` si el nombre no es un UUID (fichero ajeno). */
export function sessionOfPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const session = name.endsWith(TRACE_SUFFIX) ? name.slice(0, -TRACE_SUFFIX.length) : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session) ? session : undefined;
}

/**
 * Techo de velocidad implicita entre dos puntos consecutivos (mismo orden de magnitud que el
 * teleport guard del motor, fix round 1 de fase E): un tramo que lo supera es un salto de GPS, no
 * metros reales conducidos. Se descarta ESE TRAMO, no el trayecto entero -un solo punto corrupto no
 * debe tirar por la borda kilometros que si son reales y que el usuario luego reclama por puntos-.
 */
const TRIP_MAX_SEGMENT_KMH = 250;

/**
 * Techo de kilometros por TRAYECTO (C1 del repaso final de la fase E): un fichero de trayecto lo
 * escribe el cliente y cualquier sesion autenticada puede subir uno, asi que el pipeline no se
 * fia del total. Ningun viaje real con la app abierta pasa de esto (2.000 km son ~20 h al volante
 * sin cerrar la app); por encima, el fichero es basura o un fraude y no se publica su fila.
 */
export const TRIP_MAX_KM = 2000;

/**
 * Kilometros y minutos de un trayecto (spec §3.6). La distancia es la suma de los tramos entre
 * puntos consecutivos con la misma formula del motor (`haversineKm`), y los minutos salen del `dtS`
 * del ultimo punto menos el del primero. Los puntos son los del fichero YA RECORTADO por la app
 * (300 m por punta, decision E11 del plan): esto mide el trayecto anonimo, no el viaje real.
 *
 * Cada tramo se valida antes de sumarlo (fix round 1): un `dtS` no positivo (puntos desordenados o
 * con el mismo instante) no da una velocidad fiable y se ignora, y un tramo cuya velocidad implicita
 * supera `TRIP_MAX_SEGMENT_KMH` es un salto de GPS y tambien se ignora -en ambos casos SOLO ese
 * tramo, el resto del trayecto se sigue sumando igual-.
 */
export function tripSummary(session: string, trace: Trace): TraceKmRow | undefined {
  const points = trace.points;
  if (points.length < 2) return undefined;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const dtS = points[i].dtS - points[i - 1].dtS;
    if (dtS <= 0) continue;
    const segmentKm = haversineKm(points[i - 1], points[i]);
    const speedKmh = segmentKm / (dtS / 3600);
    if (speedKmh > TRIP_MAX_SEGMENT_KMH) continue;
    km += segmentKm;
  }
  // C1 del repaso final de la fase E: un trayecto por encima del techo no se publica, aunque cada
  // tramo por separado pase el filtro de velocidad (un `dtS` enorme entre dos puntos cualesquiera
  // da una velocidad implicita baja y se cuela por debajo de TRIP_MAX_SEGMENT_KMH).
  if (km > TRIP_MAX_KM) return undefined;
  if (km < TRIP_MIN_KM) return undefined;
  const minutes = Math.max(0, Math.round((points[points.length - 1].dtS - points[0].dtS) / 60));
  return { session, km: Math.round(km * 100) / 100, minutes };
}

/**
 * Los trayectos que todavia NO estan en `trace_km` (spec §7: «un trayecto ya calculado no se
 * recalcula»). Un mismo fichero se lista en varias vueltas seguidas -la ventana es de 20 minutos y
 * el pipeline corre cada 10-, y su fila puede estar ya RECLAMADA por alguien: reescribirla seria
 * pisar `claimed_by`.
 */
export function pendingTraceKm(trips: TraceKmRow[], existing: Set<string>): TraceKmRow[] {
  return trips.filter((t) => !existing.has(t.session));
}

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
}): Promise<{ cells: AggregatedCell[]; files: number; trips: TraceKmRow[] }> {
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
  const trips: TraceKmRow[] = [];
  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      const bytes = await read(candidate.path);
      files.push({ bytes });
      // El mismo fichero sirve para dos cosas: el trafico en vivo (media por celda, `aggregateTraces`)
      // y los kilometros de ESA sesion (`trace_km`, fase E). Se parsea aqui una vez mas para no
      // cambiar la firma de `aggregateTraces`, que no sabe -ni debe saber- de que fichero viene cada
      // punto: como mucho son TRACE_MAX_FILES (500) ficheros por vuelta.
      const session = sessionOfPath(candidate.path);
      if (session) {
        const trace = parseTrace(bytes);
        const trip = trace ? tripSummary(session, trace) : undefined;
        if (trip) trips.push(trip);
      }
    } catch {
      // Un objeto borrado entre el listado y la lectura: se salta y se sigue con el resto.
    }
  }
  return { cells: aggregateTraces({ files, now, windowMs }), files: files.length, trips };
}
