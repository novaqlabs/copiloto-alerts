import { collect, num, parseXml, pick } from './xml.ts';

export type AlertTypeKey = 'accident' | 'hazard' | 'closure' | 'jam' | 'roadworks' | 'weather';

export interface Incidencia {
  id: string; type: AlertTypeKey; subtype?: string;
  lat: number; lng: number; endLat?: number; endLng?: number;
  road?: string; direction?: 'positive' | 'negative' | 'both';
  severity?: 'highest' | 'high' | 'medium' | 'low';
  text: string; validFrom: string; validTo?: string; source: 'dgt';
}

const ROAD_CLOSURE = new Set(['roadClosed', 'carriagewayClosures']);
// Restricciones de carril que no cortan la via: son senal de obras en curso
// (carril mas estrecho o trazado nuevo), no de un corte para el conductor.
const LANE_MGMT_IS_ROADWORKS = new Set(['narrowLanes', 'newRoadworksLayout']);
const HAZARD_OBJECT = new Set(['environmentalObstruction', 'obstruction', 'infrastructureDamageObstruction']);
const NAMES: Record<AlertTypeKey, string> = {
  accident: 'Accidente', hazard: 'Peligro en la via', closure: 'Corte o carril cerrado',
  jam: 'Retencion', roadworks: 'Obras', weather: 'Mal tiempo',
};

export function mapType(xsiType: string, causeType: string | undefined, detail: Record<string, string | undefined>): { type: AlertTypeKey; subtype?: string } | undefined {
  const t = xsiType.replace(/^.*:/, '');
  switch (t) {
    case 'Accident': return { type: 'accident' };
    case 'AbnormalTraffic': return { type: 'jam' };
    case 'PoorEnvironmentConditions': {
      const p = detail.poorEnvironmentType;
      const subtype = p === 'fog' ? 'fog' : p === 'visibilityReduced' ? 'fog' : p?.includes('ice') || p?.includes('Ice') ? 'ice' : p?.includes('wind') ? 'wind' : 'rain';
      return { type: 'weather', subtype };
    }
    case 'NonWeatherRelatedRoadConditions':
    case 'WeatherRelatedRoadConditions': return { type: 'hazard', subtype: 'road' };
    case 'GeneralObstruction':
    case 'EnvironmentalObstruction':
    case 'VehicleObstruction':
    case 'AnimalPresenceObstruction': return { type: 'hazard', subtype: t === 'AnimalPresenceObstruction' ? 'animal' : t === 'VehicleObstruction' ? 'road' : 'object' };
    case 'RoadOrCarriagewayOrLaneManagement': {
      const m = detail.roadOrCarriagewayOrLaneManagementType;
      // Caso especial (ruling R40): si la causa es mantenimiento de la via y la
      // gestion de carril es "narrowLanes" o "newRoadworksLayout", para el
      // conductor eso son obras en marcha, no un corte — a diferencia de
      // laneClosures/singleAlternateLineTraffic/etc., que si son una restriccion
      // real de circulacion. Los tres casos unitarios de este xsi:type
      // (roadClosed, laneClosures, carriagewayClosures) no usan estos dos
      // valores, asi que siguen devolviendo 'closure' sin cambios.
      if (causeType === 'roadMaintenance' && m && LANE_MGMT_IS_ROADWORKS.has(m)) return { type: 'roadworks' };
      return { type: 'closure', subtype: m && ROAD_CLOSURE.has(m) ? 'road' : 'lane' };
    }
    case 'MaintenanceWorks':
    case 'ConstructionWorks': return { type: 'roadworks' };
    case 'GenericSituationRecord': {
      switch (causeType) {
        case 'roadMaintenance': return { type: 'roadworks' };
        case 'accident': return { type: 'accident' };
        case 'vehicleObstruction': return { type: 'hazard', subtype: 'road' };
        case 'abnormalTraffic': return { type: 'jam' };
        case 'poorEnvironment': return { type: 'weather' };
        case 'roadOrCarriagewayOrLaneManagement': return { type: 'closure', subtype: 'lane' };
        default: return causeType && HAZARD_OBJECT.has(causeType) ? { type: 'hazard', subtype: 'object' } : undefined;
      }
    }
    default: return undefined;
  }
}

