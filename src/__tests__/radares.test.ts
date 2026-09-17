import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRadares } from '../radares.ts';
import {
  OSM_BBOX_MARGIN_DEG,
  OSM_CACHE_MAX_AGE_DAYS,
  OSM_MATCH_MAX_M,
  OSM_QUERY_TIMEOUT_MS,
  OSM_REFRESH_BUDGET_MS,
  OverpassAbortError,
  cellsWithRadares,
  emptyOsmCameraCache,
  matchOsmCameras,
  metersBetween,
  osmCacheIsStale,
  overpassCamerasQuery,
  parseOsmCameraCache,
  parseOverpassCameras,
  refreshAndMatchOsmCameras,
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

  /**
   * Como `norte`, pero con la MISMA formula (radio terrestre 6.371.000 m) que usa `metersBetween`
   * en produccion desde la ronda 1 de arreglos: para un desplazamiento puro norte-sur, el haversine
   * se reduce a `distancia = radio * deltaLat(radianes)`, asi que esta es su inversa exacta. Solo
   * se usa en las pruebas de frontera de 250 m, donde el ~0,1% de diferencia frente a `norte`
   * (pensada para casar con el motor de la app, no con haversine) si importa.
   */
  const norteHaversine = (lat: number, metros: number) => lat + (metros / 6_371_000) * (180 / Math.PI);

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

  // Item 8 del repaso final («Mejoras 1»): 10 s por celda, 120 s de presupuesto agregado por vuelta.
  it('los topes de tiempo del presupuesto agregado son los del repaso final', () => {
    expect(OSM_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(OSM_REFRESH_BUDGET_MS).toBe(120_000);
  });

  it('la consulta pide nodos highway=speed_camera en la caja de la celda, con margen', () => {
    const query = overpassCamerasQuery('38_-1');

    expect(query).toContain('[out:json][timeout:10]');
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

  // Item 8 del repaso final («Mejoras 1», Important I2 del informe original): presupuesto agregado
  // de 120 s por vuelta, con reloj y fetch simulados -nunca `Date.now`/red de verdad-.
  it('agotado el presupuesto de 120 s, las celdas restantes no se consultan', async () => {
    let elapsedMs = 0;
    const consultadas: string[] = [];
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4', '41_-2'],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'),
      clockMs: () => elapsedMs,
      fetchCell: async (cell) => {
        consultadas.push(cell);
        // Cada consulta "tarda" 70 s simulados: la tercera celda ya no cabe en los 120 s del
        // presupuesto (70 + 70 = 140 >= 120), asi que ni se pide.
        elapsedMs += 70_000;
        return [{ lat: 38.41, lng: -0.61 }];
      },
    });

    expect(consultadas).toEqual(['38_-1', '40_-4']);
    expect(resultado.queried).toBe(2);
    expect(resultado.failed).toBe(0);
    expect(resultado.budgetExceeded).toBe(true);
    expect(resultado.cache.cells['41_-2']).toBeUndefined();
  });

  it('dentro del presupuesto se consultan todas las celdas y budgetExceeded es false', async () => {
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4'],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'),
      clockMs: () => 0,
      fetchCell: async () => [{ lat: 38.41, lng: -0.61 }],
    });

    expect(resultado.queried).toBe(2);
    expect(resultado.budgetExceeded).toBe(false);
  });
});

