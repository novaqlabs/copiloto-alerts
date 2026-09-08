# copiloto-alerts

Pipeline de datos abiertos de alertas oficiales de la DGT (radares fijos e incidencias) para
**Copiloto**, el navegador GPS nativo de Repostar. Se publicará como repositorio público
independiente (`dismagest/copiloto-alerts`) con GitHub Pages, siguiendo el mismo patrón que
[`repostar-data`](https://github.com/dismagest/repostar-data) para los precios de carburantes.

## Qué publica

- **Radares fijos y de tramo** (`src/radares.ts`): posiciones puntuales o secciones
  inicio/fin, carretera, sentido y velocidad si el feed la incluye.
- **Incidencias de tráfico** y **catálogo de tipos de reporte**: pendientes de las tareas 3 y 4
  de la fase C (no forman parte de este esqueleto).

Las capas se recortan en **celdas de un grado** (`src/cells.ts`, `cellOf`) sobre la caja que
cubre España peninsular, Baleares, Canarias y el entorno próximo (`CELL_BOUNDS`), para que
Copiloto solo descargue las celdas cercanas a la ruta en curso.

## Fuente y licencia

Los datos proceden del **NAP (National Access Point) de la DGT**, en formato DATEX II 1.0
(`https://nap.dgt.es/`). Se reutilizan citando la fuente («Dirección General de Tráfico») y
conforme al [aviso legal de la DGT](https://www.dgt.es/contenido/aviso-legal/).

## Desarrollo

```bash
npm install
npm test              # vitest: celdas y parser de radares fijos, contra un fixture real
npx tsc --noEmit       # comprobación de tipos, sin build (Node ejecuta TypeScript directo)
```

Requiere Node ≥ 24 (ejecuta TypeScript con *type stripping*, sin paso de compilación).
Única dependencia: `fast-xml-parser`.

`fixtures/radares.xml` es una descarga real del feed de radares del NAP, usada para validar el
parser contra la estructura real de la DGT (no un ejemplo simplificado).
