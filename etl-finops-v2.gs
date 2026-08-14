/**
 * ============================================================================
 *  ETL FinOps v2 — SuperLikers / IWIN  ·  Google Apps Script
 *  Reglas validadas AL PESO contra Power BI (ene–abr 2026): 28/28 KPIs.
 * ----------------------------------------------------------------------------
 *  USO
 *   1. Pega TODO este archivo en un proyecto de Apps Script (V8 por defecto).
 *   2. Configura las URLs publicadas (Configuración ⚙ → Propiedades del script):
 *        URL_MAESTRO      → Maestro (BD_Nomina: Beneficiario/Área/…)
 *        URL_NOMINA       → Nómina General/Tarifario (formato ancho)
 *        URL_BCOS         → BcosHolding (saldos/movimientos)
 *        URL_JIRA         → Data Jira (worklog)
 *        URL_FACTURACION  → Facturación (VR CAUSADO EN PESOS)
 *        FOLDER_ID        → (opcional) carpeta Drive para el JSON
 *   3. Ejecuta `probarConexionFuentes` (autoriza permisos y valida accesos).
 *   4. Ejecuta `main` → genera dashboard_data.json en Drive.
 *   5. Ejecuta `crearActivadorDiario` para la corrida automática.
 *
 * ----------------------------------------------------------------------------
 *  CHANGELOG (ver /docs/changelog.md del proyecto para el detalle)
 *
 *  v2.1.0
 *   · NUEVO: `personas_detalle` — tabla plana período × persona × área ×
 *     programa × componente × facturable → horas. Antes solo existían
 *     `programas_detalle` (sin persona) y `personas_por_periodo` (totales
 *     por persona, sin programa/componente). Sin este cruce era imposible
 *     ver "quién gastó tiempo No Facturable, en qué programa y con qué
 *     componente" — el bloque "Horas No Facturables · por persona" del
 *     dashboard de líderes dependía de datos que el ETL nunca generó.
 *   · Se reutiliza el mismo recorrido de `procesarJiraDetalle` (una sola
 *     pasada sobre el CSV de Jira) para no duplicar costo de procesamiento.
 *   · Por tamaño de payload, `personas_detalle` solo se genera desde
 *     `PERSONAS_DETALLE_DESDE` (configurable) — los líderes solo necesitan
 *     drill-down de los meses recientes, no del histórico completo 2019+.
 *
 *  v2.2.0
 *   · NUEVO: `componentes_estimado` — período-ventana × área × componente →
 *     {horas, horas_estimadas, tickets}. Alimenta "Estimado vs ejecutado" y
 *     "Promedio de horas por ticket" en el módulo Capacidad, que hoy están
 *     vacíos (dependen de un arreglo mock `CAP_COMPONENTES` nunca poblado).
 *   · NUEVO: `tickets_top` — top N tickets por horas trabajadas, agrupado
 *     por área (clave, persona, programa, componente, horas, estimado,
 *     resumen). Alimenta "Top tickets por volumen de horas", hoy poblado
 *     por un arreglo mock `CAP_TICKETS` vacío.
 *   · Ambos se calculan a partir de un mapa por ticket (clave Jira) para
 *     NO inflar "horas estimadas": ese campo es una propiedad del ticket,
 *     no del worklog — sumarlo por cada fila de trabajo lo multiplicaría
 *     por la cantidad de veces que alguien registró tiempo en ese ticket.
 *   · Requiere verificar los nombres exactos de columnas de Jira para
 *     Clave / Resumen / Tiempo Estimado — no se usaban antes en el ETL, así
 *     que se agregó `verificarColumnasJira()` para confirmarlos contra la
 *     hoja real antes de confiar en `componentes_estimado`/`tickets_top`.
 *
 *  v2.2.1
 *   · FIX: `verificarColumnasJira()` corrido contra datos reales (2026-08-04)
 *     confirmó Clave/Resumen tal como se supuso, pero NINGUNA de las 5
 *     variantes supuestas para "Tiempo Estimado" existía en la hoja real —
 *     la columna real se llama "Estimación original". Se agregó ese nombre
 *     exacto como primer candidato en `col(...)` (tanto en el punto donde se
 *     lee dentro de `procesarJiraDetalle` como en `verificarColumnasJira()`),
 *     dejando las 5 variantes anteriores como respaldo. Sin este fix,
 *     `componentes_estimado.horas_estimadas` y `tickets_top[].estimado`
 *     quedaban siempre en `null` — no es que faltaran datos, es que se leía
 *     una columna que no existe con ese nombre.
 *   · No cambia el conteo de filas ni la agrupación de `componentes_estimado`
 *     / `tickets_top` (esos ya eran correctos, calculados desde `horas`
 *     "Tiempo Trabajado" que sí matcheaba) — solo rellena el campo de
 *     estimado que antes quedaba vacío.
 *   · Pendiente de validar: "Estimación original" se asume en segundos
 *     (mismo formato que "Tiempo Trabajado" en este mismo export), por eso
 *     se reusa `segAHoras()`. Falta un spot-check: comparar el valor de
 *     `estimado` de un ticket conocido en el dashboard contra lo que muestra
 *     la interfaz de Jira para ese mismo ticket, antes de confiar en el dato
 *     para decisiones (ver "Pruebas y validación financiera" del gobierno
 *     del proyecto).
 *
 *  v2.2.2
 *   · FIX: revisando datos reales (dashboard_data.json, 2026-08-04) se
 *     encontraron 7 pares de nombres que son la misma persona escrita
 *     distinto en Jira (ej. "Edwin Cano" / "Edwin Alexander Cano Castillo",
 *     área Analytics) — sus horas quedaban fragmentadas en `personas_detalle`
 *     / `personas_por_periodo` / `tickets_top`, haciendo parecer que una
 *     persona trabajó menos de lo real. El ÁREA de estas personas ya se
 *     calculaba bien (vía Maestro, índice independiente) — el problema era
 *     solo de identidad/nombre en las vistas por persona.
 *   · NUEVO: `normalizarPersona()` — normaliza el nombre ANTES de usarlo como
 *     llave de identidad, en dos capas: (1) coincidencia EXACTA contra
 *     Usuarios_Jira (aprovecha variantes que esa hoja ya registra), (2) lista
 *     explícita `ALIAS_PERSONAS` para las variantes que Usuarios_Jira no
 *     tiene. Deliberadamente NO usa fuzzy-matching (arriesgaría fusionar mal
 *     a dos personas reales distintas, ej. dos "María Isabel" que sí podrían
 *     ser personas diferentes) — cada alias fue confirmado manualmente con
 *     el usuario antes de agregarse.
 *   · NUEVO: `verificarAliasPersonas()` — diagnóstico que detecta candidatos
 *     de pares no resueltos todavía, para revisión humana futura (no fusiona
 *     nada automáticamente).
 *   · `_meta.version` pasa de `2.2.1` a `2.2.2`.
 *
 *  v2.2.3
 *   · FIX: el dashboard mostraba "Data local (no Drive)" pese a que `main()`
 *     corría OK y `DRIVE_FILE_ID` estaba bien configurado en Netlify (mismo
 *     ID en las 5 categorías de deploy). Causa real: `_guardarJSON()` nunca
 *     dejaba el archivo de Drive compartido como "Cualquiera con el enlace" —
 *     por defecto un archivo creado por Apps Script es privado al dueño del
 *     script. `finops-data.js` (Netlify) hace un fetch SIN autenticación
 *     (`uc?export=download&id=...`); contra un archivo privado, Drive
 *     responde con una página HTML de login/permiso en vez del JSON, y la
 *     función lo detecta como "la respuesta no es JSON" — el frontend cae al
 *     JSON embebido de respaldo y muestra el aviso.
 *   · FIX: `_guardarJSON()` ahora llama `archivo.setSharing(DriveApp.Access.
 *     ANYONE_WITH_LINK, DriveApp.Permission.VIEW)` cada vez que escribe el
 *     archivo — así main() garantiza el permiso correcto en cada corrida,
 *     sin depender de que alguien lo configure a mano una sola vez (y que
 *     sobreviva si el archivo se llega a recrear).
 *   · `_meta.version` pasa de `2.2.2` a `2.2.3`.
 * ============================================================================
 */
'use strict';

// ============================================================================
//  URLs DE FUENTES (modo pruebas: pegadas directo en el código)
//  Deben ser links "Publicar en la web → CSV" (terminan en output=csv).
//  Si dejas alguna vacía, se usa la Propiedad del script del mismo nombre.
// ============================================================================
var URLS = {
  URL_MAESTRO:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vTcaBGx6FSqKUj4HAJW34JiH5a9qKWv-px5I_fze-pg0bnDL_pc41zea-rb5_kpPOPyCZmBnB8mQThB/pub?gid=0&single=true&output=csv',
  URL_NOMINA:      'https://docs.google.com/spreadsheets/d/e/2PACX-1vT6eIN89VH-v66CjABBbq10GW5HnK2wUM6AisCfEPjE_j4yqZ1uWBTIJFLIkJ89np5rnC7P4BIxvOZA/pub?gid=898320746&single=true&output=csv',
  URL_BCOS:        'https://docs.google.com/spreadsheets/d/e/2PACX-1vRDEF48fsafK99GcA7ecqeE9skg2jIzvwXP2UlV5gTYKyOXEQz904SwvcJU9gCbxk1Jb1s2JOg1MtuB/pub?gid=3&single=true&output=csv',
  URL_JIRA:        'https://docs.google.com/spreadsheets/d/e/2PACX-1vQKBp22igRsLtGUk3dz8MqUndTpedJunmx9lH-HvPqQ_aCfi1akwSDqUFxehavN6fpYqs8Gl4NmPRv4/pub?gid=0&single=true&output=csv',
  // ⚠ CORREGIR: esta venía como pubhtml (HTML). Cambiada a output=csv (verifica el gid).
  URL_FACTURACION: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ527pYRibKeZQOUa6mHVxPTkGWid5E4wjC8qxWKnpTgYXBWZO4qtp8vnbYxXASGZWg4rTCjknqi2ov/pub?gid=1026525297&single=true&output=csv',
  URL_USUARIOS:    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0P-Bdfozfm1H05uNcmIeA1Uln67iok6yWX_IiekXKyv1XlNpWOOU-BizqeV2s7xvjFS1q0IPgz2oU/pub?gid=1379626832&single=true&output=csv',
  // Matriz de horas PPTO 2026 (Programa, Área, PPTO mensual)
  URL_HORAS_PPTO:  'https://docs.google.com/spreadsheets/d/e/2PACX-1vS-snSULbSu8Nl-or39fr-8dqlmIf_gMMqNSCFt2I02aN4gb5l-BDDfhk3_-ppzk7vq4ALOQAH8_evh/pub?gid=1324137378&single=true&output=csv',
  FOLDER_ID:       ''   // opcional: ID de carpeta de Drive para el JSON
};

