/**
 * Detectores de trafico de la DGT (spec fase D §3.1): los dos feeds DATEX II 1.0
 * (`MeasuredDataPublication/detectores` y `PredefinedLocationsPublication/detectores`) convertidos
 * en los sitios que se publican en `trafico/<celda>.json`.
 *
 * Las MEDIDAS se parsean con expresiones regulares sobre cada bloque `siteMeasurements` (spec §8):
 * el feed real son 18 MB cada 10 minutos y montar el DOM completo con fast-xml-parser gasta
 * demasiada memoria y tiempo en Actions. Las UBICACIONES si usan el parser (`parseXml`), porque
 * solo se leen una vez al dia (Task 2 las cachea en `trafico/estado.json`).
 */
import { collect, num, parseXml, pick } from './xml.ts';

/** Antiguedad maxima de una medida respecto al `publicationTime` del feed (spec §3.1). */
export const MAX_MEASURE_AGE_MS = 15 * 60_000;

/** `singularity` de los detectores que no miden la calzada principal (spec §3.1). */
export const SKIP_SINGULARITIES = new Set(['BUS-VAO', 'SALIDA', 'ENTRADA']);

/** Ocupacion (%) a partir de la cual un detector sin velocidad ya cuenta como atasco (spec §3.1). */
export const JAM_OCCUPANCY_PCT = 40;

/** `ratio >= RATIO_FREE` es `free`; `>= RATIO_SLOW` es `slow`; por debajo, `jam` (spec §3.1). */
export const RATIO_FREE = 0.7;
export const RATIO_SLOW = 0.4;

/** Distancia maxima a un vecino de PK para fiarse de el al calcular el rumbo (spec §3.3). */
export const NEIGHBOUR_MAX_KM = 30;

export type TrafficLevel = 'free' | 'slow' | 'jam';
export type DetectorDirection = 'positive' | 'negative' | 'unknown';

/** Una `predefinedLocation` del inventario de detectores, reducida a lo que usa el pipeline. */
export interface DetectorLocation {
  id: string;
  lat: number;
  lng: number;
  road?: string;
  area?: string;
  direction: DetectorDirection;
  /** Punto kilometrico en METROS (`referencePointDistance`). */
  pkM?: number;
  singularity?: string;
}

/** Un bloque `siteMeasurements` del feed de medidas. */
export interface DetectorMeasurement {
  id: string;
  measuredAt: string;
  speedKmh?: number;
  flowVehH?: number;
  occupancyPct?: number;
}

/** Un elemento de `trafico/<celda>.json` (contrato del plan, seccion «Contratos JSON entre tramos»). */
export interface TrafficSite {
  id: string;
  lat: number;
  lng: number;
  road: string | null;
  bearing: number | null;
  speedKmh: number | null;
  level: TrafficLevel;
  ratio: number | null;
  measuredAt: string;
}

/** Primer texto util de un nodo: aplana los arrays de `isArray` (xml.ts) y los nodos con atributos (`#text`). */
function textOf(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null) return undefined;
  const raw = typeof first === 'object' ? ((first as Record<string, unknown>)['#text'] ?? (first as Record<string, unknown>).value) : first;
  const s = raw == null ? '' : String(raw).trim();
  return s === '' ? undefined : s;
}

/** Descriptor `linkName` de un `TPEGNonJunctionPoint`: la via de los detectores sin `roadNumber` (spec §3.1). */
function linkName(point: unknown): string | undefined {
  const names = (point as Record<string, unknown> | undefined)?.name;
  const list = Array.isArray(names) ? names : names == null ? [] : [names];
  for (const n of list) {
    if (textOf((n as Record<string, unknown>)?.tpegDescriptorType) !== 'linkName') continue;
    const value = textOf(pick(n, 'descriptor.value'));
    if (value) return value;
  }
  return undefined;
}

