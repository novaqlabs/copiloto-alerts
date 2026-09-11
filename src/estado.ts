/**
 * Estado acumulado del trafico (spec fase D §3.2): por detector, un histograma de velocidades de
 * 5 km/h con decaimiento diario (de donde sale la referencia por percentil 85), un perfil de 168
 * franjas (hora de la semana en Madrid) por media movil exponencial, y la ubicacion reducida para
 * no volver a descargar los 18,8 MB del inventario mas de una vez al dia.
 *
 * Se publica tal cual en `trafico/estado.json` y la vuelta siguiente lo recupera con
 * `--prev-estado` (decision D12 del plan). La app NUNCA lee este fichero.
 */
import type { DetectorDirection, DetectorLocation, TrafficSite } from './detectores.ts';

export const ESTADO_VERSION = 1;

/** Franjas del perfil: 7 dias x 24 horas (spec §3.2). */
export const HOURLY_SLOTS = 168;

/** Alfa de la media movil exponencial del perfil horario (spec §3.2). */
export const EMA_ALPHA = 0.1;

/** Ancho del cubo del histograma de velocidades, en km/h (spec §3.2). */
export const HIST_BUCKET_KMH = 5;

/** Factor de decaimiento diario del histograma (spec §3.2). */
export const HIST_DECAY_PER_DAY = 0.95;

/** Muestras minimas para fiarse de la referencia acumulada (spec §3.1). */
export const MIN_REFERENCE_SAMPLES = 20;

/** Percentil de las velocidades que hace de "velocidad libre" de la via (spec §3.2). */
export const REFERENCE_PERCENTILE = 0.85;

/** Cada cuanto se vuelve a descargar el inventario de ubicaciones (spec §3.2). */
export const LOCATIONS_MAX_AGE_MS = 24 * 3_600_000;

/** Peso por debajo del cual un cubo del histograma se borra: ya no cambia el percentil. */
const HIST_MIN_WEIGHT = 0.01;

/**
 * Dias sin visitas tras los que se poda una celda-sector de `traces` (I2 del repaso de fase D):
 * `estado.traces` solo inserta y nunca olvida, asi que sin tope crece para siempre y `estado.json`
 * se descarga y republica entero cada 10 minutos. 28 dias = 4 semanas de Madrid completas: es del
 * orden del mes que pide el repaso, y al ser un multiplo exacto de 7 una celda que solo se visita un
 * dia fijo de la semana (p. ej. el trayecto de los viernes) tiene siempre las mismas 4 oportunidades
 * de refrescar su franja antes de que se pode, sin que el corte caiga a mitad de semana.
 */
export const TRACE_MAX_AGE_DAYS = 28;

const MADRID = 'Europe/Madrid';

const ISO_DAY_BY_SHORT_NAME: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface EstadoLoc {
  lat: number;
  lng: number;
  road: string | null;
  area: string | null;
  bearing: number | null;
  singularity: string | null;
  /** Decision D17: hace falta para la fusion por punto Y SENTIDO cuando las ubicaciones vienen de la cache. */
  direction: DetectorDirection;
}

export interface EstadoDetector {
  loc: EstadoLoc;
  /** `floor(kmh / 5) * 5` -> peso (decae x0,95 por dia). */
  hist: Record<string, number>;
  /** Franja 0..167 -> `[media movil, muestras]`. */
  slots: Record<string, [number, number]>;
}

export interface Estado {
  version: number;
  updatedAt: string;
  locationsAt: string | null;
  /** Dia de Madrid (`yyyy-mm-dd`) en el que se aplico el ultimo decaimiento. */
  decayedOn: string | null;
  /** Ultimo dia de Madrid en el que se podo `traces` (ver [pruneTraces]). */
  tracesPrunedOn: string | null;
  detectors: Record<string, EstadoDetector>;
  /** `<celda100>_<sector>` -> franja -> `[media movil, muestras]` (Task 3). */
  traces: Record<string, Record<string, [number, number]>>;
  /**
   * `<celda100>_<sector>` -> dia de Madrid (`yyyy-mm-dd`) de la ultima vez que `updateTraces` toco
   * esa clave. Sirve solo para podar `traces` (I2): una clave sin visitas en [TRACE_MAX_AGE_DAYS] se
   * borra de los dos mapas a la vez.
   */
  traceSeenDays: Record<string, string>;
}