/** URLs efectivas: usa el bloque URLS y, si falta, cae a Propiedades del script. */
function _cfgURLS(){
  var P = PropertiesService.getScriptProperties().getProperties();
  var out = {};
  ['URL_MAESTRO','URL_NOMINA','URL_BCOS','URL_JIRA','URL_FACTURACION','URL_USUARIOS','URL_HORAS_PPTO','FOLDER_ID']
    .forEach(function(k){ out[k] = (URLS[k] && String(URLS[k]).trim()) || P[k] || ''; });
  return out;
}

/**
 * ============================================================================
 *  FinOps CORE — Lógica pura del ETL (SuperLikers / IWIN)
 *  Agnóstico de entorno: NO usa fetch, require, DriveApp ni módulos.
 *  Se prueba en Node y se reutiliza tal cual dentro del .gs de Apps Script.
 *  Reglas validadas al peso contra Power BI (ene–abr 2026).
 * ============================================================================
 */

// ── Configuración / constantes de negocio ───────────────────────────────────
var FINOPS_CONFIG = {
  FACTOR_PARAFISCALES: 1.4385,   // sobre Salario Devengado
  HORAS_POR_DIA: 7.5,
  // Clasificación MOD/MOI por Área del Maestro (SWITCH DAX del cliente)
  AREAS_MOD: ['ANALYTICS','CONTENIDOS','CREATIVIDAD','MICROSITIO','DESARROLLO',
              'DISENO','ENGAGEMENT MANAGER','ANALISTA ENGAGEMENT'],
  AREAS_MOI: ['GENERAL','ADMINISTRACION','GERENCIA','VENTAS'],

  // Egresos (card "Total Costos y Gastos"): RUBRO excluidos
  RUBROS_EXCLUIDOS: ['CAPITAL','CESANTIAS CONSIGNADAS AL FONDO',
    'CESANTIAS CONSIGNADAS EMPLEADO','INGRESOS DEL EXTERIOR','INGRESOS NACIONALES',
    'LIBERACION DE CUPO','OTROS INGRESOS','PRIMA','SALARIOS','SEG SOCIAL',
    'TRANSFERENCIAS ENTRE CUENTAS','HORAS EXTRAS','VACACIONES'],
  // COSTO O GASTO excluido (el blank SÍ se incluye, como el card)
  COSTO_GASTO_EXCLUIDOS: ['OTROS INGRESOS'],

  // Festivos Colombia (YYYY-MM-DD) — para días hábiles → Tiempo Laboral
  FESTIVOS: [
    '2024-01-01','2024-01-08','2024-03-25','2024-03-28','2024-03-29','2024-05-01',
    '2024-05-13','2024-06-03','2024-06-10','2024-07-01','2024-07-20','2024-08-07',
    '2024-08-19','2024-10-14','2024-11-04','2024-11-11','2024-12-08','2024-12-25',
    '2025-01-01','2025-01-06','2025-03-24','2025-04-17','2025-04-18','2025-05-01',
    '2025-06-02','2025-06-23','2025-06-30','2025-07-20','2025-08-07','2025-08-18',
    '2025-10-13','2025-11-03','2025-11-17','2025-12-08','2025-12-25',
    '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03','2026-05-01',
    '2026-05-18','2026-06-08','2026-06-15','2026-06-29','2026-07-20','2026-08-07',
    '2026-08-17','2026-10-12','2026-11-02','2026-11-16','2026-12-08','2026-12-25'
  ],

  // Columna canónica de ingresos (facturación)
  COL_INGRESO_FACT: 'VR CAUSADO EN PESOS',

  // NUEVO v2.1.0 — desde qué período se genera el drill-down persona×programa×
  // componente (personas_detalle). Controla el tamaño del JSON: los líderes
  // solo necesitan drill-down de meses recientes, no del histórico 2019+.
  // Ver decisiones-arquitectura.md → "Ventana de personas_detalle".
  // Reutilizada también por componentes_estimado / tickets_top (v2.2.0):
  // misma razón, misma ventana — un solo lugar para ajustarla.
  PERSONAS_DETALLE_DESDE: '2024-01',

  // NUEVO v2.2.0 — cuántos tickets como máximo se exponen por área en
  // `tickets_top`. Acota el payload: no se manda el universo completo de
  // tickets, solo los de mayor consumo de horas por área (ver D-002).
  TOP_TICKETS_POR_AREA: 25
};

// ── Utilidades de texto/número ───────────────────────────────────────────────
var _MAPA_ACENTOS = {'Á':'A','É':'E','Í':'I','Ó':'O','Ú':'U','Ü':'U','Ñ':'N',
  'á':'a','é':'e','í':'i','ó':'o','ú':'u','ü':'u','ñ':'n','Â':'A','Ê':'E','Î':'I',
  'Ô':'O','Û':'U','â':'a','ê':'e','î':'i','ô':'o','û':'u'};
var _RE_ACENTOS = /[ÁÉÍÓÚÜÑáéíóúüñÂÊÎÔÛâêîôû]/g;
function _sinAcento(c){ return _MAPA_ACENTOS[c] || c; }

/** Normaliza un nombre para cruces: MAYÚSCULAS, sin acentos, sin dobles espacios. */
function keyname(s){
  s = (s == null ? '' : String(s)).trim().toUpperCase();
  s = s.replace(_RE_ACENTOS, _sinAcento);
  return s.replace(/\s+/g, ' ');
}
/** Solo dígitos (cédulas: "1,013,598,142 " → "1013598142"). */
function limpiarCedula(v){ var d = (v == null ? '' : String(v)).replace(/[^\d]/g, ''); return d || null; }