export function parseDetectorLocations(xml: string): DetectorLocation[] {
  const doc = parseXml(xml);
  const out: DetectorLocation[] = [];
  // Mismo patron que parseRadares: los inventarios cuelgan de `predefinedLocationSet`, y cada
  // entrada tiene un `predefinedLocation` externo (con `@_id`) y otro interno (con la geometria).
  for (const set of collect(doc, 'predefinedLocationSet')) {
    const entries = (set as Record<string, unknown>).predefinedLocation;
    for (const entry of (Array.isArray(entries) ? entries : entries == null ? [] : [entries]) as Record<string, unknown>[]) {
      const id = entry['@_id'];
      const inner = entry.predefinedLocation;
      const loc = Array.isArray(inner) ? inner[0] : inner;
      if (!id || !loc) continue;
      const point = pick(loc, 'tpegpointLocation.point');
      const lat = num(textOf(pick(point, 'pointCoordinates.latitude')));
      const lng = num(textOf(pick(point, 'pointCoordinates.longitude')));
      if (lat === undefined || lng === undefined) continue;
      const ref = pick(loc, 'referencePoint');
      const road = textOf(pick(ref, 'roadNumber')) ?? textOf(pick(ref, 'roadName.value')) ?? linkName(point);
      const area = textOf(pick(ref, 'administrativeArea.value'));
      const pkM = num(textOf(pick(ref, 'referencePointDistance')));
      const singularity = textOf(pick(ref, 'referencePointExtension.ExtendedReferencePoint.singularity'));
      const dirRaw = textOf(pick(ref, 'directionRelative'));
      const direction: DetectorDirection = dirRaw === 'positive' || dirRaw === 'negative' ? dirRaw : 'unknown';
      out.push({
        id: String(id),
        lat,
        lng,
        ...(road ? { road } : {}),
        ...(area ? { area } : {}),
        direction,
        ...(pkM !== undefined ? { pkM } : {}),
        ...(singularity ? { singularity } : {}),
      });
    }
  }
  return out;
}

// Un bloque `siteMeasurements` completo; `[\s\S]*?` es perezoso para no tragarse el siguiente.
const SITE_BLOCK_RE = /<(?:\w+:)?siteMeasurements\b[^>]*>([\s\S]*?)<\/(?:\w+:)?siteMeasurements>/g;
const REFERENCE_RE = /<(?:\w+:)?measurementSiteReference\b[^>]*>([^<]*)</;
const TIME_RE = /<(?:\w+:)?measurementTimeDefault\b[^>]*>([^<]*)</;
const SPEED_RE = /<(?:\w+:)?averageVehicleSpeed\b[^>]*>([^<]*)</;
const FLOW_RE = /<(?:\w+:)?vehicleFlow\b[^>]*>([^<]*)</;
const OCCUPANCY_RE = /<(?:\w+:)?occupancy\b[^>]*>([^<]*)</;
const PUBLICATION_TIME_RE = /<(?:\w+:)?publicationTime\b[^>]*>([^<]*)</;

/** Primer numero que casa `re` dentro de `block`; `undefined` si no aparece o no es numerico. */
function firstNumber(block: string, re: RegExp): number | undefined {
  const m = re.exec(block);
  return m ? num(m[1].trim()) : undefined;
}

export function parseDetectorMeasurements(xml: string): DetectorMeasurement[] {
  const out: DetectorMeasurement[] = [];
  SITE_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null = SITE_BLOCK_RE.exec(xml);
  while (block !== null) {
    const body = block[1];
    const id = REFERENCE_RE.exec(body)?.[1].trim();
    const measuredAt = TIME_RE.exec(body)?.[1].trim();
    if (id && measuredAt) {
      const speedKmh = firstNumber(body, SPEED_RE);
      const flowVehH = firstNumber(body, FLOW_RE);
      const occupancyPct = firstNumber(body, OCCUPANCY_RE);
      out.push({
        id,
        measuredAt,
        ...(speedKmh !== undefined ? { speedKmh } : {}),
        ...(flowVehH !== undefined ? { flowVehH } : {}),
        ...(occupancyPct !== undefined ? { occupancyPct } : {}),
      });
    }
    block = SITE_BLOCK_RE.exec(xml);
  }
  return out;
}

