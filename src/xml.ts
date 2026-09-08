import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['predefinedLocation', 'situationRecord', 'situation', 'name', 'values', 'value'].includes(name),
});

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

/** Primer valor no vacío recorriendo rutas separadas por puntos; los arrays se aplanan por el primer elemento. */
export function pick(node: any, ...paths: string[]): any {
  for (const path of paths) {
    let cur = node;
    for (const key of path.split('.')) {
      if (cur == null) break;
      cur = Array.isArray(cur) ? cur[0]?.[key] : cur[key];
    }
    if (cur != null && cur !== '') return cur;
  }
  return undefined;
}

export const num = (v: any): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

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