/** Número formato US: comas de miles, punto decimal. "3,300,000" / "27,061,816.95". */
function numUS(v){
  if (v == null) return 0;
  var s = String(v).trim().replace(/"/g, '').replace(/\s/g, '');
  if (s === '' || s === '-') return 0;
  s = s.replace(/,/g, '');
  s = s.replace(/[^\d.\-]/g, '');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
/** Número formato europeo: puntos de miles, coma decimal. "11.828.755,69". */
function numEU(v){
  if (v == null) return 0;
  var s = String(v).trim().replace(/"/g, '');
  if (s === '' || s === '-') return 0;
  s = s.replace(/\./g, '').replace(/,/g, '.');
  s = s.replace(/[^\d.\-]/g, '');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ── Parser CSV robusto (comillas, comas internas, saltos escapados) ─────────
/** Devuelve array de arrays. Maneja campos entre comillas con comas/comillas dobles. */
function parseCSV(texto){
  var filas = [], campo = '', fila = [], enComillas = false;
  texto = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (var i = 0; i < texto.length; i++){
    var c = texto[i];
    if (enComillas){
      if (c === '"'){
        if (texto[i+1] === '"'){ campo += '"'; i++; }
        else enComillas = false;
      } else campo += c;
    } else {
      if (c === '"') enComillas = true;
      else if (c === ','){ fila.push(campo); campo = ''; }
      else if (c === '\n'){ fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else campo += c;
    }
  }
  if (campo !== '' || fila.length){ fila.push(campo); filas.push(fila); }
  return filas;
}
/** CSV → array de objetos usando la fila 0 como cabecera (con trim). */
function parseCSVObjetos(texto){
  var filas = parseCSV(texto);
  if (!filas.length) return [];
  var hdr = filas[0].map(function(h){ return String(h).trim(); });
  var out = [];
  for (var i = 1; i < filas.length; i++){
    var f = filas[i];
    if (!f.some(function(c){ return String(c).trim() !== ''; })) continue;
    var o = {};
    for (var j = 0; j < hdr.length; j++) o[hdr[j]] = f[j] != null ? f[j] : '';
    out.push(o);
  }
  return out;
}
/** Lee una columna probando varios nombres alternativos (trailing spaces, acentos). */
function col(obj, nombres){
  for (var i = 0; i < nombres.length; i++){
    if (obj[nombres[i]] !== undefined) return obj[nombres[i]];
  }
  return '';
}

// ── Calendario: días hábiles y Tiempo Laboral ───────────────────────────────
function _esFestivo(cfg, yyyy_mm_dd){ return cfg.FESTIVOS.indexOf(yyyy_mm_dd) >= 0; }
/** Días hábiles (L-V, sin festivos) del período YYYY-MM. */
function diasHabiles(cfg, periodo){
  var p = periodo.split('-'), y = parseInt(p[0],10), m = parseInt(p[1],10);
  var dias = new Date(y, m, 0).getDate(), n = 0;
  for (var d = 1; d <= dias; d++){
    var dt = new Date(y, m-1, d), dow = dt.getDay();
    if (dow === 0 || dow === 6) continue;
    var mm = (m<10?'0':'')+m, dd = (d<10?'0':'')+d;
    if (_esFestivo(cfg, y+'-'+mm+'-'+dd)) continue;
    n++;
  }
  return n;
}
function tiempoLaboral(cfg, periodo){ return diasHabiles(cfg, periodo) * cfg.HORAS_POR_DIA; }

// ── Clasificación MOD/MOI desde el Maestro ──────────────────────────────────
function clasificarArea(cfg, area){
  var a = keyname(area);
  if (cfg.AREAS_MOD.indexOf(a) >= 0) return 'MOD';
  if (cfg.AREAS_MOI.indexOf(a) >= 0) return 'MOI';
  return 'OTRO';
}
/**
 * Construye el mapa nombre→{area,tipo,estado} desde el Maestro (BD_Nomina).
 * Cruce por nombre (Beneficiario y Nombre Ajustado) porque el UID es #N/A.
 */
function construirMaestro(cfg, maestroCSV){
  var filas = parseCSVObjetos(maestroCSV), mapa = {};
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var area = String(col(r, ['Área','Area'])).trim();
    var tipo = clasificarArea(cfg, area);
    var estado = String(col(r, ['Estado','Estado del empleado'])).trim().toLowerCase();
    var nombres = [r['Beneficiario'], r['Nombre Ajustado']];
    for (var j = 0; j < nombres.length; j++){
      var k = keyname(nombres[j]);
      if (k) mapa[k] = { area: area, tipo: tipo, estado: estado };
    }
  }
  return mapa;
}

// ── NÓMINA (formato ancho) ───────────────────────────────────────────────────
/** costo cargado = Salario Devengado × 1.4385 + Servicio Devengado. */
function costoColaborador(cfg, fila){
  return numUS(col(fila,['Salario Devengado'])) * cfg.FACTOR_PARAFISCALES
       + numUS(col(fila,['Servicio Devengado']));
}
/**
 * Procesa la nómina y agrega por período: MOD, MOI, por área, y nº colaboradores MOD.
 * @returns Map periodo → {mod, moi, otro, por_area:{}, colab_mod:Set, colab_todos:Set}
 */
// Normaliza el tipo de contrato de la nómina a etiquetas limpias
function _normContrato(c){
  var s = keyname(c);
  if (s.indexOf('LABORAL/SERV') >= 0 || (s.indexOf('LABORAL')>=0 && s.indexOf('SERV')>=0)) return 'Laboral/Servicios';
  if (s === 'LABORAL') return 'Laboral';
  if (s.indexOf('APRENDIZ') >= 0) return 'Aprendizaje';
  if (s.indexOf('SERV') >= 0) return 'Servicios';
  return c ? String(c).trim() : 'SIN CONTRATO';
}

function procesarNomina(cfg, nominaCSV, maestro){
  var filas = parseCSVObjetos(nominaCSV);
  var porPeriodo = {};
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var anio = String(col(r,['AÑO','ANO','ANIO'])).trim();
    var mes  = String(col(r,['MES'])).trim();
    if (!anio || !mes) continue;
    var periodo = anio + '-' + (mes.length < 2 ? '0'+mes : mes);
    var nombre = keyname(col(r,['COLABORADOR']));
    var info = maestro[nombre];
    var tipo = info ? info.tipo : 'OTRO';
    var costo = costoColaborador(cfg, r);
    var salario = numUS(col(r,['Salario Devengado']));
    var servicio = numUS(col(r,['Servicio Devengado']));
    var contrato = _normContrato(col(r,['TIPO DE CONTRATO']));

    if (!porPeriodo[periodo]) porPeriodo[periodo] = {
      mod:0, moi:0, otro:0, por_area:{}, colab_mod:{}, colab_todos:{}, detalle_nom:{}, area_mo:{}
    };
    var P = porPeriodo[periodo];
    if (tipo === 'MOD') P.mod += costo;
    else if (tipo === 'MOI') P.moi += costo;
    else P.otro += costo;

    // Desglose por área granular del Maestro (para vista de nómina)
    var areaG = info ? info.area : (String(col(r,['AREA'])).trim() || 'SIN ÁREA');
    P.por_area[areaG] = (P.por_area[areaG] || 0) + costo;

    // Valor por área: costo MOD/MOI y colaboradores del área (para valor hora por área)
    if (!P.area_mo[areaG]) P.area_mo[areaG] = { mod:0, moi:0, colab:{} };
    if (tipo === 'MOD') P.area_mo[areaG].mod += costo;
    else if (tipo === 'MOI') P.area_mo[areaG].moi += costo;
    if (nombre) P.area_mo[areaG].colab[nombre] = true;

    // Detalle de nómina para filtros: área × mano de obra × contrato
    var key = areaG + '||' + tipo + '||' + contrato;
    if (!P.detalle_nom[key]) P.detalle_nom[key] = { sal:0, srv:0, costo:0 };
    P.detalle_nom[key].sal += salario;
    P.detalle_nom[key].srv += servicio;
    P.detalle_nom[key].costo += costo;

    if (nombre) {
      P.colab_todos[nombre] = true;
      if (tipo === 'MOD') P.colab_mod[nombre] = true;
    }
  }
  return porPeriodo;
}

// ── EGRESOS (BcosHolding) ────────────────────────────────────────────────────
/**
 * Regla card "Total Costos y Gastos":
 *   suma EGRESOS COP donde COSTO O GASTO ≠ "OTROS INGRESOS"
 *   y RUBRO no en RUBROS_EXCLUIDOS. (blank en COSTO O GASTO SÍ se incluye)
 * Período = AÑO + MM.
 * @returns Map periodo → {total, por_rubro:{}, por_categoria:{}}
 */
// Movimientos que NO son egresos reales (se excluyen de "Todos los egresos")
var EG_NO_REAL_RUBRO = ['TRANSFERENCIAS ENTRE CUENTAS','LIBERACION DE CUPO','INGRESOS DEL EXTERIOR','INGRESOS NACIONALES','OTROS INGRESOS'];
var EG_NO_REAL_TIPO  = ['TRANSFERENCIA ENTRE CTAS','OTROS INGRESOS','INGRESOS CLIENTES'];

function procesarEgresos(cfg, bcosCSV){
  var filas = parseCSVObjetos(bcosCSV);
  var porPeriodo = {};
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var anio = String(col(r,['AÑO','ANO'])).trim();
    var mm   = String(col(r,['MM','MES'])).trim();
    if (!anio || !mm) continue;
    var periodo = anio + '-' + (mm.length < 2 ? '0'+mm : mm);

    var val = numEU(col(r,['EGRESOS COP']));
    if (!val) continue;

    var cgRaw = String(col(r,['COSTO O GASTO','COSTO O GASTO '])).trim();
    var cg = cgRaw.toUpperCase();
    var rubro = String(col(r,['RUBRO'])).trim();
    var rubroU = rubro.toUpperCase();
    var ck = String(col(r,['CATEGORIA'])).trim() || 'SIN CATEGORÍA';

    if (!porPeriodo[periodo]) porPeriodo[periodo] = {
      total:0, por_rubro:{}, por_categoria:{}, eg_total:0, detalle:{}
    };
    var P = porPeriodo[periodo];

    // (A) Costos y Gastos VALIDADO (filtro estricto) — overview/radar
    if (cfg.COSTO_GASTO_EXCLUIDOS.indexOf(cg) < 0 && cfg.RUBROS_EXCLUIDOS.indexOf(rubroU) < 0){
      P.total += val;
      var rk = rubro || 'SIN RUBRO';
      P.por_rubro[rk] = (P.por_rubro[rk] || 0) + val;
      P.por_categoria[ck] = (P.por_categoria[ck] || 0) + val;
    }

    // (B) TODOS los egresos (excluye solo no-egresos) — tabla de detalle para filtros
    if (EG_NO_REAL_TIPO.indexOf(cg) < 0 && EG_NO_REAL_RUBRO.indexOf(rubroU) < 0){
      var emp = String(col(r,['EMPRESA'])).trim() || 'SIN EMPRESA';
      var ben = String(col(r,['BENEFICIARIO','BENEFICIARIO '])).trim() || 'SIN BENEFICIARIO';
      var tipo = cgRaw || 'SIN TIPO';
      var rk2 = rubro || 'SIN RUBRO';
      var prog = String(col(r,['PROGRAMA'])).trim() || 'SIN PROGRAMA';
      P.eg_total += val;
      var key = emp + '||' + ben + '||' + rk2 + '||' + tipo + '||' + ck + '||' + prog;
      P.detalle[key] = (P.detalle[key] || 0) + val;
    }
  }
  return porPeriodo;
}

// ── FACTURACIÓN (ingresos) ───────────────────────────────────────────────────
/**
 * Ingresos por período y por programa, usando VR CAUSADO EN PESOS (formato US).
 * Período = AÑO + Mes.  (Pendiente de validar contra una cifra meta de ingresos.)
 * @returns Map periodo → {total, por_programa:{}}
 */
/**
 * Parsea CSV desenvolviendo filas que vinieron como un único campo entrecomillado
 * (fila entera envuelta con escape ""). Trabaja a nivel de fila para respetar
 * saltos de línea dentro de campos. Devuelve array de objetos.
 */
function parseCSVObjetosFlex(texto){
  var raw = parseCSV(texto);
  if (!raw.length) return [];
  var filas = [];
  for (var i = 0; i < raw.length; i++){
    var f = raw[i];
    if (f.length === 1 && String(f[0]).indexOf(',') >= 0){
      var re = parseCSV(String(f[0]));        // re-parsear la fila desenvuelta
      filas.push(re.length ? re[0] : f);
    } else {
      filas.push(f);
    }
  }
  var hdr = filas[0].map(function(h){ return String(h).trim(); });
  var out = [];
  for (var j = 1; j < filas.length; j++){
    var fr = filas[j];
    if (!fr.some(function(c){ return String(c).trim() !== ''; })) continue;
    var o = {};
    for (var k = 0; k < hdr.length; k++) o[hdr[k]] = fr[k] != null ? fr[k] : '';
    out.push(o);
  }
  return out;
}

function procesarFacturacion(cfg, facturacionCSV){
  var filas = parseCSVObjetosFlex(facturacionCSV);
  var porPeriodo = {};
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var anio = String(col(r,['AÑO','ANO'])).trim();
    var mes  = String(col(r,['Mes','MES'])).trim();
    if (!anio || !mes) continue;
    if (!/^\d+$/.test(mes)) continue;            // "Mes" numérico
    var periodo = anio + '-' + (mes.length < 2 ? '0'+mes : mes);

    var val = numUS(col(r,[cfg.COL_INGRESO_FACT]));
    if (!val) continue;
    var prog = String(col(r,['PROGRAMA'])).trim() || 'SIN PROGRAMA';

    if (!porPeriodo[periodo]) porPeriodo[periodo] = { total:0, por_programa:{} };
    porPeriodo[periodo].total += val;
    porPeriodo[periodo].por_programa[prog] = (porPeriodo[periodo].por_programa[prog] || 0) + val;
  }
  return porPeriodo;
}

// ── JIRA (horas por programa) ────────────────────────────────────────────────
/** Convierte "Tiempo Trabajado" (segundos) a horas. */
function segAHoras(v){ var n = numUS(v); return n > 0 ? n / 3600 : 0; }
/** Extrae período YYYY-MM de una fecha "M/D/YYYY hh:mm:ss" o "M/D/YYYY". */
function periodoDeFecha(fecha){
  var s = String(fecha || '').trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  var mm = m[1].length<2 ? '0'+m[1] : m[1];
  return m[3] + '-' + mm;
}
/**
 * Horas Jira por período y por programa. Fecha calendario = Fecha de Entrega si existe,
 * si no Creada (precedente DAX del cliente).
 * @returns Map periodo → {horas_total, por_programa:{}}
 */
function procesarJira(cfg, jiraCSV){
  var filas = parseCSVObjetos(jiraCSV);
  var porPeriodo = {};
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var horas = segAHoras(col(r,['Tiempo Trabajado','tiempo_trabajado']));
    if (!horas) continue;
    var periodo = periodoDeFecha(col(r,['Fecha de Entrega'])) || periodoDeFecha(col(r,['Creada']));
    if (!periodo) continue;
    var prog = String(col(r,['Programa'])).trim() || 'SIN PROGRAMA';
    if (!porPeriodo[periodo]) porPeriodo[periodo] = { horas_total:0, por_programa:{} };
    porPeriodo[periodo].horas_total += horas;
    porPeriodo[periodo].por_programa[prog] = (porPeriodo[periodo].por_programa[prog] || 0) + horas;
  }
  return porPeriodo;
}