/** `publicationTime` del feed: el "ahora" contra el que se mide la antiguedad de cada medida. */
export function publicationTimeOf(xml: string): string | undefined {
  const s = PUBLICATION_TIME_RE.exec(xml)?.[1].trim();
  return s ? s : undefined;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

interface Point { lat: number; lng: number }

/** Distancia de gran circulo en km (misma formula que `haversineKm` del motor). */
function haversineKm(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumbo inicial de `a` hacia `b`, en grados [0, 360) (misma formula que `bearingDeg` del motor). */
function bearingDeg(a: Point, b: Point): number {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Una ubicacion que si tiene via y PK: las unicas que pueden dar rumbo. */
interface PkLocation extends DetectorLocation {
  road: string;
  pkM: number;
}

/**
 * Rumbo de circulacion de cada detector a partir de su PK (spec §3.3, decision D11 del plan):
 * se agrupa por `roadNumber`, se ordena por `(pkM, id)`, y el rumbo base va del vecino con PK
 * inmediatamente ANTERIOR al inmediatamente POSTERIOR (los del mismo PK se saltan). En un extremo
 * se usa el unico vecino; un vecino a 30 km o mas no cuenta. `positive` publica ese rumbo,
 * `negative` el opuesto y `unknown` siempre `null`.
 */
export function bearingForDetectors(locations: DetectorLocation[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const loc of locations) out.set(loc.id, null);

  const byRoad = new Map<string, PkLocation[]>();
  for (const loc of locations) {
    if (loc.road === undefined || loc.pkM === undefined) continue;
    const pkLoc: PkLocation = { ...loc, road: loc.road, pkM: loc.pkM };
    const arr = byRoad.get(pkLoc.road);
    if (arr) arr.push(pkLoc);
    else byRoad.set(pkLoc.road, [pkLoc]);
  }

  for (const group of byRoad.values()) {
    const sorted = [...group].sort((a, b) => a.pkM - b.pkM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      const self = sorted[i];
      if (self.direction === 'unknown') continue;
      let prev: PkLocation | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (sorted[j].pkM < self.pkM) { prev = sorted[j]; break; }
      }
      let next: PkLocation | undefined;
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].pkM > self.pkM) { next = sorted[j]; break; }
      }
      if (prev && haversineKm(prev, self) >= NEIGHBOUR_MAX_KM) prev = undefined;
      if (next && haversineKm(next, self) >= NEIGHBOUR_MAX_KM) next = undefined;
      let base: number | undefined;
      if (prev && next) base = bearingDeg(prev, next);
      else if (next) base = bearingDeg(self, next);
      else if (prev) base = bearingDeg(prev, self);
      if (base === undefined) continue;
      const heading = self.direction === 'negative' ? (base + 180) % 360 : base;
      out.set(self.id, Math.round(heading) % 360);
    }
  }
  return out;
}

/** Referencia por defecto mientras no haya 20 muestras acumuladas (spec §3.1). */
export function defaultReferenceKmh(loc: DetectorLocation): number {
  if (loc.singularity === 'AUTOPISTA / AUTOVÍA') return 110;
  if (loc.singularity === 'CIRCUNVALACIÓN') return 90;
  if (loc.singularity === 'CARRETERA NACIONAL') return 85;
  const road = loc.road ?? '';
  if (/^(?:A|AP|R)-/.test(road)) return 110;
  if (/^N-/.test(road)) return 85;
  return 60;
}

export function levelOf(ratio: number): TrafficLevel {
  if (ratio >= RATIO_FREE) return 'free';
  if (ratio >= RATIO_SLOW) return 'slow';
  return 'jam';
}

