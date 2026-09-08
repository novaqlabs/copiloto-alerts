import { parseXml, pick, num } from './xml.ts';

export interface Radar {
  id: string;
  lat: number;
  lng: number;
  endLat?: number;
  endLng?: number;
  road?: string;
  direction?: 'positive' | 'negative' | 'both' | 'unknown';
  kind: 'fixed' | 'section';
  speedLimit?: number;
  source: 'dgt';
}

const DIRECTIONS = new Set(['positive', 'negative', 'both', 'unknown']);

export function parseRadares(xml: string): Radar[] {
  const doc = parseXml(xml);
  // La muestra real de la DGT no envuelve los inventarios en un
  // "predefinedLocationContainer": cada tipo de radar (velocidad media,
  // cabina fija) es un `predefinedLocationSet` colgando directamente de
  // `payloadPublication`. `collect` recorre el árbol y encuentra ambos
  // sin asumir la profundidad exacta.
  const sets = collect(doc, 'predefinedLocationSet');
  const out: Radar[] = [];
  for (const set of sets) {
    for (const entry of (set.predefinedLocation ?? []) as any[]) {
      const id = entry['@_id'];
      const loc = Array.isArray(entry.predefinedLocation) ? entry.predefinedLocation[0] : entry.predefinedLocation;
      if (!id || !loc) continue;
      // Al quitar los prefijos de namespace, `xsi:type` pierde también el
      // prefijo del NOMBRE del atributo (queda `@_type`); el valor del
      // atributo conserva su propio prefijo `_0:` (p.ej. `_0:Linear`).
      const type = String(loc['@_type'] ?? '');
      const from = coords(pick(loc, 'tpeglinearLocation.from.pointCoordinates', 'tpegpointLocation.point.pointCoordinates', 'pointCoordinates'));
      const to = coords(pick(loc, 'tpeglinearLocation.to.pointCoordinates'));
      if (!from) continue;
      const ref = pick(loc, 'referencePointLinear.referencePointPrimaryLocation.referencePoint', 'referencePointLinear.referencePointPrimaryLocation', 'referencePoint');
      const road = pick(ref, 'roadNumber', 'roadName') ?? pick(loc, 'tpeglinearLocation.from.name.descriptor.value');
      const dirRaw = pick(ref, 'directionRelative') ?? pick(loc, 'tpeglinearLocation.tpegDirection');
      const direction = DIRECTIONS.has(dirRaw) ? dirRaw : 'unknown';
      const section = type.endsWith('Linear') && !!to;
      out.push({
        id: String(id), lat: from.lat, lng: from.lng,
        ...(section ? { endLat: to!.lat, endLng: to!.lng } : {}),
        ...(road ? { road: String(road) } : {}),
        direction, kind: section ? 'section' : 'fixed', source: 'dgt',
      });
    }
  }
  return out;
}

function coords(pc: any): { lat: number; lng: number } | undefined {
  const lat = num(pick(pc, 'latitude'));
  const lng = num(pick(pc, 'longitude'));
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

/** Recorre el árbol y devuelve todos los nodos con esa clave (el XML de la DGT anida los inventarios a distinta profundidad). */
export function collect(node: any, key: string, acc: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) collect(n, key, acc); return acc; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) { if (Array.isArray(v)) acc.push(...v); else acc.push(v); }
    else collect(v, key, acc);
  }
  return acc;
}