// Mapa Usuarios_Jira incrustado (respaldo cuando URL_USUARIOS esta vacia). 117 personas.
var USUARIOS_CSV_EMBED = `Nombre como registra en Jira,Persona asignada,Área,Tipo de Contrato,Lider Luisa Fernanda Parra Ruiz,Luisa Fernanda Parra Ruiz,Administración,Prestacion de Servicio,Subordinado yoly maritza,Yoly Maritza Mahecha Murcia,Administración,Prestacion de Servicio,Subordinado Andrea Catherine Abril Coronado,Andrea Catherine Abril Coronado,Administración,Prestacion de Servicio,Subordinado Angela Ruth Guerrero S,Angela Ruth Guerrero Sánchez,Administración,indefinido,Líder Diana Lucia Del Castillo,Diana Lucia Del Castillo,Administración,indefinido,Subordinado Horacio Coneo,Horacio Coneo,Administración,Prestacion de Servicio,Subordinado Lucas Manuel Chica,Lucas Manuel Chica,Administración,indefinido,Subordinado María Isabel Escorcia Saltarín,Maria Escorcia,Administración,Prestacion de Servicio,Subordinado maryoly alexandra chavez cuburuco,Maryoly Alexandra Chavez Cuburuco,Administración,Prestacion de Servicio,Subordinado Sebastián Ospina Velásquez,Sebastián Ospina Velásquez,Administración,Prestacion de Servicio,Subordinado yudy marcela mora benitez,Yudy Marcela Mora Benitez,Administración,indefinido,Subordinado Maria Isabel Bolaños Amado,Maria Isabel Bolaños Amado,Administración,Prestacion de Servicio,Líder Santiago Rodriguez Loaiza,Santiago Rodríguez Loaiza,Administración,Prestacion de Servicio,Líder Angie Locarno,Angie Locarno,Analytics,Prestacion de Servicio,Subordinado Daniel Botero,Daniel Botero,Analytics,Prestacion de Servicio, Gabriel M. Galindo España,Gabriel M. Galindo España,Analytics,indefinido,Subordinado Wendy Quiñonez Rodriguez,Wendy Quiñonez Rodriguez,Analytics,Prestacion de Servicio,Subordinado Edwin Alexander Cano Castillo,Edwin Alexander Cano Castillo,Analytics,indefinido,Líder Heiner Stiven Parra Martínez,Heiner Stiven Parra Martinez,Analytics,indefinido,Subordinado Angelica Chaguendo,Angelica Maria Chaguendo Fernandez,Contenidos,Prestacion de Servicio,Subordinado Angie hernandez cano,Angie Yurley Hernandez Cano,Contenidos,indefinido,Subordinado Daniela Segrera,Daniela Segrera Trujillo,Contenidos,indefinido,Líder Jose Castro del Portillo,Jose Castro del Portillo,Contenidos,Prestacion de Servicio, Virginia Uzcátegui,Virginia Uzcátegui,Contenidos,Indefinido, Miguel Herrera Roa,Miguel Antonio Herrera Roa,Contenidos,Prestacion de Servicio,Subordinado Ana Maria Ruiz,Ana Maria Ruiz Morantes,Creatividad,Prestacion de Servicio,Subordinado Andres Hernández,Andres Hernández,Creatividad,Freelance,Subordinado Jessica Montaño,Jessica Montaño Dueñas,Creatividad,Prestacion de Servicio,Subordinado Andrea Serna Hernández,Andrea Serna Hernández,Creatividad,Prestacion de Servicio,Subordinado BibiGonzalez,Bibiana Marcela González Rocha,Creatividad,Prestacion de Servicio,Líder katherine Cortes,katherine Cortes,Creatividad,indefinido, Laura Londoño Mejía,Laura Londoño Mejía,Creatividad,Prestacion de Servicio, Laura Mejía Moreno,Laura Mejía Moreno,Creatividad,Prestacion de Servicio, Ricardo Andrés Riaño Martínez,Ricardo Andrés Riaño Martínez,Creatividad,Prestacion de Servicio, Valentina Andrade,Valentina Andrade,Creatividad,Prestacion de Servicio,Subordinado Sarah Escobar Cadavid,Sarah Escobar Cadavid,Creatividad,Prestacion de Servicio,Subordinado Edgar Quintana,Edgar Andres Quintana Acevedo,Desarrollo,indefinido,Líder Andrés Hortua,Felix Andrés Hortua Ortiz,Desarrollo,indefinido,Subordinado JUAN SEBASTIAN MONTOYA,Juan Sebastian Montoya,Desarrollo,Prestacion de Servicio, Miguel Andres Buitrago Cruz,Miguel Andres Buitrago Cruz,Desarrollo,Prestacion de Servicio,Subordinado Ana Camila Villarraga Jiménez,Ana Camila Villarraga Jimenez,Diseño,indefinido,Subordinado Andrea Restrepo,Andrea Restrepo Gomez,Diseño,indefinido,Líder MIryan Cubides,Luz Miryan Cubides Garzón,Diseño,indefinido,Subordinado Stefany Molina,Stefany Molina,Diseño,indefinido,Subordinado Eri Yojana,Eri Yojana,Diseño,Prestacion de Servicio, Luis Carlos Hoyos Castro,Luis Carlos Hoyos Castro,Diseño,Prestacion de Servicio, Valeria Araque,Valeria Araque Pineda,Diseño,Prestacion de Servicio,Subordinado Carolina Suárez,Deisy Carolina Suarez Prada,Engagement,indefinido,Líder ,Lina Marcela Muriel,Engagement,,Subordinado Angélica Lucía Quintana Moreno,Angelica Lucia Quintana Moreno,Engagement,Prestacion de Servicio,Subordinado Kelly Johanna Quiñonez Rodriguez,Kelly Johanna Quiñonez Rodriguez,Engagement,Prestacion de Servicio,Subordinado Marina Vargas Caicedo,Laura Marina Vargas Caicedo,Engagement,Prestacion de Servicio,Subordinado Lizeth Gabriela Rodríguez Zárate,Lizeth Gabriela Rodríguez Zárate,Engagement,Prestacion de Servicio,Subordinado Paula Quintana,María Paula Quintana Moreno,Engagement,indefinido,Líder ,Lina Andrea Pastrana Talero,Engagement,Prestacion de Servicio,Subordinado Estefany Polo Rangel,Estefany Johana Polo Rangel,Engagement,Prestacion de Servicio,Subordinado Gabriela Toledo Rios,Gabriela Zoraida Toledo Rios,Engagement,Prestacion de Servicio,Subordinado Angela Cortes,Angela Cortes,Engagement,Prestacion de Servicio,Subordinado Francy Julieth Fajardo Cardenas,Francy Fajardo,Engagement,indefinido,Subordinado Maria Cecilia García,Maria Cecilia García,Engagement,indefinido,Subordinado Mirleidys Sarais Díaz Escudero,Mirleidys Díaz,Engagement,Prestacion de Servicio, Nathalia Avendaño urrutia,Nathalia Avendaño urrutia,Engagement,Prestacion de Servicio,Subordinado Nicolas Esteban Granados Lucuara,Nicolas Granados,Engagement,indefinido,Subordinado Pablo Rey Forero,Pablo Rey,Engagement,Prestacion de Servicio,Subordinado Paola Garcia Henriquez,Paola García,Engagement,Prestacion de Servicio,Subordinado Paula Daniela Cardona Avila,Paula Daniela Cardona Avila,Engagement,Prestacion de Servicio,Subordinado Johana-0505g,Leidy Johana Gallego Valencia,Engagement,indefinido,Subordinado Maria Camila Campo,Maria Camila Campo Castilla,Engagement,Prestacion de Servicio,Líder Maria Paula Patarroyo,María Paula Patarroyo Ramirez,Engagement,indefinido,Subordinado Luis Alberto Del Castillo,Luis Alberto Del Castillo Cadavid,Gerencia,indefinido,Líder Camilo José Redondo Cudriz,Camilo Jose Redondo Cudriz,Micrositio,Prestacion de Servicio,Subordinado Diego Andrés Ortiz Gamboa,Diego Andrés Ortiz Gamboa,Micrositio,indefinido,Subordinado Alejandro Alonso Hernandez,Jimmy Alejandro Alonso Hernandez,Micrositio,indefinido,Subordinado Julian clavijo,Julian Fernando Clavijo Zapata,Micrositio,indefinido,Líder Walter Fdo Bustos G,Walter Fernando Bustos Garces,Micrositio,indefinido,Subordinado Wilfrido,Wilfrido García Villa,Micrositio,Prestacion de Servicio,Subordinado Pedro Carmona Florez,Willington Pedro Carmona Flórez,Micrositio,Prestacion de Servicio,Subordinado Lina Maria Rivera,Lina Maria Rivera Paredes,Micrositio,Prestacion de Servicio,Subordinado Mateo Arenas,Mateo Arenas Arteaga,Micrositio,Prestacion de Servicio,Subordinado Victor Maximiliano Sanchez Ortiz,Victor Maximiliano Sanchez Ortiz,UX-UI,Prestacion de Servicio, Magalí Sol Fraga Burgos,Magalí Sol Fraga Burgos,People,Prestacion de Servicio,Líder Tatiana Estupiñan Duarte,Tatiana Estupiñan Duarte,Planeación y Estrategia,indefinido,Líder Mayra Alejandra Garcia G,Mayra Alejandra García Guarín,Producto,Prestacion de Servicio,Subordinado Sabrina Villa Mamotiuk,Sabrina Bárbara Villa Mamotiuk,Producto,Prestacion de Servicio,Lider Eduardo García Aranda,Eduardo Garcia Aranda Vergara,Ventas,Prestacion de Servicio,Lider María Alejandra Rocha,María Alejandra Rocha,Ventas,Prestacion de Servicio,Subordinado alejandrav,alejandrav,,prestacion de servicio, Alexander Uscategui,Alexander Uscategui,,prestacion de servicio, Angela Chaparro,Angela Chaparro,,Prestacion de Servicio, Ángela Zapata M.,Ángela Zapata M.,,Prestacion de Servicio, Antiguo usuario,Antiguo usuario,,Prestacion de Servicio, Cami Montañez,Cami Montañez,,Prestacion de Servicio, Camilo Salazar Ocampo,Camilo Salazar Ocampo,,Prestacion de Servicio, Dylan Saenz,Dylan Saenz,,Prestacion de Servicio, Edith Andrea Rincon Perez,Edith Andrea Rincon Perez,,Prestacion de Servicio, Freelance,Freelance,,Prestacion de Servicio, Isabella Aguiar,Isabella Aguiar,,Prestacion de Servicio,Subordinado Jean Chaverra,Jean Chaverra,,Aprendizaje, Jonathan Neuman Rueda,Jonatham Neuman,,Aprendizaje, Juan David Peñaranda,Juan David Peñaranda,,Prestacion de Servicio, Juan Sebastian Chavez Ramos,Juan Sebastian Chavez Ramos,,Prestacion de Servicio, Karen González Ramos,Karen González Ramos,,Prestacion de Servicio, María Fernanda Gómez Ruíz,María Fernanda Gómez Ruíz,,Prestacion de Servicio, Marie Claire Perez Charris,Marie Claire Perez Charris,,Prestacion de Servicio, Nathaly Gómez,Nathaly Gómez,,Prestacion de Servicio, Nicolas Andres Gutierrez,Nicolas Andres Gutierrez,,indefinido, Paola Alejandra Cano Poblete,Paola Alejandra Cano Poblete,,Prestacion de Servicio,Subordinado paulo vanegas,Paulo Vanegas,,Prestacion de Servicio, Santiago Vanegas Mejia,Santiago Vanegas Mejia,,Prestacion de Servicio, SuperPesos,SuperPesos,,Prestacion de Servicio, Maria Paula Patarroyo Ramirez,María Paula Patarroyo Ramirez,Engagement,indefinido,Subordinado Estefany Polo,Estefany Johana Polo Rangel,Engagement,Prestacion de Servicio,Subordinado ANGELICA LUCIA QUINTANA MORENO,Angelica Lucia Quintana Moreno,Engagement,Prestacion de Servicio,Subordinado Alejandro Alonso,Jimmy Alejandro Alonso Hernandez,Micrositio,indefinido,Subordinado Andrés Hortua Ortiz,Felix Andrés Hortua Ortiz,Desarrollo,indefinido,Subordinado Miguel Buitrago,Miguel Andres Buitrago Cruz,Desarrollo,Prestacion de Servicio,Subordinado Sarah Escobar,Sarah Escobar Cadavid,Creatividad,Prestacion de Servicio,Subordinado`;

