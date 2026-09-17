import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRadares } from '../radares.ts';
import {
  OSM_BBOX_MARGIN_DEG,
  OSM_CACHE_MAX_AGE_DAYS,
  OSM_MATCH_MAX_M,
  cellsWithRadares,
  emptyOsmCameraCache,
  matchOsmCameras,
  osmCacheIsStale,
  overpassCamerasQuery,
  parseOsmCameraCache,
  parseOverpassCameras,
  refreshOsmCameras,
  type OsmCameraCache,
} from '../osm-cameras.ts';
import type { Radar } from '../radares.ts';

const xml = readFileSync(new URL('../../fixtures/radares.xml', import.meta.url), 'utf8');

describe('parseRadares', () => {
  const radares = parseRadares(xml);
  it('lee todos los radares de la muestra', () => {
    expect(radares.length).toBeGreaterThanOrEqual(700);
    expect(radares.length).toBeLessThanOrEqual(800);
    expect(new Set(radares.map((r) => r.id)).size).toBe(radares.length);
  });
  it('un tramo lleva inicio y fin y kind section', () => {
    const z40 = radares.find((r) => r.id === 'GUID_CVM_161274')!;
    expect(z40.kind).toBe('section');
    expect(z40.lat).toBeCloseTo(41.6088, 4);
    expect(z40.lng).toBeCloseTo(-0.915697, 5);
    expect(z40.endLat).toBeCloseTo(41.6192, 4);
    expect(z40.endLng).toBeCloseTo(-0.9496, 4);
    expect(z40.road).toBe('Z-40');
    expect(z40.source).toBe('dgt');
  });
  it('los puntuales no tienen fin y todos tienen coordenadas validas', () => {
    const fixed = radares.filter((r) => r.kind === 'fixed');
    expect(fixed.length).toBeGreaterThan(0);
    for (const r of radares) {
      expect(Number.isFinite(r.lat) && Number.isFinite(r.lng)).toBe(true);
      if (r.kind === 'fixed') expect(r.endLat).toBeUndefined();
      expect(['positive', 'negative', 'both', 'unknown']).toContain(r.direction ?? 'unknown');
    }
  });
});

