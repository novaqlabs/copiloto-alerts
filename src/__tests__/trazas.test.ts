import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { emptyEstado, type Estado } from '../estado.ts';
import { StorageError } from '../supabase.ts';
import {
  aggregateTraces,
  cellCenterOf,
  collectTraces,
  parseTrace,
  pendingTraceKm,
  sectorBearing,
  sectorOf,
  sessionOfPath,
  traceCellKey,
  traceReferenceFor,
  tripSummary,
  updateTraces,
  userSites,
} from '../trazas.ts';

const NOW = new Date('2026-09-10T20:26:00Z');           // jueves 22:26 en Madrid -> franja 94
const STARTED_AT = '2026-09-10T20:20:00Z';

/** El MISMO formato que escribe `TraceRecorder.encodeTrace` (decision D2): puntos como tuplas. */
function trazaGz(points: number[][], startedAt: string = STARTED_AT): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ v: 1, session: 'sesion-de-prueba', startedAt, points }), 'utf8')));
}

// Tres puntos en la misma celda de 100 m (40.412713, -3.707551 -> "40412_-3708") y el mismo
// sector de rumbo (190 grados -> sector 4), a 20, 22 y 24 km/h.
const TRES_PUNTOS = [
  [0, 40.412713, -3.707551, 20, 190],
  [10, 40.412720, -3.707540, 22, 191],
  [20, 40.412700, -3.707560, 24, 189],
];

describe('cuadricula de 100 m y sectores de 45 grados', () => {
  it('la celda es floor(lat x 1000)_floor(lng x 1000), tambien en longitudes negativas', () => {
    expect(traceCellKey(40.412713, -3.707551)).toBe('40412_-3708');
    expect(cellCenterOf('40412_-3708')).toEqual({ lat: 40.4125, lng: -3.7075 });
  });

  it('el sector es el rumbo entre 45, y su rumbo publicado es el centro del sector', () => {
    expect(sectorOf(0)).toBe(0);
    expect(sectorOf(44)).toBe(0);
    expect(sectorOf(190)).toBe(4);
    expect(sectorOf(359)).toBe(7);
    expect(sectorOf(-10)).toBe(7);
    expect(sectorBearing(0)).toBe(22);
    expect(sectorBearing(4)).toBe(202);
  });
});