// ── Mapa persona → área (Usuarios_Jira). Cruce por nombre completo y por nombre+primer apellido ──
function _primeros2(nombre){ var t=keyname(nombre).split(' '); var o=[]; for(var i=0;i<t.length;i++){ if(t[i]) o.push(t[i]); if(o.length===2) break; } return o.join(' '); }
function _expandirMa(s){ return String(s||'').replace(/\bMa\.\s+/gi,'MARIA ').replace(/\bMaría\b/gi,'MARIA'); }
function construirMapaPersonaArea(usuariosCSV, maestro){
  var filas = parseCSVObjetos(usuariosCSV), full = {}, f2 = {};
  // Indice del Maestro por primeros 2 tokens, con expansion Ma./María
  var maestroF2 = {};
  if (maestro) { for (var mk in maestro) { if (!maestro.hasOwnProperty(mk)) continue;
    var _tt = keyname(_expandirMa(mk)).split(' '); if (_tt.length>=2) { var kk = _tt[0]+' '+_tt[1]; if (!maestroF2[kk]) maestroF2[kk]=maestro[mk]; } } }
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var _areaJira = String(col(r,['Área','Area'])).trim() || 'SIN ÁREA';
    // Fuente de verdad: Maestro Nomina. Si la persona esta ahi, su area prevalece sobre la de Usuarios_Jira.
    var _nJ = [col(r,['Persona asignada']), col(r,['Nombre como registra en Jira'])];
    var _areaMaestro = null;
    for (var _z=0; _z<_nJ.length && !_areaMaestro; _z++){
      var _kk = keyname(_nJ[_z]); if (!_kk) continue;
      if (maestro && maestro[_kk]) _areaMaestro = maestro[_kk].area;
      if (!_areaMaestro){ var _kn2 = keyname(_expandirMa(_nJ[_z])); if (maestro && maestro[_kn2]) _areaMaestro = maestro[_kn2].area; }
      if (!_areaMaestro){ var _tt2 = keyname(_expandirMa(_nJ[_z])).split(' '); if (_tt2.length>=2){ var _kk2 = _tt2[0]+' '+_tt2[1]; if (maestroF2[_kk2]) _areaMaestro = maestroF2[_kk2].area; } }
    }
    var area = _areaMaestro || _areaJira;
    // nombreCanon: v2.2.2 — el nombre oficial de esta persona segun Usuarios_Jira
    // (columna "Persona asignada"), usado para normalizar la identidad en
    // personas_detalle/personas_por_periodo/tickets_top. Ver normalizarPersona().
    var _nombreCanon = String(col(r,['Persona asignada'])).trim() || String(col(r,['Nombre como registra en Jira'])).trim();
    var info = { area: area, contrato: String(col(r,['Tipo de Contrato'])).trim(), lider: String(col(r,['Lider'])).trim(), nombreCanon: _nombreCanon };
    var nombres = [col(r,['Persona asignada']), col(r,['Nombre como registra en Jira'])];
    for (var j = 0; j < nombres.length; j++){
      var k = keyname(nombres[j]); if (!k) continue;
      full[k] = info;
      var k2 = _primeros2(nombres[j]); if (k2 && !f2[k2]) f2[k2] = info;
    }
  }
  return { full: full, f2: f2 };
}
function personaArea(mapa, nombre){
  if (!mapa) return null;
  var k = keyname(nombre); if (mapa.full[k]) return mapa.full[k];
  var k2 = _primeros2(nombre); if (mapa.f2[k2]) return mapa.f2[k2];
  return null;
}

/**
 * NUEVO v2.2.2 — ALIAS_PERSONAS: normalización de identidad para variantes de
 * nombre que aparecen en el CSV de Jira ("Persona asignada" tal como cada
 * quien lo escribió) pero que NO tienen una fila exacta en Usuarios_Jira, así
 * que `personaArea()`/`mapa.full` no las resuelve a un nombre canónico
 * (aunque sí puede resolver el ÁREA vía Maestro, que usa su propio índice).
 *
 * Hallazgo (2026-08-04, revisando dashboard_data.json real): sin esto, la
 * misma persona aparecía fragmentada en `personas_detalle`/`tickets_top` bajo
 * 2+ nombres distintos — ej. "Edwin Cano" y "Edwin Alexander Cano Castillo"
 * del área Analytics mostraban horas separadas, hacienda parecer que el
 * equipo tuvo menos actividad de la real en junio 2026 cuando en realidad
 * solo estaba partida entre 2 "personas" que son la misma.
 *
 * Cada entrada de esta lista fue CONFIRMADA manualmente por el usuario
 * (no es una fusión automática/difusa) — ver decisiones-arquitectura.md D-006
 * para el detalle de cada par y por qué se prefirió una lista explícita a un
 * algoritmo de fuzzy-matching (el riesgo de fusionar por error a dos personas
 * reales distintas —p. ej. dos "María Isabel" que sí existen como personas
 * separadas en la nómina— es demasiado alto para un dato financiero).
 *
 * La clave es keyname() (sin acentos, mayúsculas) de la variante tal como
 * aparece en Jira; el valor es el nombre canónico a usar en todo el dashboard.
 * Si aparecen nuevas variantes de la misma persona en el futuro, agrégalas
 * aquí — o revisa el log de `verificarAliasPersonas()`, que detecta pares
 * sospechosos no cubiertos todavía por esta lista ni por Usuarios_Jira.
 */
var ALIAS_PERSONAS = {};
(function(){
  var pares = [
    ['María Isabel', 'Maria Isabel Escorcia Saltarin'],
    ['Edwin Cano', 'Edwin Alexander Cano Castillo'],
    ['Pedro Carmona', 'Willington Pedro Carmona Florez'],
    ['Angelica Quintana', 'Angelica Lucia Quintana Moreno'],
    ['yoly maritza mahecha', 'Yoly Maritza Mahecha Murcia']
  ];
  pares.forEach(function(p){ ALIAS_PERSONAS[keyname(p[0])] = p[1]; });
})();

/**
 * Normaliza el nombre de una persona a su forma canónica, en este orden:
 *  1. Coincidencia EXACTA en Usuarios_Jira (mapa.full) — usa el nombre oficial
 *     de la columna "Persona asignada" (`nombreCanon`). Esto ya cubre varias
 *     variantes que el propio Usuarios_Jira registra (ej. "Estefany Polo" y
 *     "Estefany Polo Rangel" ambas apuntan a "Estefany Johana Polo Rangel").
 *  2. Lista explícita ALIAS_PERSONAS, para las variantes que Usuarios_Jira
 *     no tiene registradas.
 *  3. Si ninguna aplica, se deja el nombre tal como vino de Jira (sin cambios)
 *     — nunca se usa coincidencia difusa (f2/primeros-2-tokens) aquí, porque
 *     fusionar mal a dos personas reales distintas es un riesgo mayor que
 *     dejar un nombre sin normalizar.
 */
function normalizarPersona(nombreRaw, mapa){
  var n = String(nombreRaw||'').trim();
  if (!n) return n;
  var k = keyname(n);
  if (mapa && mapa.full[k] && mapa.full[k].nombreCanon) return mapa.full[k].nombreCanon;
  if (ALIAS_PERSONAS[k]) return ALIAS_PERSONAS[k];
  return n;
}

