import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTraces, listObjects, readObject, StorageError } from '../supabase.ts';

const ENV = { url: 'https://example.supabase.co', secretKey: 'secret-key' };
const NOW = new Date('2026-09-08T04:05:00Z'); // muy por delante de las carpetas de prueba (2020)

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}
function rawResponse(text: string, status = 200): Response {
  return { ok: status < 300, status, text: async () => text } as unknown as Response;
}

type Call = { url: string; body: any };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cleanupTraces — paginacion (M10)', () => {
  it('pagina el listado de carpetas y el de objetos dentro de cada carpeta hasta agotarlos', async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });

      if (url.endsWith('/storage/v1/object/list/traces')) {
        if (body.prefix === '') {
          // 3 carpetas repartidas en dos paginas de pageSize=2: [0,1] llena, [2] parcial.
          if (body.offset === 0) return jsonResponse([{ name: '2020-01-01' }, { name: '2020-01-02' }]);
          if (body.offset === 2) return jsonResponse([{ name: '2020-01-03' }]);
        }
        if (body.prefix === '2020-01-01') {
          // 2 objetos en dos paginas: [0,1] llena, [] vacia (fin del listado).
          if (body.offset === 0) return jsonResponse([{ name: 'a.json.gz' }, { name: 'b.json.gz' }]);
          if (body.offset === 2) return jsonResponse([]);
        }
        if (body.prefix === '2020-01-02' && body.offset === 0) return jsonResponse([{ name: 'c.json.gz' }]);
        if (body.prefix === '2020-01-03' && body.offset === 0) return jsonResponse([]);
      }
      if (url.endsWith('/storage/v1/object/traces')) return jsonResponse({});
      throw new Error(`llamada no esperada: ${url} ${init.body}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const deleted = await cleanupTraces(ENV, NOW, 30, 2);

    const folderOffsets = calls.filter((c) => c.url.endsWith('/list/traces') && c.body.prefix === '').map((c) => c.body.offset);
    expect(folderOffsets).toEqual([0, 2]);
    const objOffsets = calls.filter((c) => c.url.endsWith('/list/traces') && c.body.prefix === '2020-01-01').map((c) => c.body.offset);
    expect(objOffsets).toEqual([0, 2]);

    const deleteCalls = calls.filter((c) => c.url.endsWith('/storage/v1/object/traces'));
    expect(deleteCalls.map((c) => c.body.prefixes).sort()).toEqual([
      ['2020-01-01/a.json.gz', '2020-01-01/b.json.gz'],
      ['2020-01-02/c.json.gz'],
    ].sort());
    expect(deleted).toBe(3); // a.json.gz + b.json.gz + c.json.gz (2020-01-03 no tenia objetos)
  });
});

describe('cleanupTraces — 200 con cuerpo invalido (M11)', () => {
  it('un 200 con cuerpo vacio en el listado se trata como fallo, no como lista vacia', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawResponse('')));
    await expect(cleanupTraces(ENV, NOW)).rejects.toThrow(/cuerpo vacio/);
  });

  it('un 200 con cuerpo no JSON en el listado se trata como fallo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rawResponse('<html>Service Unavailable</html>')));
    await expect(cleanupTraces(ENV, NOW)).rejects.toThrow(/cuerpo no JSON/);
  });
});

describe('listObjects y readObject (Task 3, fase D)', () => {
  it('listObjects pagina igual que cleanupTraces y devuelve updated_at', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(url).toBe(`${ENV.url}/storage/v1/object/list/traces`);
      expect(body.prefix).toBe('2026-09-10');
      if (body.offset === 0) return jsonResponse([{ name: 'a.json.gz', updated_at: '2026-09-10T20:25:00Z' }, { name: 'b.json.gz', updated_at: '2026-09-10T20:24:00Z' }]);
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const objetos = await listObjects(ENV, '2026-09-10', 2);

    expect(objetos.map((o) => o.name)).toEqual(['a.json.gz', 'b.json.gz']);
    expect(objetos[0].updated_at).toBe('2026-09-10T20:25:00Z');
  });

  it('listObjects lanza un StorageError con el status cuando el servidor falla (ruling R65)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    await expect(listObjects(ENV, '2026-09-10')).rejects.toThrow(/HTTP 500/);

    let caught: unknown;
    try {
      await listObjects(ENV, '2026-09-10');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).status).toBe(500);
  });

  it('readObject devuelve los bytes del objeto y lanza si el servidor falla', async () => {
    const bytes = new Uint8Array([31, 139, 8, 0]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe(`${ENV.url}/storage/v1/object/traces/2026-09-10/a.json.gz`);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as unknown as Response;
    }));
    expect(await readObject(ENV, '2026-09-10/a.json.gz')).toEqual(bytes);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response));
    await expect(readObject(ENV, '2026-09-10/a.json.gz')).rejects.toThrow(/HTTP 404/);
  });
});