describe('ronda 1 de arreglos (revision de la Task 4)', () => {
  const dgt: Radar = {
    id: 'GUID_CAB_1',
    lat: 38.4,
    lng: -0.6,
    road: 'A-31',
    direction: 'positive',
    kind: 'fixed',
    source: 'dgt',
  };

  const norte = (lat: number, metros: number) => lat + metros / 111_320;

  /** Ver la nota de `norteHaversine` del describe anterior: aqui hace falta la misma inversa exacta
   * del haversine (no la de `norte`, pensada para el motor de la app) porque la frontera de 250 m
   * es sensible al 0,1% de diferencia entre ambos modelos. */
  const norteHaversine = (lat: number, metros: number) => lat + (metros / 6_371_000) * (180 / Math.PI);

  const cacheCon = (camaras: { lat: number; lng: number }[]): OsmCameraCache => ({
    updatedAt: '2026-09-17T04:00:00.000Z',
    cells: { '38_-1': camaras },
  });

  // Important #1: tres recuentos, no solo "matched".
  it('matchOsmCameras cuenta por separado los cruzados, los que no llegan a 250 m y los que no tienen datos de OSM', () => {
    const cerca: Radar = { ...dgt, id: 'GUID_CAB_A' };
    // Misma celda 38_-1 que `cerca`, pero a ~61 km de la unica camara de esa celda: no cruza.
    const lejos: Radar = { ...dgt, id: 'GUID_CAB_B', lat: 38.9, lng: -0.9 };
    // Celda 40_-4, sin ninguna entrada en la cache.
    const sinDatos: Radar = { ...dgt, id: 'GUID_CAB_C', lat: 40.4, lng: -3.7 };
    const cache = cacheCon([{ lat: norte(38.4, 120), lng: -0.6 }]);

    const { matched, tooFar, withoutOsmData } = matchOsmCameras([cerca, lejos, sinDatos], cache);

    expect(matched).toBe(1);
    expect(tooFar).toBe(1);
    expect(withoutOsmData).toBe(1);
  });

  // Important #2: un fallo al escribir la cache en disco NUNCA debe perder el cruce ya calculado.
  it('si falla la escritura de la cache en disco, el cruce ya calculado no se pierde y todos los radares llevan source_position', async () => {
    const resultado = await refreshAndMatchOsmCameras({
      radares: [dgt],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'), // caducada y dentro de la ventana diaria
      fetchCell: async () => [{ lat: norte(38.4, 120), lng: -0.6 }],
      writeCache: async () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(resultado.refreshed).toBe(true);
    expect(resultado.queried).toBe(1);
    expect(resultado.matched).toBe(1);
    expect(resultado.radares[0].source_position).toBe('osm');
    expect(resultado.cacheWriteError).toContain('EACCES');
  });

  it('si la escritura en disco va bien, no hay cacheWriteError y la cache escrita es la refrescada', async () => {
    const escritas: OsmCameraCache[] = [];
    const resultado = await refreshAndMatchOsmCameras({
      radares: [dgt],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async () => [{ lat: norte(38.4, 120), lng: -0.6 }],
      writeCache: async (c) => {
        escritas.push(c);
      },
    });

    expect(resultado.cacheWriteError).toBeUndefined();
    expect(escritas).toHaveLength(1);
    expect(escritas[0].cells['38_-1']).toEqual([{ lat: norte(38.4, 120), lng: -0.6 }]);
  });

  it('con la cache al dia, refreshAndMatchOsmCameras no toca la red ni el disco', async () => {
    let fetchCalls = 0;
    let writeCalls = 0;
    const cache = cacheCon([{ lat: norte(38.4, 120), lng: -0.6 }]); // updatedAt reciente
    const resultado = await refreshAndMatchOsmCameras({
      radares: [dgt],
      cache,
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async () => {
        fetchCalls++;
        return [];
      },
      writeCache: async () => {
        writeCalls++;
      },
    });

    expect(resultado.refreshed).toBe(false);
    expect(fetchCalls).toBe(0);
    expect(writeCalls).toBe(0);
    expect(resultado.matched).toBe(1); // usa la cache tal cual, sin refrescar
  });

  // Item 10 del repaso final («Mejoras 1», Minor m5 del informe original): la mitad de M10 que de
  // verdad protege a Overpass de ~4.300 consultas al dia -caducada Y ventana son un Y, no basta con
  // que la cache este vieja si la vuelta cae fuera de las 04:00-04:09 UTC-.
  it('con la cache caducada pero fuera de la ventana diaria, refreshAndMatchOsmCameras tampoco toca la red', async () => {
    let fetchCalls = 0;
    let writeCalls = 0;
    const resultado = await refreshAndMatchOsmCameras({
      radares: [dgt],
      cache: emptyOsmCameraCache(), // updatedAt de 1970: caducada de sobra
      now: new Date('2026-09-17T12:00:00.000Z'), // fuera de la ventana 04:00-04:09 UTC
      fetchCell: async () => {
        fetchCalls++;
        return [{ lat: norte(38.4, 120), lng: -0.6 }];
      },
      writeCache: async () => {
        writeCalls++;
      },
    });

    expect(resultado.refreshed).toBe(false);
    expect(fetchCalls).toBe(0);
    expect(writeCalls).toBe(0);
    expect(resultado.matched).toBe(0); // sin cache no hay con que cruzar: se publica la posicion de la DGT
  });

  // Item 7 del repaso final: `forceRefresh` (la opcion de CLI `--refresh-osm-cache`) salta las DOS
  // condiciones -ni hace falta que la cache este caducada ni que sea la ventana diaria-.
  it('forceRefresh consulta la red aunque la cache este al dia y fuera de la ventana diaria', async () => {
    let fetchCalls = 0;
    const cache = cacheCon([]); // updatedAt reciente: no caducada
    const resultado = await refreshAndMatchOsmCameras({
      radares: [dgt],
      cache,
      now: new Date('2026-09-17T12:00:00.000Z'), // fuera de la ventana 04:00-04:09 UTC
      forceRefresh: true,
      fetchCell: async () => {
        fetchCalls++;
        return [{ lat: norte(38.4, 120), lng: -0.6 }];
      },
      writeCache: async () => {},
    });

    expect(resultado.refreshed).toBe(true);
    expect(fetchCalls).toBe(1);
    expect(resultado.matched).toBe(1);
    // El campo `cache` del resultado es la EFECTIVAMENTE usada (item 7: `cli.ts` la publica en
    // `out/osm-cameras.json` en cada vuelta, refresque o no).
    expect(resultado.cache.cells['38_-1']).toEqual([{ lat: norte(38.4, 120), lng: -0.6 }]);
  });

  // Minor #3: el corte es "menos de 250 m" en sentido estricto (>=, no >).
  it('a exactamente 250 m no sustituye: el corte es estrictamente "menos de 250 m"', () => {
    const cache = cacheCon([{ lat: norteHaversine(38.4, OSM_MATCH_MAX_M), lng: -0.6 }]);

    const { matched, tooFar } = matchOsmCameras([dgt], cache);

    expect(matched).toBe(0);
    expect(tooFar).toBe(1);
  });

  it('un metro por debajo de 250 m si sustituye', () => {
    const cache = cacheCon([{ lat: norteHaversine(38.4, OSM_MATCH_MAX_M - 1), lng: -0.6 }]);

    const { matched } = matchOsmCameras([dgt], cache);

    expect(matched).toBe(1);
  });

  // Minor #4: un 429/504 de Overpass abandona el resto de celdas de esta vuelta, sin reintentar.
  it('un 429/504 de Overpass abandona las celdas restantes de esta vuelta, sin martillear', async () => {
    const previa = cacheCon([{ lat: 38.41, lng: -0.61 }]);
    const consultadas: string[] = [];
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4', '41_-2'],
      cache: previa,
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async (cell) => {
        consultadas.push(cell);
        if (cell === '40_-4') throw new OverpassAbortError('HTTP 429');
        return [{ lat: 40.41, lng: -3.71 }];
      },
    });

    // Nunca llega a pedir la tercera celda.
    expect(consultadas).toEqual(['38_-1', '40_-4']);
    expect(resultado.queried).toBe(1);
    expect(resultado.failed).toBe(1);
    // La primera celda si se refresco antes del 429; la tercera ni se toco (no habia entrada previa).
    expect(resultado.cache.cells['38_-1']).toEqual([{ lat: 40.41, lng: -3.71 }]);
    expect(resultado.cache.cells['41_-2']).toBeUndefined();
  });

  it('un error normal (no 429/504) solo descarta su propia celda, las demas siguen', async () => {
    const consultadas: string[] = [];
    const resultado = await refreshOsmCameras({
      cells: ['38_-1', '40_-4'],
      cache: emptyOsmCameraCache(),
      now: new Date('2026-09-17T04:02:00.000Z'),
      fetchCell: async (cell) => {
        consultadas.push(cell);
        if (cell === '38_-1') throw new Error('HTTP 500');
        return [{ lat: 40.41, lng: -3.71 }];
      },
    });

    expect(consultadas).toEqual(['38_-1', '40_-4']);
    expect(resultado.queried).toBe(1);
    expect(resultado.failed).toBe(1);
  });

  // Minor #5: metersBetween usa haversine de verdad (radio 6.371.000 m), no una proyeccion plana.
  it('metersBetween usa haversine: un grado de latitud en el ecuador son ~111.195 km', () => {
    const d = metersBetween(0, 0, 1, 0);
    // La proyeccion plana anterior (con el M_PER_DEG_LAT de la app, 111.320 m) habria dado 111320.
    expect(d).toBeCloseTo(111194.93, -2);
  });

  it('metersBetween aplica el termino cos(lat): un grado de longitud a 60 N son ~55.597 km', () => {
    const d = metersBetween(60, 0, 60, 1);
    expect(d).toBeCloseTo(55596.93, -2);
  });
});