/** Un elemento de `trafico/historico/<celda>.json` (contrato del plan). */
export interface TrafficHistorySite {
  id: string;
  lat: number;
  lng: number;
  road: string | null;
  bearing: number | null;
  profile: (number | null)[];
}

export function emptyEstado(now: Date): Estado {
  return {
    version: ESTADO_VERSION,
    updatedAt: now.toISOString(),
    locationsAt: null,
    decayedOn: null,
    tracesPrunedOn: null,
    detectors: {},
    traces: {},
    traceSeenDays: {},
  };
}

/** El estado de la vuelta anterior; `undefined` si no parsea o es de otra version (se parte de cero). */
export function parseEstado(text: string): Estado | undefined {
  try {
    const raw = JSON.parse(text) as Partial<Estado>;
    if (raw?.version !== ESTADO_VERSION) return undefined;
    return {
      version: ESTADO_VERSION,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
      locationsAt: typeof raw.locationsAt === 'string' ? raw.locationsAt : null,
      decayedOn: typeof raw.decayedOn === 'string' ? raw.decayedOn : null,
      tracesPrunedOn: typeof raw.tracesPrunedOn === 'string' ? raw.tracesPrunedOn : null,
      detectors: raw.detectors ?? {},
      traces: raw.traces ?? {},
      // Estado publicado antes de I2 no trae este mapa: se parte vacio y el propio decaimiento
      // diario le da a cada clave sin fecha una primera fecha de referencia (ver updateEstado).
      traceSeenDays: raw.traceSeenDays ?? {},
    };
  } catch {
    return undefined;
  }
}

/** Partes de `at` en hora de Madrid: dia ISO (lunes = 1) y hora (0..23). */
function madridParts(at: Date): { isoDay: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: MADRID, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hourRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  // Algunas versiones de ICU dan "24" para la medianoche con hour12:false.
  return { isoDay: ISO_DAY_BY_SHORT_NAME[weekday] ?? 1, hour: Number.isFinite(hourRaw) ? hourRaw % 24 : 0 };
}

/** Dia natural de Madrid en formato `yyyy-mm-dd` (para el decaimiento diario). */
export function madridDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: MADRID, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/** Franja de la semana 0..167 en hora de Madrid: lunes 00:00 es la 0 (decision D7 del plan). */
export function hourlySlot(at: Date): number {
  const { isoDay, hour } = madridParts(at);
  return (isoDay - 1) * 24 + hour;
}

/**
 * Percentil 85 aproximado del histograma (spec §3.2): se recorren los cubos de menor a mayor
 * acumulando peso hasta pasar el 85 % del total y se devuelve el CENTRO de ese cubo. `undefined`
 * con menos de [MIN_REFERENCE_SAMPLES] muestras: ahi manda `defaultReferenceKmh` (Task 1).
 */