export function parseIncidencias(xml: string, now: Date): { items: Incidencia[]; discarded: Record<string, number> } {
  const doc = parseXml(xml);
  const records = collect(doc, 'situationRecord');
  const items: Incidencia[] = [];
  const discarded: Record<string, number> = {};
  const drop = (why: string) => { discarded[why] = (discarded[why] ?? 0) + 1; };
  for (const r of records) {
    // Tras removeNSPrefix el nombre del atributo pierde el prefijo ("@_type",
    // no "@_xsi:type"); el VALOR conserva el suyo propio (p.ej. "sit:Accident").
    const xsiType = String(r['@_type'] ?? 'unknown').replace(/^.*:/, '');
    const id = r['@_id'];
    if (!id) { drop('sin_id'); continue; }
    const cause = r.cause ?? {};
    const detail: Record<string, string | undefined> = {};
    const detailed = cause.detailedCauseType ?? {};
    for (const [k, v] of Object.entries(detailed)) detail[k] = typeof v === 'string' ? v : undefined;
    // Algunos tipos detallados vienen tambien (o solo) como campo directo del registro.
    for (const k of ['roadOrCarriagewayOrLaneManagementType', 'abnormalTrafficType', 'poorEnvironmentType', 'obstructionType']) {
      if (typeof r[k] === 'string') detail[k] = r[k];
    }
    const mapped = mapType(xsiType, typeof cause.causeType === 'string' ? cause.causeType : undefined, detail);
    if (!mapped) { drop(xsiType); continue; }
    const status = pick(r, 'validity.validityStatus');
    const validFrom = pick(r, 'validity.validityTimeSpecification.overallStartTime');
    const validTo = pick(r, 'validity.validityTimeSpecification.overallEndTime');
    if (status === 'suspended' || (validTo && new Date(validTo).getTime() < now.getTime())) { drop('terminada'); continue; }
    if (!validFrom) { drop('sin_validez'); continue; }
    const loc = r.locationReference ?? {};
    const from = coords(pick(loc, 'tpegLinearLocation.from.pointCoordinates', 'tpegPointLocation.point.pointCoordinates', 'pointCoordinates'));
    const to = coords(pick(loc, 'tpegLinearLocation.to.pointCoordinates'));
    if (!from) { drop('sin_coordenadas'); continue; }
    const road = pick(loc, 'supplementaryPositionalDescription.roadInformation.roadName', 'roadInformation.roadName');
    // El sentido va en la extension espanola del punto/tramo, no en
    // "supplementaryPositionalDescription" (comprobado contra la muestra real).
    const dirRaw = pick(
      loc,
      'tpegLinearLocation._tpegLinearLocationExtension.extendedTpegLinearLocation.tpegDirectionRoad',
      'tpegPointLocation._tpegSimplePointExtension.extendedTpegSimplePoint.tpegDirectionRoad',
      'supplementaryPositionalDescription.tpegDirectionRoad',
      'tpegDirectionRoad',
    );
    const direction = dirRaw === 'positive' || dirRaw === 'negative' || dirRaw === 'both' ? dirRaw : undefined;
    const sevRaw = pick(r, 'severity');
    const severity = sevRaw === 'highest' || sevRaw === 'high' || sevRaw === 'medium' || sevRaw === 'low' ? sevRaw : undefined;
    const comment = pick(r, 'generalPublicComment.comment.values.value');
    const text = typeof comment === 'string' && comment.trim() ? comment.trim()
      : `${NAMES[mapped.type]}${road ? ` en ${road}` : ''}`;
    items.push({
      id: String(id), type: mapped.type, ...(mapped.subtype ? { subtype: mapped.subtype } : {}),
      lat: from.lat, lng: from.lng, ...(to ? { endLat: to.lat, endLng: to.lng } : {}),
      ...(road ? { road: String(road) } : {}), ...(direction ? { direction } : {}), ...(severity ? { severity } : {}),
      text, validFrom: String(validFrom), ...(validTo ? { validTo: String(validTo) } : {}), source: 'dgt',
    });
  }
  return { items, discarded };
}

function coords(pc: any): { lat: number; lng: number } | undefined {
  const lat = num(pick(pc, 'latitude'));
  const lng = num(pick(pc, 'longitude'));
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}
