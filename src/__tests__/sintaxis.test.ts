import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node ejecuta este pipeline en modo «strip-only» (`node src/cli.ts`): solo BORRA los tipos, no
 * transpila. La azucar sintactica de TypeScript que genera codigo -«parameter properties» en el
 * constructor, `enum`, `namespace`- aborta el arranque con ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX...
 * pero vitest SI transpila, asi que los tests pasan igual y el fallo solo sale en produccion.
 * Paso de verdad en la fase D (`class StorageError { constructor(msg: string, readonly status:
 * number) }`), y habria dejado las capas de la DGT sin publicar hasta que alguien mirase Actions.
 */
describe('sintaxis compatible con el modo strip-only de Node', () => {
  const dir = new URL('../', import.meta.url);
  const ficheros = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('hay ficheros que revisar', () => {
    expect(ficheros.length).toBeGreaterThan(5);
  });

  for (const f of ficheros) {
    it(`${f} no usa sintaxis que Node no sepa borrar`, () => {
      const src = readFileSync(new URL(f, dir), 'utf8');
      // constructor(..., readonly x: T) / private|public|protected
      expect(src, 'parameter property en un constructor').not.toMatch(
        /constructor\s*\([^)]*\b(readonly|private|public|protected)\s+\w/s,
      );
      expect(src, 'enum').not.toMatch(/^\s*(export\s+)?(const\s+)?enum\s+\w/m);
      expect(src, 'namespace').not.toMatch(/^\s*(export\s+)?namespace\s+\w/m);
    });
  }
});