export function referenceFor(det: EstadoDetector | undefined): number | undefined {
  if (!det) return undefined;
  const buckets = Object.entries(det.hist)
    .map(([k, w]) => [Number(k), w] as const)
    .filter(([k, w]) => Number.isFinite(k) && w > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = buckets.reduce((acc, [, w]) => acc + w, 0);
  if (total < MIN_REFERENCE_SAMPLES) return undefined;
  const target = total * REFERENCE_PERCENTILE;
  let acc = 0;
  for (const [bucket, weight] of buckets) {
    acc += weight;
    if (acc >= target) return bucket + HIST_BUCKET_KMH / 2;
  }
  return buckets[buckets.length - 1][0] + HIST_BUCKET_KMH / 2;
}

/** `true` si toca volver a descargar el inventario de ubicaciones (spec §3.2). */
export function locationsAreStale(estado: Estado, now: Date): boolean {
  if (!estado.locationsAt) return true;
  const at = Date.parse(estado.locationsAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= LOCATIONS_MAX_AGE_MS;
}

/** Las ubicaciones cacheadas, en el mismo tipo que devuelve `parseDetectorLocations` (sin `pkM`: el rumbo ya esta calculado). */
export function locationsFromEstado(estado: Estado): DetectorLocation[] {
  return Object.entries(estado.detectors).map(([id, det]) => ({
    id,
    lat: det.loc.lat,
    lng: det.loc.lng,
    ...(det.loc.road ? { road: det.loc.road } : {}),
    ...(det.loc.area ? { area: det.loc.area } : {}),
    direction: det.loc.direction,
    ...(det.loc.singularity ? { singularity: det.loc.singularity } : {}),
  }));
}

/** Los rumbos cacheados, en el mismo tipo que devuelve `bearingForDetectors`. */
export function bearingsFromEstado(estado: Estado): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const [id, det] of Object.entries(estado.detectors)) out.set(id, det.loc.bearing);
  return out;
}

export interface UpdateEstadoInput {
  estado: Estado;
  /** Sitios ya publicados de esta vuelta (Task 1): solo los que traen velocidad alimentan el estado. */
  sites: TrafficSite[];
  now: Date;
  /** Inventario recien descargado; si falta, se conservan las ubicaciones cacheadas. */
  locations?: DetectorLocation[];
  bearings?: Map<string, number | null>;
}

function emptyDetector(loc: EstadoLoc): EstadoDetector {
  return { loc, hist: {}, slots: {} };
}

/** Cuantos dias naturales de Madrid separan dos fechas `yyyy-mm-dd` (0 o mas). */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Suma la vuelta actual al estado (spec §3.2). MUTA y devuelve el mismo objeto: es un fichero de
 * varios MB que se lee una vez por ejecucion y no merece una copia profunda.
 */
/**
 * Poda de `traces` (I2 del repaso final, y su re-revision): toda clave-celda sin visitas en
 * [TRACE_MAX_AGE_DAYS] se olvida, una vez por dia de Madrid.
 *
 * Vive fuera de [updateEstado] a proposito: alli quedaba dentro del bloque que solo corre cuando
 * el feed de MEDIDAS de la DGT ha respondido, asi que una caida de ese feed de varios dias dejaba
 * la poda callada mientras `updateTraces` seguia metiendo celdas nuevas -justo el caso en el que
 * el estado mas crece-. El CLI la llama en cada vuelta, haya detectores o no.
 */
export function pruneTraces(estado: Estado, now: Date): Estado {
  const today = madridDay(now);
  if (estado.tracesPrunedOn === today) return estado;
  for (const key of Object.keys(estado.traces)) {
    const lastSeen = estado.traceSeenDays[key];
    // Una clave sin fecha (estado publicado antes de este cambio) se estrena hoy, no se borra.
    if (!lastSeen) {
      estado.traceSeenDays[key] = today;
      continue;
    }
    if (daysBetween(lastSeen, today) >= TRACE_MAX_AGE_DAYS) {
      delete estado.traces[key];
      delete estado.traceSeenDays[key];
    }
  }
  // Una clave con fecha pero ya sin celda no tiene nada que podar: se limpia tambien.
  for (const key of Object.keys(estado.traceSeenDays)) {
    if (!(key in estado.traces)) delete estado.traceSeenDays[key];
  }
  estado.tracesPrunedOn = today;
  return estado;
}

