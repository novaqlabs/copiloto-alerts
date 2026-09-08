/** Solo se ejecuta en GitHub Actions con la clave secreta como secreto del repo. Nunca en la app. */
export interface SupabaseEnv { url: string; secretKey: string }

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

export async function cleanupTraces(env: SupabaseEnv, now: Date, maxAgeDays = 30): Promise<number> {
  const headers = { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${env.url}/storage/v1/object/list/traces`, { method: 'POST', headers, body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'created_at', order: 'asc' } }) });
  if (!list.ok) throw new Error(`list traces: HTTP ${list.status}`);
  const folders = (await list.json()) as { name: string }[];       // carpetas yyyy-mm-dd
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  let deleted = 0;
  for (const f of folders) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.name) || new Date(f.name + 'T00:00:00Z').getTime() >= cutoff) continue;
    const objs = await fetch(`${env.url}/storage/v1/object/list/traces`, { method: 'POST', headers, body: JSON.stringify({ prefix: f.name, limit: 1000 }) });
    const names = ((await objs.json()) as { name: string }[]).map((o) => `${f.name}/${o.name}`);
    if (!names.length) continue;
    const del = await fetch(`${env.url}/storage/v1/object/traces`, { method: 'DELETE', headers, body: JSON.stringify({ prefixes: names }) });
    if (!del.ok) throw new Error(`delete traces: HTTP ${del.status}`);
    deleted += names.length;
  }
  return deleted;
}