export interface BuildTrafficSitesInput {
  locations: DetectorLocation[];
  measurements: DetectorMeasurement[];
  /** `publicationTime` del feed de medidas: el "ahora" INYECTADO, nunca `Date.now()`. */
  publishedAt: Date;
  /** Rumbo por detector (`bearingForDetectors`, o el cacheado en `trafico/estado.json`). */
  bearings?: Map<string, number | null>;
  /** Referencia acumulada por detector (Task 2); `undefined` cae en [defaultReferenceKmh]. */
  referenceKmh?: (loc: DetectorLocation) => number | undefined;
}

interface Candidate {
  loc: DetectorLocation;
  m: DetectorMeasurement;
}

export function buildTrafficSites(input: BuildTrafficSitesInput): TrafficSite[] {
  const { locations, measurements, publishedAt } = input;
  const bearings = input.bearings ?? new Map<string, number | null>();
  const referenceKmh = input.referenceKmh ?? (() => undefined);
  const byId = new Map(locations.map((l) => [l.id, l] as const));
  const publishedMs = publishedAt.getTime();

  // 1) Descartes ANTES de fusionar (spec §3.1): un carril vacio (0 km/h con 0 veh/h) no debe
  //    arrastrar hacia abajo la media del carril de al lado.
  const kept: Candidate[] = [];
  for (const m of measurements) {
    const loc = byId.get(m.id);
    if (!loc) continue;
    if (loc.singularity !== undefined && SKIP_SINGULARITIES.has(loc.singularity)) continue;
    const at = Date.parse(m.measuredAt);
    if (!Number.isFinite(at)) continue;
    if (publishedMs - at > MAX_MEASURE_AGE_MS) continue;
    if (m.speedKmh === 0 && (m.flowVehH ?? 0) === 0) continue;
    if (m.speedKmh === undefined && (m.occupancyPct ?? 0) < JAM_OCCUPANCY_PCT) continue;
    kept.push({ loc, m });
  }

  // 2) Fusion por punto EXACTO y sentido (spec §3.1): son los carriles de la misma calzada.
  const groups = new Map<string, Candidate[]>();
  for (const c of kept) {
    const key = `${c.loc.lat}|${c.loc.lng}|${c.loc.direction}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const out: TrafficSite[] = [];
  for (const group of groups.values()) {
    // El id y la ubicacion son los del PRIMERO del grupo (spec §3.1), que es el primero que
    // aparecio en el feed de medidas.
    const head = group[0];
    const withSpeed = group.filter((c) => c.m.speedKmh !== undefined);
    const bearing = bearings.get(head.loc.id) ?? null;
    const base = {
      id: head.loc.id,
      lat: head.loc.lat,
      lng: head.loc.lng,
      road: head.loc.road ?? null,
      bearing,
      measuredAt: head.m.measuredAt,
    };
    if (withSpeed.length === 0) {
      // Solo sobreviven aqui los de ocupacion >= 40 sin velocidad (spec §3.1).
      out.push({ ...base, speedKmh: null, level: 'jam', ratio: null });
      continue;
    }
    const totalFlow = withSpeed.reduce((acc, c) => acc + (c.m.flowVehH ?? 0), 0);
    const speed = totalFlow > 0
      ? withSpeed.reduce((acc, c) => acc + (c.m.speedKmh ?? 0) * (c.m.flowVehH ?? 0), 0) / totalFlow
      : withSpeed.reduce((acc, c) => acc + (c.m.speedKmh ?? 0), 0) / withSpeed.length;
    const reference = referenceKmh(head.loc) ?? defaultReferenceKmh(head.loc);
    const ratio = reference > 0 ? speed / reference : 1;
    out.push({
      ...base,
      speedKmh: Math.round(speed),
      level: levelOf(ratio),
      ratio: Math.round(ratio * 100) / 100,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
