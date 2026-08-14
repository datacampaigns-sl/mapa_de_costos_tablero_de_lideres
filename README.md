# SuperLikers — Dashboard Financiero de Costos y Rentabilidad

Repositorio con las dos versiones del dashboard (tablero de líderes y mapa de costos completo) más el ETL que alimenta a ambas desde Google Sheets/Jira hacia Google Drive. Pensado para trabajarse desde GitHub y desplegarse en Netlify **por Git**, en vez de arrastrar archivos manualmente (Netlify Drop) — así se evita el problema recurrente de que la carpeta `netlify/functions/` quede fuera del despliegue por accidente.

## Estructura del repositorio

```
.
├── etl/
│   └── etl-finops-v2.gs        # Apps Script: lee Google Sheets/Jira, escribe dashboard_data.json en Drive
├── tablero-lideres/             # Dashboard reducido (3 módulos: Consolidada, Capacidad, y base)
│   ├── index.html
│   ├── netlify.toml
│   └── netlify/functions/finops-data.js
└── mapa-costos/                 # Dashboard completo (12 módulos, incluye Asistente IA)
    ├── index.html
    ├── netlify.toml
    └── netlify/functions/
        ├── finops-data.js
        └── finops-ia.js
```

Cada dashboard (`tablero-lideres/` y `mapa-costos/`) es un sitio de Netlify independiente dentro del mismo repositorio ("monorepo"). El ETL (`etl/`) no se despliega en ningún lado — vive en este repo solo para tener historial de versiones y control de cambios; el archivo real que corre se pega manualmente en Google Apps Script.

## Por qué dos carpetas y no un solo dashboard

`tablero-lideres` y `mapa-costos` comparten la misma arquitectura de datos y el mismo mecanismo de cruce de filtros, pero `mapa-costos` incluye 9 módulos adicionales (Home, Radar, Egresos, Nómina, Valor Hora, Programas, Áreas, Compromiso, Tablero de KPIs, Asistente IA) que `tablero-lideres` no tiene. Son archivos independientes, no una rama del otro — **cualquier cambio a la lógica compartida (cruce de filtros, cálculos de capacidad, etc.) debe aplicarse manualmente en ambos `index.html`** hasta que se decida consolidar en un solo dashboard parametrizable. Este es un riesgo de mantenimiento conocido, documentado en el proyecto (`decisiones-arquitectura.md`, D-007).

## Cómo conectar cada dashboard a Netlify (por Git)

Para cada carpeta (`tablero-lideres/` y `mapa-costos/`) se crea un sitio de Netlify separado apuntando al mismo repositorio, usando el **directorio base** para que cada sitio solo vea su propia carpeta:

1. En Netlify: **Add new site → Import an existing project** → conecta este repositorio de GitHub.
2. En la configuración de build de ese sitio:
   - **Base directory:** `tablero-lideres` (o `mapa-costos` para el otro sitio).
   - **Publish directory:** `.` (relativo al base directory, ya que `netlify.toml` de cada carpeta ya lo define así).
   - **Functions directory:** se toma de `netlify.toml` (`netlify/functions`), no hace falta configurarlo aparte.
   - **Build command:** dejar vacío — no hay paso de build, son archivos estáticos.
3. Repite el proceso para el segundo dashboard, apuntando al mismo repo pero con el otro `Base directory`.
4. En cada sitio, ve a **Site settings → Environment variables** y agrega `DRIVE_FILE_ID` con el ID del archivo `dashboard_data.json` de Drive correspondiente (pueden ser el mismo ID si ambos dashboards leen el mismo archivo, o distintos si cada uno tiene su propio corte de datos).

Con despliegue por Git, cada `git push` a la rama conectada reconstruye el sitio automáticamente y **siempre incluye la carpeta `netlify/` completa** — se elimina la causa raíz del problema detectado en esta sesión (un despliegue por Drop que subió solo `index.html` sin la función, dejando `/.netlify/functions/finops-data` en 404 aunque todo lo demás — ETL, permisos de Drive, variable de entorno — estuviera correcto).

## Flujo de datos (resumen)

1. Google Sheets / Jira (fuentes publicadas) →
2. `etl/etl-finops-v2.gs` corrido manualmente (o programado) en Google Apps Script → genera `dashboard_data.json` y lo sube a una carpeta de Google Drive, compartido como "Cualquiera con el enlace · Lector" (paso agregado en la v2.2.3 del ETL — antes debía compartirse a mano) →
3. La función serverless `netlify/functions/finops-data.js` de cada sitio hace un `fetch` anónimo a ese archivo de Drive usando la variable de entorno `DRIVE_FILE_ID` →
4. `index.html` consulta `/api/data` (redirigido por `netlify.toml` a esa función) y renderiza los módulos. Si el fetch falla por cualquier razón, cae a un JSON de ejemplo embebido en el propio HTML y muestra el badge "⚠ Data local (no Drive)".

## Gobierno del proyecto

Este repositorio es el código; la documentación de decisiones, avances y control de cambios vive en el proyecto de Claude asociado ("Mapa de costos y tablero de control líderes"), no aquí — mantenerla ahí evita duplicar historial en dos lugares. Cualquier cambio hecho directamente sobre este repo (por ejemplo si empiezan a trabajar el código en GitHub en vez de por Claude) debería reflejarse también en `changelog.md` / `registro-avances.md` del proyecto para no perder trazabilidad.