// ── Programa: nombre base (sin sufijo facturable) y estado facturable ──
function _progBase(prog){
  var s = String(prog || '').trim();
  s = s.replace(/\s*[-–]\s*(No\s+Facturable|Facturable|Horas\s+adicionales.*|Tiempo\s+de\s+trabajo)\s*$/i, '');
  return s.trim() || 'SIN PROGRAMA';
}
function _facturable(prog, motivoNF){
  if (String(motivoNF || '').trim()) return 'NF';
  var s = keyname(prog);
  if (s.indexOf('NO FACTURABLE') >= 0) return 'NF';
  return 'F';
}
// ── Detalle Jira: período × programa base × área × facturable → horas ──
//    NUEVO v2.1.0: además acumula, en `personasDetPeriodo`, el mismo cruce
//    pero CON persona (período × persona × área × programa × componente ×
//    facturable → horas). Es la única forma de responder "¿quién gastó
//    tiempo No Facturable, en qué programa y con qué componente?" — antes
//    esa granularidad se perdía porque `personas` (línea de abajo) solo
//    acumulaba totales F/NF por persona, sin programa ni componente.
//    Se limita a partir de PERSONAS_DETALLE_DESDE para no inflar el JSON
//    con años de histórico que el líder no necesita consultar al detalle.
//    NUEVO v2.2.0: además acumula `ticketMap` (una fila por ticket Jira,
//    clave → {horas acumuladas, estimado, persona, área, programa,
//    componente, resumen}). "Tiempo Estimado" es una propiedad del ticket,
//    NO del worklog: si un ticket tiene 3 registros de tiempo, su estimado
//    NO se suma 3 veces — se toma una sola vez por ticket. Por eso este
//    cruce se resuelve aparte (ver _finalizarTicketsYComponentes) en vez de
//    sumarlo directo dentro del bucle como los demás acumuladores.
function procesarJiraDetalle(cfg, jiraCSV, mapa, sinArea, personas, personasDetPeriodo, ticketMap){
  var filas = parseCSVObjetos(jiraCSV), porPeriodo = {};
  sinArea = sinArea || {}; personas = personas || {}; personasDetPeriodo = personasDetPeriodo || {};
  ticketMap = ticketMap || {};
  var desde = cfg.PERSONAS_DETALLE_DESDE || '0000-00';
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var horas = segAHoras(col(r,['Tiempo Trabajado','tiempo_trabajado']));
    if (!horas) continue;
    var periodo = periodoDeFecha(col(r,['Fecha de Entrega'])) || periodoDeFecha(col(r,['Creada']));
    if (!periodo) continue;
    var progRaw = String(col(r,['Programa'])).trim() || 'SIN PROGRAMA';
    var base = _progBase(progRaw);
    var fact = _facturable(progRaw, col(r,['Motivo No Facturable']));
    var _persona = String(col(r,['Persona asignada']) || '').trim();
    // v2.2.2: normalizar ANTES de usar como llave de identidad, para que
    // "Edwin Cano" y "Edwin Alexander Cano Castillo" (misma persona, dos
    // formas de escribir el nombre en Jira) se acumulen juntos en vez de
    // aparecer como dos personas distintas. Ver normalizarPersona() / D-006.
    _persona = normalizarPersona(_persona, mapa);
    var info = personaArea(mapa, _persona);
    var area = info ? info.area : 'SIN ÁREA';
    if (!info && _persona) {
      if (!sinArea[_persona]) sinArea[_persona] = { h:0, progs:{}, pMin:periodo, pMax:periodo };
      var _sa = sinArea[_persona];
      _sa.h += horas; _sa.progs[base] = (_sa.progs[base]||0) + horas;
      if (periodo < _sa.pMin) _sa.pMin = periodo;
      if (periodo > _sa.pMax) _sa.pMax = periodo;
    }
    // Componente Jira (para desglosar SuperLikers e internos); vacio -> 'SIN COMPONENTE'
    var comp = String(col(r,['Componentes']) || '').trim() || 'SIN COMPONENTE';
    // Vista lideres: acumular por persona (solo si tenemos persona identificada)
    if (_persona) {
      var _pkp = periodo + '|' + _persona + '|' + area;
      if (!personas[_pkp]) personas[_pkp] = { p:periodo, persona:_persona, area:area, hF:0, hNF:0, hAjustes:0 };
      var _pP = personas[_pkp];
      if (fact === 'NF') _pP.hNF += horas; else _pP.hF += horas;
      var _cl = comp.toLowerCase();
      if (_cl.indexOf('ajust') >= 0 || _cl.indexOf('correc') >= 0 || _cl.indexOf('retrab') >= 0) _pP.hAjustes += horas;

      // NUEVO v2.1.0 — cruce completo persona × programa × componente × F/NF
      if (periodo >= desde) {
        if (!personasDetPeriodo[periodo]) personasDetPeriodo[periodo] = {};
        var pdk = _persona + '||' + area + '||' + base + '||' + fact + '||' + comp;
        personasDetPeriodo[periodo][pdk] = (personasDetPeriodo[periodo][pdk] || 0) + horas;
      }
    }
    if (!porPeriodo[periodo]) porPeriodo[periodo] = {};
    var mk = base + '||' + area + '||' + fact + '||' + comp;
    porPeriodo[periodo][mk] = (porPeriodo[periodo][mk] || 0) + horas;

    // NUEVO v2.2.0 — acumulado por ticket individual (clave Jira), solo
    // dentro de la ventana reciente (misma razón que personas_detalle).
    if (periodo >= desde) {
      var clave = String(col(r,['Clave','clave','Issue key','Key']) || '').trim();
      if (clave) {
        if (!ticketMap[clave]) {
          var resumenRaw = String(col(r,['Resumen','resumen','Summary','Título','Titulo']) || '').trim();
          ticketMap[clave] = {
            clave: clave, persona: _persona || 'SIN PERSONA', area: area, prog: base, comp: comp,
            resumen: resumenRaw.length > 70 ? resumenRaw.slice(0,68)+'…' : resumenRaw,
            horas: 0, estimado: null, primerP: periodo, ultimoP: periodo
          };
        }
        var T = ticketMap[clave];
        T.horas += horas;
        if (periodo < T.primerP) T.primerP = periodo;
        if (periodo > T.ultimoP) T.ultimoP = periodo;
        // "Tiempo Estimado" es propiedad del ticket: se toma la primera lectura
        // no-cero, NUNCA se suma por cada fila de worklog (ver comentario arriba).
        if (T.estimado == null) {
          // v2.2.1: la columna real en el export de Jira de esta cuenta es
          // "Estimación original" (confirmado con verificarColumnasJira() el
          // 2026-08-04 — las 5 variantes que se habían supuesto en v2.2.0 no
          // existían en la hoja real). Se deja primera para que sea la que
          // matchea; las demás quedan como respaldo por si el export cambia.
          var estH = segAHoras(col(r,['Estimación original','Tiempo Estimado','tiempo_estimado','Estimado','Estimacion Original','Original Estimate']));
          if (estH) T.estimado = estH;
        }
      }
    }
  }
  return porPeriodo;
}

/**
 * NUEVO v2.2.0 — a partir del mapa por ticket (una entrada por ticket, no por
 * worklog), construye:
 *   · componentes_estimado: área × componente → {horas, horas_estimadas, tickets}
 *     (horas_estimadas suma el estimado de cada ticket UNA sola vez, nunca por
 *     worklog — por eso se calcula aquí y no dentro del bucle principal).
 *   · tickets_top: los N tickets de mayor horas por área (TOP_TICKETS_POR_AREA),
 *     para no mandar el universo completo de tickets al cliente.
 */
function _finalizarTicketsYComponentes(cfg, ticketMap){
  var porCompKey = {}; // area||comp -> {horas, horasEst, tickets, ticketsConEst}
  var claves = Object.keys(ticketMap);
  for (var i = 0; i < claves.length; i++){
    var t = ticketMap[claves[i]];
    var k = t.area + '||' + t.comp;
    if (!porCompKey[k]) porCompKey[k] = { area:t.area, comp:t.comp, horas:0, horasEst:0, tickets:0, ticketsConEst:0 };
    var C = porCompKey[k];
    C.horas += t.horas;
    C.tickets += 1;
    if (t.estimado != null) { C.horasEst += t.estimado; C.ticketsConEst += 1; }
  }
  var componentes_estimado = Object.keys(porCompKey).map(function(k){
    var c = porCompKey[k];
    return {
      area: c.area, comp: c.comp,
      horas: _round(c.horas), tickets: c.tickets,
      horas_estimadas: c.ticketsConEst ? _round(c.horasEst) : null,
      tickets_con_estimado: c.ticketsConEst
    };
  }).sort(function(a,b){ return b.horas - a.horas; });

  // tickets_top: ordenar todos los tickets por horas desc y tomar los N
  // primeros de cada área (recorriendo ya-ordenado, así el corte por área
  // conserva siempre los de mayor horas).
  var todos = claves.map(function(k){ return ticketMap[k]; }).sort(function(a,b){ return b.horas - a.horas; });
  var top = cfg.TOP_TICKETS_POR_AREA || 25;
  var porArea = {}, tickets_top = [];
  for (var j = 0; j < todos.length; j++){
    var tk = todos[j];
    porArea[tk.area] = (porArea[tk.area] || 0);
    if (porArea[tk.area] >= top) continue;
    porArea[tk.area]++;
    tickets_top.push({
      clave: tk.clave, persona: tk.persona, area: tk.area, prog: tk.prog, comp: tk.comp,
      resumen: tk.resumen, horas: _round(tk.horas),
      estimado: tk.estimado != null ? _round(tk.estimado) : null,
      primer_periodo: tk.primerP, ultimo_periodo: tk.ultimoP
    });
  }
  return { componentes_estimado: componentes_estimado, tickets_top: tickets_top };
}

// ── ENSAMBLE FINAL ───────────────────────────────────────────────────────────
function _tam(obj){ var n=0, k; for (k in obj) if (obj.hasOwnProperty(k)) n++; return n; }
function _round(n, d){ var f = Math.pow(10, d||2); return Math.round(n*f)/f; }

/**
 * Construye el objeto dashboard_data a partir de los 5 CSV (texto).
 * @param {Object} fuentes {maestroCSV, nominaCSV, bcosCSV, jiraCSV, facturacionCSV}
 * @param {Object} [cfg]   configuración (por defecto FINOPS_CONFIG)
 */
/**
 * Procesa la Matriz de PPTO horas 2026:
 * Columnas esperadas: Programa, Área, CONCAT, PPTO (numérico, horas mensuales)
 * Devuelve un array [{prog, area, ppto_mes}]
 */
function procesarHorasPPTO(cfg, pptoCSV){
  var out = [];
  if (!pptoCSV || !String(pptoCSV).trim()) return out;
  var filas = parseCSVObjetos(pptoCSV);
  for (var i = 0; i < filas.length; i++){
    var r = filas[i];
    var prog = String(col(r,['Programa','PROGRAMA'])).trim();
    var area = String(col(r,['Área','Area','AREA'])).trim();
    var raw  = col(r,['PPTO','ppto']);
    var v    = numUS(raw);
    if (!prog || !v) continue;
    out.push({ prog: prog, area: area || '', ppto_mes: _round(v) });
  }
  return out;
}

