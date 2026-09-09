/** Solo se ejecuta en GitHub Actions con la clave secreta como secreto del repo. Nunca en la app. */
export interface SupabaseEnv { url: string; secretKey: string }

const LIST_PAGE_SIZE = 1000;

/**
 * Lee el cuerpo de una respuesta que deberia traer JSON. Un 200 con el cuerpo vacio o que no
 * parsea a JSON se trata como fallo (lanza), nunca como una lista vacia silenciosa: un proxy, una
 * respuesta truncada o un error de la CDN tambien pueden devolver HTTP 200.
 */
async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!text.trim()) throw new Error(`${context}: HTTP ${res.status} con cuerpo vacio`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${context}: HTTP ${res.status} con cuerpo no JSON (${text.slice(0, 200)})`);
  }
}

export async function syncReportTypes(catalogo: { types: { key: string; enabled: boolean; ttlMin: number; extendMin: number; priority: number; official?: boolean }[] }, env: SupabaseEnv): Promise<number> {
  const rows = catalogo.types.filter((t) => !t.official).map((t) => ({ key: t.key, enabled: t.enabled, ttl_min: t.ttlMin, extend_min: t.extendMin, priority: t.priority }));
  const res = await fetch(`${env.url}/rest/v1/report_types?on_conflict=key`, {
    method: 'POST',
    headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`report_types: HTTP ${res.status} ${await res.text()}`);
  return rows.length;
}

/**
 * Lista todos los objetos de Storage bajo `prefix`, paginando por `offset`/`limit` hasta que una
 * pagina vuelve con menos elementos que `pageSize` (fin del listado). La API de Storage limita
 * cada llamada a como mucho `pageSize` filas, asi que sin paginar solo se ven los primeros
 * `pageSize`.
 */
async function listAll(env: SupabaseEnv, headers: Record<string, string>, prefix: string, pageSize: number): Promise<{ name: string }[]> {
  const all: { name: string }[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${env.url}/storage/v1/object/list/traces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list traces (${prefix || 'raiz'}): HTTP ${res.status}`);
    const page = await readJson<{ name: string }[]>(res, `list traces (${prefix || 'raiz'})`);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

export async function cleanupTraces(env: SupabaseEnv, now: Date, maxAgeDays = 30, pageSize = LIST_PAGE_SIZE): Promise<number> {
  const headers = { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}`, 'Content-Type': 'application/json' };
  const folders = await listAll(env, headers, '', pageSize);       // carpetas yyyy-mm-dd
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  let deleted = 0;
  for (const f of folders) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.name) || new Date(f.name + 'T00:00:00Z').getTime() >= cutoff) continue;
    const objs = await listAll(env, headers, f.name, pageSize);
    const names = objs.map((o) => `${f.name}/${o.name}`);
    if (!names.length) continue;
    const del = await fetch(`${env.url}/storage/v1/object/traces`, { method: 'DELETE', headers, body: JSON.stringify({ prefixes: names }) });
    if (!del.ok) throw new Error(`delete traces: HTTP ${del.status}`);
    deleted += names.length;
  }
  return deleted;
}
