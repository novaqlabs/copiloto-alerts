import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { emptyEstado, type Estado } from '../estado.ts';
import {
  aggregateTraces,
  cellCenterOf,
  collectTraces,
  parseTrace,
  sectorBearing,
  sectorOf,
  traceCellKey,
  traceReferenceFor,
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

  it('una carpeta que todavia no existe no rompe la vuelta', async () => {
    const res = await collectTraces({
      now: NOW,
      list: async (prefix) => {
        if (prefix === '2026-09-09') throw new Error('HTTP 404');
        return [{ name: 'a.json.gz', updated_at: '2026-09-10T20:25:00Z' }];
      },
      read: async () => trazaGz(TRES_PUNTOS),
    });
    expect(res.files).toBe(1);
  });
});