function construirDashboard(fuentes, cfg){
  cfg = cfg || FINOPS_CONFIG;
  var maestro = construirMaestro(cfg, fuentes.maestroCSV || '');
  var nomina  = procesarNomina(cfg, fuentes.nominaCSV || '', maestro);
  var egresos = procesarEgresos(cfg, fuentes.bcosCSV || '');
  var factur  = procesarFacturacion(cfg, fuentes.facturacionCSV || '');
  var horasContratadas = procesarHorasPPTO(cfg, fuentes.pptoCSV || '');
  var jira    = procesarJira(cfg, fuentes.jiraCSV || '');
  var mapaPers = construirMapaPersonaArea(fuentes.usuariosCSV || USUARIOS_CSV_EMBED, maestro);
  var _sinAreaObj = {}, _personasObj = {}, _personasDetObj = {}, _ticketMapObj = {};
  var progDet = procesarJiraDetalle(cfg, fuentes.jiraCSV || '', mapaPers, _sinAreaObj, _personasObj, _personasDetObj, _ticketMapObj);
  var _ticketsCalc = _finalizarTicketsYComponentes(cfg, _ticketMapObj);

  // Universo de períodos = unión de todas las fuentes con datos
  var setP = {};
  [nomina, egresos, factur, jira].forEach(function(m){ for (var p in m) if (m.hasOwnProperty(p)) setP[p]=true; });
  var periodos = Object.keys(setP).sort();

  var resumen = [], areas_por_periodo = [], egresos_por_periodo = [],
      ingresos_por_periodo = [], programas_por_periodo = [], egresos_detalle = [], nomina_detalle = [], areas_mo_por_periodo = [], programas_detalle = [];

  for (var i = 0; i < periodos.length; i++){
    var p = periodos[i];
    var N = nomina[p]  || {mod:0,moi:0,otro:0,por_area:{},colab_mod:{},colab_todos:{},detalle_nom:{},area_mo:{}};
    var E = egresos[p] || {total:0,por_rubro:{},por_categoria:{},eg_total:0,detalle:{}};
    var F = factur[p]  || {total:0,por_programa:{}};
    var J = jira[p]    || {horas_total:0,por_programa:{}};

    var colabMOD = _tam(N.colab_mod);
    var tLab = tiempoLaboral(cfg, p);
    var denom = colabMOD * tLab;                // horas disponibles de MOD
    var mod = N.mod, moi = N.moi, cos = E.total, ing = F.total;
    var vhMOD    = denom ? mod/denom : 0;
    var vhMODMOI = denom ? (mod+moi)/denom : 0;
    var vhFULL   = denom ? (mod+moi+cos)/denom : 0;
    var costoTotal = mod + moi + cos;
    var utilidad = ing - costoTotal;

    resumen.push({
      periodo: p,
      mod: _round(mod), moi: _round(moi), costos_gastos: _round(cos),
      costo_total: _round(costoTotal), ingresos: _round(ing),
      utilidad: _round(utilidad),
      margen_pct: ing ? _round(utilidad/ing*100) : null,
      colaboradores_mod: colabMOD,
      colaboradores_total: _tam(N.colab_todos),
      tiempo_laboral: tLab,
      horas_disponibles: denom,
      horas_jira: _round(J.horas_total),
      vh_mod: _round(vhMOD), vh_mod_moi: _round(vhMODMOI), vh_full: _round(vhFULL)
    });

    areas_por_periodo.push({ periodo: p, por_area: _redondearMapa(N.por_area) });
    if (N.detalle_nom) { var _nk; for (_nk in N.detalle_nom){ if(!N.detalle_nom.hasOwnProperty(_nk)) continue;
      var _np=_nk.split('||'); var _nv=N.detalle_nom[_nk];
      nomina_detalle.push({p:p, a:_np[0], mo:_np[1], ct:_np[2], sal:_round(_nv.sal), srv:_round(_nv.srv), costo:_round(_nv.costo)}); } }
    var _amo={}; if (N.area_mo){ var _ak; for(_ak in N.area_mo){ if(!N.area_mo.hasOwnProperty(_ak)) continue;
      var _av=N.area_mo[_ak], _cn=0, _ck2; for(_ck2 in _av.colab) if(_av.colab.hasOwnProperty(_ck2)) _cn++;
      _amo[_ak]={mod:_round(_av.mod), moi:_round(_av.moi), colab:_cn}; } }
    areas_mo_por_periodo.push({ periodo:p, tiempo_laboral:tLab, por_area:_amo });
    egresos_por_periodo.push({ periodo: p, total: _round(cos),
      por_rubro: _redondearMapa(E.por_rubro), por_categoria: _redondearMapa(E.por_categoria),
      eg_total: _round(E.eg_total||0) });
    // tabla de detalle (flat) para filtros cruzados
    if (E.detalle) { var _dk; for (_dk in E.detalle){ if(!E.detalle.hasOwnProperty(_dk)) continue;
      var _pt=_dk.split('||'); egresos_detalle.push({p:p, e:_pt[0], b:_pt[1], r:_pt[2], t:_pt[3], cat:_pt[4], prog:_pt[5]||'SIN PROGRAMA', v:_round(E.detalle[_dk])}); } }
    ingresos_por_periodo.push({ periodo: p, total: _round(ing),
      por_programa: _redondearMapa(F.por_programa) });

    // Rentabilidad por programa (Jira horas × VH full; ingreso desde facturación)
    var progs = {};
    var pk;
    for (pk in J.por_programa) if (J.por_programa.hasOwnProperty(pk)) progs[pk] = true;
    for (pk in F.por_programa) if (F.por_programa.hasOwnProperty(pk)) progs[pk] = true;
    for (pk in progs){
      var h = J.por_programa[pk] || 0;
      var ingP = F.por_programa[pk] || 0;
      var costoP = h * vhFULL;
      programas_por_periodo.push({
        periodo: p, programa: pk,
        horas_jira: _round(h),
        costo_mod: _round(h*vhMOD), costo_mod_moi: _round(h*vhMODMOI),
        costo_full: _round(costoP),
        ingreso: _round(ingP),
        utilidad: _round(ingP - costoP),
        margen_pct: ingP ? _round((ingP-costoP)/ingP*100) : null
      });
    }
  }

  // programas_detalle (flat): período × programa × área × facturable → horas
  var _pp; for (_pp in progDet){ if(!progDet.hasOwnProperty(_pp)) continue;
    var _mm=progDet[_pp], _mk2; for(_mk2 in _mm){ if(!_mm.hasOwnProperty(_mk2)) continue;
      var _pt=_mk2.split('||'); programas_detalle.push({p:_pp, prog:_pt[0], area:_pt[1], fact:_pt[2], comp:_pt[3]||'SIN COMPONENTE', horas:_round(_mm[_mk2])}); } }

  // personas_detalle (flat) — NUEVO v2.1.0: período × persona × área × programa ×
  // componente × facturable → horas. Alimenta el drill-down de "Horas No
  // Facturables · por persona" y el cruce/segmentación estilo Power BI en el
  // dashboard de líderes. Ver decisiones-arquitectura.md.
  var personas_detalle = [];
  var _pd; for (_pd in _personasDetObj){ if(!_personasDetObj.hasOwnProperty(_pd)) continue;
    var _dm=_personasDetObj[_pd], _dk3; for(_dk3 in _dm){ if(!_dm.hasOwnProperty(_dk3)) continue;
      var _pt3=_dk3.split('||');
      personas_detalle.push({
        p:_pd, persona:_pt3[0], area:_pt3[1], prog:_pt3[2],
        fact:_pt3[3], comp:_pt3[4]||'SIN COMPONENTE', horas:_round(_dm[_dk3])
      }); } }

  // series_tiempo (arrays paralelos para gráficos)
  var series = { periodos: periodos };
  var campos = ['mod','moi','costos_gastos','ingresos','utilidad','vh_mod','vh_mod_moi',
                'vh_full','colaboradores_mod','tiempo_laboral','horas_jira'];
  campos.forEach(function(c){ series[c] = resumen.map(function(r){ return r[c]; }); });

  return {
    _meta: {
      generado_en: new Date().toISOString(),
      version: '2.2.3',
      periodos: periodos.length,
      periodo_inicio: periodos[0] || null,
      periodo_fin: periodos[periodos.length-1] || null,
      reglas: {
        parafiscales: cfg.FACTOR_PARAFISCALES,
        horas_dia: cfg.HORAS_POR_DIA,
        costo: 'Salario Devengado × 1.4385 + Servicio Devengado',
        clasificacion: 'Área Maestro (SWITCH) por nombre',
        denominador_vh: 'colaboradores MOD × días hábiles × 7.5',
        personas_detalle_desde: cfg.PERSONAS_DETALLE_DESDE,
        top_tickets_por_area: cfg.TOP_TICKETS_POR_AREA
      }
    },
    series_tiempo: series,
    resumen_por_periodo: resumen,
    areas_por_periodo: areas_por_periodo,
    nomina_detalle: nomina_detalle,
    areas_mo_por_periodo: areas_mo_por_periodo,
    egresos_por_periodo: egresos_por_periodo,
    egresos_detalle: egresos_detalle,
    ingresos_por_periodo: ingresos_por_periodo,
    programas_por_periodo: programas_por_periodo,
    programas_detalle: programas_detalle,
    personas_por_periodo: (function(){
      var out=[], k; for (k in _personasObj) { if (!_personasObj.hasOwnProperty(k)) continue;
        var v=_personasObj[k];
        out.push({ p:v.p, persona:v.persona, area:v.area, hF:_round(v.hF), hNF:_round(v.hNF), hAjustes:_round(v.hAjustes) });
      }
      out.sort(function(x,y){ if(x.p!==y.p) return x.p<y.p?1:-1; return (y.hF+y.hNF)-(x.hF+x.hNF); });
      return out;
    })(),
    personas_detalle: personas_detalle,
    componentes_estimado: _ticketsCalc.componentes_estimado,
    tickets_top: _ticketsCalc.tickets_top,
    horas_contratadas: horasContratadas,
    personas_sin_area: (function(){
      var out = []; for (var _pn in _sinAreaObj) { if (!_sinAreaObj.hasOwnProperty(_pn)) continue;
        var _r = _sinAreaObj[_pn], _tp = [], _pk;
        for (_pk in _r.progs) { if (_r.progs.hasOwnProperty(_pk)) _tp.push({prog:_pk, h:_round(_r.progs[_pk])}); }
        _tp.sort(function(x,y){ return y.h - x.h; });
        out.push({ persona:_pn, horas:_round(_r.h), programas:_tp.slice(0,5), primer_periodo:_r.pMin, ultimo_periodo:_r.pMax });
      }
      out.sort(function(x,y){ return y.horas - x.horas; });
      return out;
    })()
  };
}
function _redondearMapa(m){ var o={},k; for(k in m) if(m.hasOwnProperty(k)) o[k]=_round(m[k]); return o; }
function _redondearAnidado(m){ var o={},k; for(k in m) if(m.hasOwnProperty(k)) o[k]=_redondearMapa(m[k]); return o; }

// ===========================================================================
// PUNTOS DE ENTRADA — APPS SCRIPT
// ===========================================================================

/** Descarga un CSV publicado (síncrono). '' si no hay URL o falla. */
function _fetchCSV(url){
  if (!url) return '';
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions:true, followRedirects:true });
    return r.getResponseCode() === 200 ? r.getContentText() : '';
  } catch (e){ return ''; }
}