describe('cruce con los radares de OpenStreetMap', () => {
  // Un radar de la DGT en la A-31, celda `38_-1`.
  const dgt: Radar = {
    id: 'GUID_CAB_1',
    lat: 38.4,
    lng: -0.6,
    road: 'A-31',
    direction: 'positive',
    kind: 'fixed',
    source: 'dgt',
  };

  /** Desplaza `lat` los metros indicados hacia el norte (1 grado de latitud = 111.320 m). */
  const norte = (lat: number, metros: number) => lat + metros / 111_320;

  const cacheCon = (camaras: { lat: number; lng: number }[]): OsmCameraCache => ({
    updatedAt: '2026-09-17T04:00:00.000Z',
    cells: { '38_-1': camaras },
  });

  it('sustituye la posicion cuando hay una camara de OSM a menos de 250 m', () => {
    const cache = cacheCon([{ lat: norte(38.4, 120), lng: -0.6 }]);

    const { radares, matched } = matchOsmCameras([dgt], cache);

    expect(matched).toBe(1);
    expect(radares[0].source_position).toBe('osm');
    expect(radares[0].lat).toBeCloseTo(norte(38.4, 120), 6);
    expect(radares[0].lng).toBe(-0.6);
    // Lo demas no se toca.
    expect(radares[0].id).toBe('GUID_CAB_1');
    expect(radares[0].road).toBe('A-31');
    expect(radares[0].source).toBe('dgt');
  });

  it('no sustituye si la camara mas cercana esta a 400 m', () => {
    const cache = cacheCon([{ lat: norte(38.4, 400), lng: -0.6 }]);

    const { radares, matched } = matchOsmCameras([dgt], cache);

    expect(matched).toBe(0);
    expect(radares[0].source_position).toBe('dgt');
    expect(radares[0].lat).toBe(38.4);
  });

  it('elige la camara mas cercana cuando hay varias dentro del radio', () => {
    const cache = cacheCon([
      { lat: norte(38.4, 240), lng: -0.6 },
      { lat: norte(38.4, 30), lng: -0.6 },
      { lat: norte(38.4, 180), lng: -0.6 },
    ]);

    const { radares } = matchOsmCameras([dgt], cache);

    expect(radares[0].lat).toBeCloseTo(norte(38.4, 30), 6);
  });

  it('sin datos de OSM todo se publica como dgt', () => {
    const { radares, matched } = matchOsmCameras([dgt], emptyOsmCameraCache());

    expect(matched).toBe(0);
    expect(radares[0].source_position).toBe('dgt');
    expect(radares[0].lat).toBe(38.4);
    expect(radares[0].lng).toBe(-0.6);
  });

  it('de un radar de tramo solo se mueve el inicio', () => {
    const tramo: Radar = { ...dgt, id: 'GUID_CVM_1', kind: 'section', endLat: 38.45, endLng: -0.62 };
    const cache = cacheCon([{ lat: norte(38.4, 60), lng: -0.6 }]);

    const { radares } = matchOsmCameras([tramo], cache);

    expect(radares[0].lat).toBeCloseTo(norte(38.4, 60), 6);
    expect(radares[0].endLat).toBe(38.45);
    expect(radares[0].endLng).toBe(-0.62);
  });

  it('el umbral es el de la spec', () => {
    expect(OSM_MATCH_MAX_M).toBe(250);
    expect(OSM_CACHE_MAX_AGE_DAYS).toBe(7);
  });

  it('la consulta pide nodos highway=speed_camera en la caja de la celda, con margen', () => {
    const query = overpassCamerasQuery('38_-1');

    expect(query).toContain('[out:json][timeout:20]');
    expect(query).toContain('node["highway"="speed_camera"]');
    // Celda 38_-1 => caja (38, -1) a (39, 0), ensanchada OSM_BBOX_MARGIN_DEG por cada lado.
    const sur = (38 - OSM_BBOX_MARGIN_DEG).toFixed(4);
    const oeste = (-1 - OSM_BBOX_MARGIN_DEG).toFixed(4);
    const norteCaja = (39 + OSM_BBOX_MARGIN_DEG).toFixed(4);
    const este = (0 + OSM_BBOX_MARGIN_DEG).toFixed(4);
    expect(query).toContain(`(${sur},${oeste},${norteCaja},${este})`);
    expect(query.endsWith('out skel qt;')).toBe(true);
  });

  it('parsea los nodos de una respuesta de Overpass y descarta lo demas', () => {
    const body = JSON.stringify({
      elements: [
        { type: 'node', id: 1, lat: 38.41, lon: -0.61 },
        { type: 'way', id: 2 },
        { type: 'node', id: 3, lat: 'x', lon: -0.62 },
        { type: 'node', id: 4, lat: 38.43, lon: -0.63 },
      ],
    });

    expect(parseOverpassCameras(body)).toEqual([
      { lat: 38.41, lng: -0.61 },
      { lat: 38.43, lng: -0.63 },
    ]);
  });

  it('una respuesta que no es JSON no rompe nada', () => {
    expect(parseOverpassCameras('<html>502</html>')).toEqual([]);
    expect(parseOverpassCameras('{"algo":1}')).toEqual([]);
  });

  it('la cache caduca a los siete dias', () => {
    const cache = cacheCon([]);
    expect(osmCacheIsStale(cache, new Date('2026-09-20T04:00:00.000Z'))).toBe(false);
    expect(osmCacheIsStale(cache, new Date('2026-09-24T03:59:00.000Z'))).toBe(false);
    expect(osmCacheIsStale(cache, new Date('2026-09-25T04:00:00.000Z'))).toBe(true);
    expect(osmCacheIsStale(emptyOsmCameraCache(), new Date('2026-09-17T04:00:00.000Z'))).toBe(true);
  });

  it('una cache ilegible se trata como vacia', () => {
    expect(parseOsmCameraCache('{')).toBeUndefined();
    expect(parseOsmCameraCache('{"cells":{}}')).toBeUndefined();
    expect(parseOsmCameraCache(JSON.stringify(cacheCon([])))?.cells['38_-1']).toEqual([]);
  });

  it('solo se consultan las celdas que tienen radares, sin repetir', () => {
    const otro: Radar = { ...dgt, id: 'GUID_CAB_2', lat: 40.4, lng: -3.7 };
    const tercero: Radar = { ...dgt, id: 'GUID_CAB_3', lat: 38.9, lng: -0.1 };

    expect(cellsWithRadares([dgt, otro, tercero])).toEqual(['38_-1', '40_-4']);
  });

  it('refrescar consulta cada celda y guarda la fecha', async () => {
    const consultadas: string[] = [];
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4'],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async (cell) => {
        consultadas.push(cell);
        return [{ lat: 38.41, lng: -0.61 }];
      },
    });

    expect(consultadas).toEqual(['38_-1', '40_-4']);
    expect(resultado.queried).toBe(2);
    expect(resultado.failed).toBe(0);
    expect(resultado.cache.updatedAt).toBe('2026-09-17T04:02:00.000Z');
    expect(resultado.cache.cells['40_-4']).toEqual([{ lat: 38.41, lng: -0.61 }]);
  });

  it('una celda que falla conserva lo que ya habia, y las demas siguen', async () => {
    const previa = cacheCon([{ lat: 38.41, lng: -0.61 }]);
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4'],
      cache: previa,
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async (cell) => {
        if (cell === '38_-1') throw new Error('HTTP 429');
        return [{ lat: 40.41, lng: -3.71 }];
      },
    });

    expect(resultado.queried).toBe(1);
    expect(resultado.failed).toBe(1);
    expect(resultado.cache.cells['38_-1']).toEqual([{ lat: 38.41, lng: -0.61 }]);
    expect(resultado.cache.cells['40_-4']).toEqual([{ lat: 40.41, lng: -3.71 }]);
  });

  it('si fallan todas, la cache anterior se deja intacta y sin tocar la fecha', async () => {
    const previa = cacheCon([{ lat: 38.41, lng: -0.61 }]);
    const resultado = await refreshOsmCameras({
      cells: ['38_-1'],
      cache: previa,
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async () => {
        throw new Error('timeout');
      },
    });

    expect(resultado.queried).toBe(0);
    expect(resultado.failed).toBe(1);
    expect(resultado.cache).toEqual(previa);
  });
});