describe('parseTrace', () => {
  it('descomprime el gzip y lee las tuplas [dtS, lat, lng, kmh, rumbo]', () => {
    const trace = parseTrace(trazaGz(TRES_PUNTOS));
    expect(trace?.startedAtMs).toBe(Date.parse(STARTED_AT));
    expect(trace?.points.length).toBe(3);
    expect(trace?.points[0]).toEqual({ dtS: 0, lat: 40.412713, lng: -3.707551, kmh: 20, bearing: 190 });
  });

  it('un fichero que no es gzip, o sin startedAt, se ignora sin lanzar', () => {
    expect(parseTrace(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(parseTrace(new Uint8Array(gzipSync(Buffer.from('{"v":1,"points":[]}', 'utf8'))))).toBeUndefined();
  });
});

describe('aggregateTraces', () => {
  it('agrupa por celda y sector con la media de velocidad y el recuento', () => {
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    expect(cells.length).toBe(1);
    expect(cells[0].key).toBe('40412_-3708_4');
    expect(cells[0].sector).toBe(4);
    expect(cells[0].lat).toBe(40.4125);
    expect(cells[0].lng).toBe(-3.7075);
    expect(cells[0].avgKmh).toBeCloseTo(22, 6);
    expect(cells[0].points).toBe(3);
    expect(cells[0].atMs).toBe(Date.parse('2026-09-10T20:20:20Z'));
  });

  it('los puntos de hace mas de 20 minutos no cuentan, aunque el fichero sea reciente', () => {
    const viejo = trazaGz([[0, 40.412713, -3.707551, 20, 190]], '2026-09-10T19:00:00Z');
    const cells = aggregateTraces({ files: [{ bytes: viejo }, { bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    expect(cells.length).toBe(1);
    expect(cells[0].points).toBe(3);
  });

  it('dos sentidos distintos en la misma celda de 100 m son dos entradas', () => {
    const contrario = trazaGz([
      [0, 40.412713, -3.707551, 60, 10],
      [10, 40.412715, -3.707550, 62, 12],
      [20, 40.412711, -3.707552, 64, 8],
    ]);
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }, { bytes: contrario }], now: NOW });
    expect(cells.map((c) => c.key)).toEqual(['40412_-3708_0', '40412_-3708_4']);
  });
});

describe('userSites', () => {
  it('publica las celdas con tres puntos o mas, con el rumbo del centro del sector', () => {
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    expect(userSites(cells, emptyEstado(NOW))).toEqual([{
      id: 'u:40412_-3708_4',
      lat: 40.4125,
      lng: -3.7075,
      road: null,
      bearing: 202,
      speedKmh: 22,
      // Sin historico acumulado no hay referencia: se publica `free` sin ratio (decision D9).
      level: 'free',
      ratio: null,
      measuredAt: '2026-09-10T20:20:20.000Z',
      points: 3,
    }]);
  });

  it('con menos de tres puntos la celda no se publica', () => {
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS.slice(0, 2)) }], now: NOW });
    expect(userSites(cells, emptyEstado(NOW))).toEqual([]);
  });

  it('con historico maduro la celda se clasifica contra el maximo de su perfil', () => {
    const estado: Estado = { ...emptyEstado(NOW), traces: { '40412_-3708_4': { '94': [60, 30], '95': [80, 5] } } };
    // Solo la franja con 20 muestras o mas cuenta como referencia: 60, no 80.
    expect(traceReferenceFor(estado, '40412_-3708_4')).toBe(60);
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    const sitios = userSites(cells, estado);
    expect(sitios[0].ratio).toBe(0.37);   // 22 / 60
    expect(sitios[0].level).toBe('jam');
  });
});

describe('updateTraces', () => {
  it('acumula la media de la celda en su franja con el mismo EMA que los detectores', () => {
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    const primera = updateTraces(emptyEstado(NOW), cells);
    expect(primera.traces['40412_-3708_4']['94'][0]).toBeCloseTo(22, 6);
    expect(primera.traces['40412_-3708_4']['94'][1]).toBe(3);
    const segunda = updateTraces(primera, cells);
    // 22 + 0,1 x (22 - 22) = 22, y el recuento suma los puntos de la segunda vuelta.
    expect(segunda.traces['40412_-3708_4']['94'][1]).toBe(6);
  });

  it('marca traceSeenDays con el dia de Madrid del punto mas reciente de la celda (I2)', () => {
    const cells = aggregateTraces({ files: [{ bytes: trazaGz(TRES_PUNTOS) }], now: NOW });
    const estado = updateTraces(emptyEstado(NOW), cells);
    // atMs de la celda es 2026-09-10T20:20:20Z, que en Madrid (verano, +02:00) sigue siendo el 10.
    expect(estado.traceSeenDays['40412_-3708_4']).toBe('2026-09-10');
  });
});