/** Función principal: descarga fuentes, construye el JSON y lo guarda en Drive. */
function main(){
  var t0 = Date.now();
  var U = _cfgURLS();
  var faltan = ['URL_MAESTRO','URL_NOMINA','URL_BCOS','URL_JIRA','URL_FACTURACION']
    .filter(function(k){ return !U[k]; });
  if (faltan.length) throw new Error('Faltan URLs (bloque URLS o Propiedades): ' + faltan.join(', '));

  var fuentes = {
    maestroCSV:     _fetchCSV(U.URL_MAESTRO),
    nominaCSV:      _fetchCSV(U.URL_NOMINA),
    bcosCSV:        _fetchCSV(U.URL_BCOS),
    jiraCSV:        _fetchCSV(U.URL_JIRA),
    facturacionCSV: _fetchCSV(U.URL_FACTURACION),
    usuariosCSV:    _fetchCSV(U.URL_USUARIOS),
    pptoCSV:        _fetchCSV(U.URL_HORAS_PPTO)
  };
  var data = construirDashboard(fuentes);
  var archivo = _guardarJSON(data, U.FOLDER_ID);
  console.log('ETL OK en ' + (Date.now()-t0) + 'ms · ' + data._meta.periodos +
              ' períodos · ' + data.personas_detalle.length + ' filas personas_detalle · ' +
              data.componentes_estimado.length + ' componentes_estimado · ' +
              data.tickets_top.length + ' tickets_top · ' + archivo.getUrl());
  return {
    ok:true, periodos:data._meta.periodos,
    personas_detalle_filas: data.personas_detalle.length,
    componentes_estimado_filas: data.componentes_estimado.length,
    tickets_top_filas: data.tickets_top.length,
    archivo:archivo.getId()
  };
}

/** Escribe dashboard_data.json (sobrescribe) + backup con fecha en /backups. */
function _guardarJSON(data, folderId){
  var contenido = JSON.stringify(data);
  var carpeta = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  var it = carpeta.getFilesByName('dashboard_data.json'), archivo;
  if (it.hasNext()){ archivo = it.next(); archivo.setContent(contenido); }
  else archivo = carpeta.createFile('dashboard_data.json', contenido, 'application/json');
  // El proxy de Netlify (finops-data.js) lee este archivo SIN autenticación
  // (fetch anónimo por id). Un archivo de Apps Script es privado por defecto:
  // sin esta línea, Drive le devuelve una página de login/permiso en vez del
  // JSON, y el dashboard cae al respaldo embebido ("Data local (no Drive)").
  // Se fuerza en cada corrida para no depender de que quede bien configurado
  // manualmente una sola vez (y para que sobreviva si el archivo se recrea).
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var subs = carpeta.getFoldersByName('backups');
  var bk = subs.hasNext() ? subs.next() : carpeta.createFolder('backups');
  var sello = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyyMMdd_HHmmss');
  bk.createFile('dashboard_data_' + sello + '.json', contenido, 'application/json');
  return archivo;
}

/** Programa la corrida diaria de main (~05:00 zona del proyecto). */
function crearActivadorDiario(){
  ScriptApp.getProjectTriggers().forEach(function(tr){
    if (tr.getHandlerFunction() === 'main') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('main').timeBased().everyDays(1).atHour(5).create();
  console.log('Activador diario creado.');
}

/** Diagnóstico: verifica accesos y muestra cabeceras de las 5 fuentes. */
function probarConexionFuentes(){
  var U = _cfgURLS();
  [['URL_MAESTRO','maestro'],['URL_NOMINA','nomina'],['URL_BCOS','bcos'],
   ['URL_JIRA','jira'],['URL_FACTURACION','facturacion'],['URL_USUARIOS','usuarios'],['URL_HORAS_PPTO','ppto']].forEach(function(par){
    var url = U[par[0]];
    if (!url){ console.log('— ' + par[1] + ': SIN URL'); return; }
    var txt = _fetchCSV(url);
    var cab = (txt.split('\n')[0] || '').slice(0,110);
    console.log('✓ ' + par[1] + ' · ' + txt.length + ' bytes · ' + cab);
  });
}

/**
 * NUEVO v2.2.0 — DIAGNÓSTICO OBLIGATORIO antes de confiar en
 * `componentes_estimado` / `tickets_top`: estos dos campos son nuevos y
 * usan columnas de Jira (Clave, Resumen, Tiempo Estimado) que el ETL nunca
 * había leído. Los nombres de columna candidatos son un supuesto razonable
 * (formato típico de export de Jira), NO una confirmación contra tu hoja
 * real. Corre esta función primero y revisa el log: si alguna columna sale
 * "NO ENCONTRADA", agrega el nombre real a la lista correspondiente dentro
 * de `procesarJiraDetalle` (busca 'Clave','clave','Issue key','Key').
 */
function verificarColumnasJira(){
  var U = _cfgURLS();
  var txt = _fetchCSV(U.URL_JIRA);
  if (!txt){ console.log('No se pudo leer URL_JIRA.'); return; }
  var filas = parseCSVObjetos(txt);
  if (!filas.length){ console.log('Jira CSV vacío o sin filas de datos.'); return; }
  var cabeceras = Object.keys(filas[0]);
  console.log('Columnas encontradas en Jira (' + cabeceras.length + '): ' + cabeceras.join(' | '));
  var candidatos = {
    'Clave (ticket)': ['Clave','clave','Issue key','Key'],
    'Resumen (ticket)': ['Resumen','resumen','Summary','Título','Titulo'],
    'Tiempo Estimado': ['Estimación original','Tiempo Estimado','tiempo_estimado','Estimado','Estimacion Original','Original Estimate']
  };
  Object.keys(candidatos).forEach(function(campo){
    var opciones = candidatos[campo];
    var encontrada = opciones.filter(function(o){ return cabeceras.indexOf(o) >= 0; });
    console.log((encontrada.length ? '✓ ' : '✗ NO ENCONTRADA — ') + campo + ': ' +
      (encontrada.length ? 'usa "' + encontrada[0] + '"' : 'ninguna de [' + opciones.join(', ') + '] existe en la hoja'));
  });
}

/** Prueba interna opcional: corre el ETL y registra KPIs de un período. */
function verificarPeriodo(){
  var U = _cfgURLS();
  var data = construirDashboard({
    maestroCSV:_fetchCSV(U.URL_MAESTRO), nominaCSV:_fetchCSV(U.URL_NOMINA),
    bcosCSV:_fetchCSV(U.URL_BCOS), jiraCSV:_fetchCSV(U.URL_JIRA),
    facturacionCSV:_fetchCSV(U.URL_FACTURACION), usuariosCSV:_fetchCSV(U.URL_USUARIOS),
    pptoCSV:_fetchCSV(U.URL_HORAS_PPTO)
  });
  var r = data.resumen_por_periodo.filter(function(x){ return x.periodo==='2026-01'; })[0];
  console.log('2026-01: ' + JSON.stringify(r));
}

/**
 * NUEVO v2.1.0 — prueba puntual del nuevo cruce persona×programa×componente.
 * Corre el ETL y muestra, para un área+mes, quién acumuló más horas No
 * Facturables y en qué programa/componente. Útil para validar manualmente
 * contra lo que el líder ve en Jira antes de confiar en el dashboard.
 */
function verificarPersonasDetalle(area, periodo){
  area = area || 'Contenidos'; periodo = periodo || '2026-05';
  var U = _cfgURLS();
  var data = construirDashboard({
    maestroCSV:_fetchCSV(U.URL_MAESTRO), nominaCSV:_fetchCSV(U.URL_NOMINA),
    bcosCSV:_fetchCSV(U.URL_BCOS), jiraCSV:_fetchCSV(U.URL_JIRA),
    facturacionCSV:_fetchCSV(U.URL_FACTURACION), usuariosCSV:_fetchCSV(U.URL_USUARIOS),
    pptoCSV:_fetchCSV(U.URL_HORAS_PPTO)
  });
  var rows = data.personas_detalle.filter(function(x){ return x.area===area && x.p===periodo && x.fact==='NF'; });
  var porPersona = {};
  rows.forEach(function(r){ porPersona[r.persona] = (porPersona[r.persona]||0) + r.horas; });
  var ranking = Object.keys(porPersona).map(function(k){ return {persona:k, horas:_round(porPersona[k])}; })
    .sort(function(a,b){ return b.horas - a.horas; });
  console.log(area + ' ' + periodo + ' — top personas NF:', JSON.stringify(ranking.slice(0,10)));
  console.log('Filas totales personas_detalle:', data.personas_detalle.length);
}

/**
 * NUEVO v2.2.2 — DIAGNÓSTICO RECOMENDADO tras cada corrida de `main()`:
 * detecta pares de nombres en `personas_detalle` que parecen ser la MISMA
 * persona escrita de forma distinta (mismo patrón que reveló el caso
 * "Edwin Cano" / "Edwin Alexander Cano Castillo" — ver D-006), y que NO
 * están todavía cubiertos por Usuarios_Jira ni por `ALIAS_PERSONAS`.
 *
 * Heurística: todas las palabras del nombre más corto aparecen, en el mismo
 * orden relativo, dentro del nombre más largo (ej. "Pedro Carmona" ⊆ "Pedro
 * Carmona Florez"). Es deliberadamente conservadora — puede dar falsos
 * positivos (dos personas reales que comparten nombre y apellido) pero NO
 * fusiona nada automáticamente: solo imprime candidatos para que un humano
 * los revise y, si corresponde, los agregue a `ALIAS_PERSONAS`.
 *
 * Esto no reemplaza una auditoría de la nómina real, pero evita que nuevas
 * variantes de nombre pasen desapercibidas silenciosamente en el futuro.
 */
function verificarAliasPersonas(){
  var U = _cfgURLS();
  var data = construirDashboard({
    maestroCSV:_fetchCSV(U.URL_MAESTRO), nominaCSV:_fetchCSV(U.URL_NOMINA),
    bcosCSV:_fetchCSV(U.URL_BCOS), jiraCSV:_fetchCSV(U.URL_JIRA),
    facturacionCSV:_fetchCSV(U.URL_FACTURACION), usuariosCSV:_fetchCSV(U.URL_USUARIOS),
    pptoCSV:_fetchCSV(U.URL_HORAS_PPTO)
  });
  var nombres = [];
  var vistos = {};
  (data.personas_detalle||[]).forEach(function(r){ if (!vistos[r.persona]) { vistos[r.persona]=true; nombres.push(r.persona); } });
  var sospechosos = [];
  for (var i=0;i<nombres.length;i++){
    for (var j=i+1;j<nombres.length;j++){
      var a=keyname(nombres[i]).split(' ').filter(Boolean), b=keyname(nombres[j]).split(' ').filter(Boolean);
      if (a.join(' ')===b.join(' ')) continue;
      var corto = a.length<=b.length?a:b, largo = a.length<=b.length?b:a;
      var contenido = corto.length>=1 && corto.every(function(t){ return largo.indexOf(t)>=0; });
      if (contenido) sospechosos.push([nombres[i], nombres[j]]);
    }
  }
  console.log('Nombres distintos en personas_detalle: ' + nombres.length);
  console.log('Pares sospechosos de ser la misma persona (revisar y, si corresponde, agregar a ALIAS_PERSONAS): ' + sospechosos.length);
  sospechosos.forEach(function(p){ console.log(' - "' + p[0] + '"  <->  "' + p[1] + '"'); });
  if (!sospechosos.length) console.log('Ninguno detectado — no hay acción pendiente.');
}