export function updateEstado(input: UpdateEstadoInput): Estado {
  const { estado, sites, now } = input;

  // 1) Ubicaciones: solo si vienen frescas (una vez al dia).
  if (input.locations) {
    const bearings = input.bearings ?? new Map<string, number | null>();
    for (const loc of input.locations) {
      const reduced: EstadoLoc = {
        lat: loc.lat,
        lng: loc.lng,
        road: loc.road ?? null,
        area: loc.area ?? null,
        bearing: bearings.get(loc.id) ?? null,
        singularity: loc.singularity ?? null,
        direction: loc.direction,
      };
      const det = estado.detectors[loc.id];
      if (det) det.loc = reduced;
      else estado.detectors[loc.id] = emptyDetector(reduced);
    }
    estado.locationsAt = now.toISOString();
  }

  // 2) Decaimiento diario del histograma y poda de `traces` caducadas, ANTES de sumar las
  //    muestras de hoy. Mismo patron que el histograma: se dispara una vez por dia de Madrid.
  const today = madridDay(now);
  if (estado.decayedOn && estado.decayedOn !== today) {
    const factor = HIST_DECAY_PER_DAY ** daysBetween(estado.decayedOn, today);
    for (const det of Object.values(estado.detectors)) {
      for (const [bucket, weight] of Object.entries(det.hist)) {
        const next = weight * factor;
        if (next < HIST_MIN_WEIGHT) delete det.hist[bucket];
        else det.hist[bucket] = next;
      }
    }
  }
  estado.decayedOn = today;

  // 3) Muestras de esta vuelta. Solo los sitios CON velocidad: los `jam` por ocupacion no traen
  //    ninguna velocidad que acumular, y los de velocidad 0 con flujo 0 ya se descartaron en la
  //    Task 1 (que es justo el filtro "flow > 0" que pide la spec §3.2).
  for (const site of sites) {
    if (site.speedKmh === null) continue;
    let det = estado.detectors[site.id];
    if (!det) {
      // Todavia no hay ubicacion cacheada para este detector (primera vuelta, o inventario aun sin
      // descargar): se crea con lo que ya trae el propio sitio, y la Task 1 completa el resto (area,
      // singularity, direction) en cuanto lleguen las ubicaciones.
      det = emptyDetector({ lat: site.lat, lng: site.lng, road: site.road, area: null, bearing: site.bearing, singularity: null, direction: 'unknown' });
      estado.detectors[site.id] = det;
    }
    const bucket = String(Math.floor(site.speedKmh / HIST_BUCKET_KMH) * HIST_BUCKET_KMH);
    det.hist[bucket] = (det.hist[bucket] ?? 0) + 1;
    const at = Date.parse(site.measuredAt);
    if (!Number.isFinite(at)) continue;
    const slot = String(hourlySlot(new Date(at)));
    const previous = det.slots[slot];
    det.slots[slot] = previous
      ? [previous[0] + EMA_ALPHA * (site.speedKmh - previous[0]), previous[1] + 1]
      : [site.speedKmh, 1];
  }

  estado.updatedAt = now.toISOString();
  return estado;
}

/** Los detectores con al menos una franja madura (>= 20 muestras), listos para `trafico/historico/<celda>.json`. */
export function historicoSites(estado: Estado): TrafficHistorySite[] {
  const out: TrafficHistorySite[] = [];
  for (const [id, det] of Object.entries(estado.detectors)) {
    const profile: (number | null)[] = new Array(HOURLY_SLOTS).fill(null);
    let maduro = false;
    for (const [slot, [ema, count]] of Object.entries(det.slots)) {
      const index = Number(slot);
      if (!Number.isInteger(index) || index < 0 || index >= HOURLY_SLOTS) continue;
      if (count < MIN_REFERENCE_SAMPLES) continue;
      profile[index] = ema;
      maduro = true;
    }
    if (!maduro) continue;
    out.push({ id, lat: det.loc.lat, lng: det.loc.lng, road: det.loc.road, bearing: det.loc.bearing, profile });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