describe('collectTraces', () => {
  it('lista hoy y ayer, se queda con los modificados en los ultimos 20 min y respeta el tope', () => {
    const listados: string[] = [];
    const leidos: string[] = [];
    const bytes = trazaGz(TRES_PUNTOS);
    return collectTraces({
      now: NOW,
      maxFiles: 2,
      list: async (prefix) => {
        listados.push(prefix);
        if (prefix === '2026-09-10') {
          return [
            { name: 'a.json.gz', updated_at: '2026-09-10T20:25:00Z' },
            { name: 'b.json.gz', updated_at: '2026-09-10T20:24:00Z' },
            { name: 'c.json.gz', updated_at: '2026-09-10T20:23:00Z' },
            { name: 'viejo.json.gz', updated_at: '2026-09-10T19:00:00Z' },
            { name: 'otracosa.txt', updated_at: '2026-09-10T20:25:00Z' },
          ];
        }
        return [{ name: 'ayer.json.gz', updated_at: '2026-09-09T23:59:00Z' }];
      },
      read: async (path) => {
        leidos.push(path);
        return bytes;
      },
    }).then((res) => {
      expect(listados).toEqual(['2026-09-09', '2026-09-10']);
      // Solo los tres recientes de hoy son candidatos, y el tope deja los dos mas nuevos.
      expect(leidos).toEqual(['2026-09-10/a.json.gz', '2026-09-10/b.json.gz']);
      expect(res.files).toBe(2);
      expect(res.cells[0].points).toBe(6);
    });
  });

  it('una carpeta que todavia no existe (404) no rompe la vuelta', async () => {
    const res = await collectTraces({
      now: NOW,
      list: async (prefix) => {
        if (prefix === '2026-09-09') throw new StorageError('list traces (2026-09-09): HTTP 404', 404);
        return [{ name: 'a.json.gz', updated_at: '2026-09-10T20:25:00Z' }];
      },
      read: async () => trazaGz(TRES_PUNTOS),
    });
    expect(res.files).toBe(1);
  });

  it('un fallo real del listado (500) SI rompe la vuelta: no se confunde con una carpeta inexistente', async () => {
    await expect(collectTraces({
      now: NOW,
      list: async () => {
        throw new StorageError('list traces (2026-09-10): HTTP 500', 500);
      },
      read: async () => trazaGz(TRES_PUNTOS),
    })).rejects.toThrow(/HTTP 500/);
  });
});

describe('kilometros y minutos por trayecto (fase E)', () => {
  // Tres puntos en linea recta hacia el norte, 0,01 grados de latitud entre cada par: 1,11195 km
  // por tramo (6371 km x 0,01 grados en radianes), 2,2239 km en total -> 2,22 redondeado.
  const RECTA = [
    [0, 40.40, -3.70, 90, 0],
    [300, 40.41, -3.70, 90, 0],
    [600, 40.42, -3.70, 90, 0],
  ];

  it('tripSummary suma la distancia entre puntos consecutivos y los minutos del ultimo dtS', () => {
    const traza = parseTrace(trazaGz(RECTA));
    expect(traza).toBeDefined();
    expect(tripSummary('6f1e5a8c-0000-4000-8000-000000000001', traza!)).toEqual({
      session: '6f1e5a8c-0000-4000-8000-000000000001',
      km: 2.22,
      minutes: 10,
    });
  });

  it('un trayecto de mas de TRIP_MAX_KM no se publica aunque cada tramo pase el filtro de velocidad', () => {
    // Dos puntos separados 4 horas (14.400.000 s) y ~3.400 km (40,-3 a 55,37): velocidad implicita
    // muy por debajo de TRIP_MAX_SEGMENT_KMH (250), asi que el filtro de tramo NO lo para; el techo
    // por trayecto (C1) si.
    const traza = parseTrace(trazaGz([
      [0, 40.0, -3.0, 90, 0],
      [14_400_000, 55.0, 37.0, 90, 0],
    ]));
    expect(traza).toBeDefined();
    expect(tripSummary('s', traza!)).toBeUndefined();
  });

  it('un trayecto de menos de TRIP_MIN_KM o de un solo punto no se publica', () => {
    const corto = parseTrace(trazaGz([[0, 40.40, -3.70, 5, 0], [60, 40.4005, -3.70, 5, 0]]));
    expect(tripSummary('s', corto!)).toBeUndefined();      // 55 m
    const suelto = parseTrace(trazaGz([[0, 40.40, -3.70, 5, 0]]));
    expect(tripSummary('s', suelto!)).toBeUndefined();
  });

  it('un salto de GPS en un punto intermedio descarta SOLO los dos tramos que lo tocan, no el trayecto entero', () => {
    // R0-R1 y R3-R4 son tramos reales (0,01 grados en 300 s -> 13,34 km/h, plausible), igual que en
    // RECTA. El punto central salta 1 grado de latitud (~111 km) en 300 s: mas de 1000 km/h, muy por
    // encima del techo de 250 km/h -> los dos tramos que tocan el salto (R1-salto y salto-R3) se
    // descartan, pero R0-R1 y R3-R4 se siguen sumando igual que si el salto no estuviera.
    const conSalto = [
      [0, 40.40, -3.70, 90, 0],
      [300, 40.41, -3.70, 90, 0],
      [600, 41.42, -3.70, 90, 0],   // salto de GPS
      [900, 40.43, -3.70, 90, 0],
      [1200, 40.44, -3.70, 90, 0],
    ];
    const traza = parseTrace(trazaGz(conSalto));
    // 1,11195 km (R0-R1) + 1,11195 km (R3-R4) = 2,2239 -> 2,22, los mismos 2,22 que ya suma RECTA
    // con solo dos tramos: el salto no aporta ni resta nada, como si no estuviera.
    expect(tripSummary('s', traza!)).toEqual({ session: 's', km: 2.22, minutes: 20 });
  });

  it('puntos desordenados o con el mismo dtS no rompen tripSummary ni dan minutos negativos', () => {
    const desordenado = [
      [600, 40.42, -3.70, 90, 0],
      [0, 40.40, -3.70, 90, 0],
      [0, 40.40, -3.70, 90, 0],     // mismo dtS que el anterior: diferencia no positiva, tramo ignorado
      [300, 40.41, -3.70, 90, 0],
    ];
    const traza = parseTrace(trazaGz(desordenado));
    expect(() => tripSummary('s', traza!)).not.toThrow();
    // Los tramos con dtS <= 0 (600->0 y 0->0) se ignoran; solo cuenta 0->300 (1,11195 km, 13,34 km/h).
    // El total del trayecto (ultimo dtS menos el primero) es negativo y se recorta a 0, no a un numero negativo.
    expect(tripSummary('s', traza!)).toEqual({ session: 's', km: 1.11, minutes: 0 });
  });

  it('sessionOfPath saca el uuid del nombre del fichero y descarta lo que no lo sea', () => {
    expect(sessionOfPath('2026-09-10/6f1e5a8c-0000-4000-8000-000000000001.json.gz'))
      .toBe('6f1e5a8c-0000-4000-8000-000000000001');
    expect(sessionOfPath('2026-09-10/otra-cosa.json.gz')).toBeUndefined();
    expect(sessionOfPath('2026-09-10/')).toBeUndefined();
  });

  it('collectTraces devuelve un trayecto por fichero, ademas de las celdas de trafico', async () => {
    const sesion1 = '6f1e5a8c-0000-4000-8000-000000000001';
    const sesion2 = '9a0c4b2d-0000-4000-8000-000000000002';
    const objetos = [
      { name: `${sesion1}.json.gz`, updated_at: NOW.toISOString() },
      { name: `${sesion2}.json.gz`, updated_at: NOW.toISOString() },
    ];
    const { cells, files, trips } = await collectTraces({
      list: async (prefix) => (prefix === '2026-09-10' ? objetos : []),
      read: async () => trazaGz(RECTA, NOW.toISOString()),
      now: NOW,
    });
    expect(files).toBe(2);
    expect(trips.map((t) => t.session).sort()).toEqual([sesion1, sesion2].sort());
    expect(trips.every((t) => t.km === 2.22 && t.minutes === 10)).toBe(true);
    // La agregacion de trafico sigue funcionando igual con los mismos ficheros.
    expect(cells.length).toBeGreaterThan(0);
  });

  it('un trayecto ya calculado no se vuelve a escribir', () => {
    const yaCalculado = { session: '6f1e5a8c-0000-4000-8000-000000000001', km: 2.22, minutes: 10 };
    const nuevo = { session: '9a0c4b2d-0000-4000-8000-000000000002', km: 5.5, minutes: 8 };

    expect(pendingTraceKm([yaCalculado, nuevo], new Set([yaCalculado.session]))).toEqual([nuevo]);
    expect(pendingTraceKm([yaCalculado], new Set([yaCalculado.session]))).toEqual([]);
    expect(pendingTraceKm([yaCalculado, nuevo], new Set())).toEqual([yaCalculado, nuevo]);
  });
});
