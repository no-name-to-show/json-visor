'use strict';

/**
 * Motor de análisis: estadísticas, esquema inferido, hallazgos de calidad,
 * comparación entre dos JSON y reporte en texto para tickets.
 */
(function (root) {
    const JT = (root.JT = root.JT || {});
    const { pathToString } = JT;

    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const MAX_SAMPLES = 5;
    const ID_KEY = /(^|[_\-.])(id|uuid|guid|codigo|code|key|clave|folio|ref|referencia)$|^(id|uuid|guid)[A-Z_]|[a-z](Id|ID|Uuid|Guid)$/;

    const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

    /* Definición de banderas por valor ---------------------------------- */
    const FLAGS = {
        empty: { sev: 'info', title: 'Cadenas vacías', detail: 'Campos de texto con "" (vacío). Puede ser un dato que no llegó.' },
        padded: { sev: 'warn', title: 'Texto con espacios al inicio o al final', detail: 'Provoca fallos silenciosos en búsquedas, comparaciones y cruces de datos.' },
        numStr: { sev: 'info', title: 'Números guardados como texto', detail: 'El valor es numérico pero viene entre comillas. Revisa si el consumidor espera un número.' },
        boolStr: { sev: 'warn', title: 'Booleanos guardados como texto', detail: '"true"/"false" como cadena: en muchos lenguajes la cadena "false" se evalúa como verdadera.' },
        nullStr: { sev: 'warn', title: 'Texto que parece un nulo', detail: 'Valores como "null", "undefined", "NaN", "N/A": probablemente debieron ser null o estar ausentes.' },
        mojibake: { sev: 'warn', title: 'Posible error de codificación (caracteres rotos)', detail: 'Se ven secuencias como Ã©, Â, â€ o �. Típico de UTF-8 leído como Latin-1 (o al revés).' },
        escaped: { sev: 'info', title: 'Secuencias de escape sin decodificar', detail: 'El texto contiene \\uXXXX o \\n literales: probable doble escape al serializar.' },
        embedded: { sev: 'info', title: 'JSON incrustado dentro de un texto', detail: 'El valor es un JSON serializado como cadena. Se puede analizar por separado con el botón "Analizar contenido".' },
        longStr: { sev: 'info', title: 'Cadenas muy largas', detail: 'Más de 2 000 caracteres: puede ser base64, HTML, un log o un archivo incrustado.' },
        dateInvalid: { sev: 'error', title: 'Fechas inválidas', detail: 'La fecha tiene forma de fecha pero no existe en el calendario (p. ej. 2024-02-31 o mes 13).' },
        floatNoise: { sev: 'info', title: 'Decimales con ruido de punto flotante', detail: 'Números como 0.30000000000000004: conviene redondear al serializar.' },
        keySpace: { sev: 'warn', title: 'Claves con espacios al inicio o al final', detail: 'La clave " nombre" no es igual a "nombre"; suele romper la lectura por nombre.' },
        keyEmpty: { sev: 'warn', title: 'Claves vacías', detail: 'Hay claves con "" como nombre.' },
        keyCase: { sev: 'warn', title: 'Claves que solo difieren en mayúsculas/minúsculas', detail: 'Dentro del mismo objeto conviven, por ejemplo, "Nombre" y "nombre".' },
        emptyArr: { sev: 'info', title: 'Arreglos vacíos', detail: 'Listas sin elementos.' },
        emptyObj: { sev: 'info', title: 'Objetos vacíos', detail: 'Objetos {} sin claves.' },
    };

    const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
    const DATE_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    const DATE_YMD_SLASH = /^(\d{4})\/(\d{2})\/(\d{2})$/;

    function validYmd(y, m, d) {
        if (m < 1 || m > 12 || d < 1) return false;
        const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return d <= dim;
    }

    function keyStyle(k) {
        if (!/[A-Za-z]/.test(k) || /\s/.test(k)) return null;
        if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(k)) return 'MAYUS_SNAKE';
        if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(k)) return 'snake_case';
        if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(k)) return 'kebab-case';
        if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(k)) return 'camelCase';
        if (/^([A-Z][a-z0-9]+){2,}$/.test(k)) return 'PascalCase';
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Análisis principal                                                  */
    /* ------------------------------------------------------------------ */
    function analyze(rootValue, parseInfo) {
        const schema = new Map();
        const stats = {
            nodes: 0, maxDepth: 0, keysTotal: 0,
            types: { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 },
            maxArray: 0, uniqueKeys: new Set(),
        };
        const tables = [];
        const extraFindings = [];
        const styles = {};
        let embeddedTries = 0;

        const segs = [];

        function entry(pattern, parent, keyName) {
            let e = schema.get(pattern);
            if (!e) {
                e = {
                    pattern, parent, keyName, count: 0, types: {}, nulls: 0, objs: 0,
                    flags: {}, uniq: new Set(), uniqOverflow: false,
                    min: Infinity, max: -Infinity, maxLen: 0, sample: undefined,
                    dateFormats: {}, dateSamples: {},
                };
                schema.set(pattern, e);
            }
            return e;
        }

        function flag(e, name) {
            const f = e.flags[name] || (e.flags[name] = { count: 0, samples: [] });
            f.count++;
            if (f.samples.length < MAX_SAMPLES) f.samples.push(pathToString(segs));
        }

        function visit(v, pattern, parent, keyName, depth) {
            const t = typeOf(v);
            stats.nodes++;
            stats.types[t]++;
            if (depth > stats.maxDepth) stats.maxDepth = depth;

            const e = entry(pattern, parent, keyName);
            e.count++;
            e.types[t] = (e.types[t] || 0) + 1;

            if (t === 'null') { e.nulls++; return; }

            if (t === 'string') {
                const s = v;
                if (e.sample === undefined) e.sample = s;
                if (s.length > e.maxLen) e.maxLen = s.length;
                if (!e.uniqOverflow) { e.uniq.add(s); if (e.uniq.size > 5000) { e.uniqOverflow = true; e.uniq.clear(); } }
                if (s === '') { flag(e, 'empty'); return; }
                if (s !== s.trim()) flag(e, 'padded');
                if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s) && s.length <= 18) flag(e, 'numStr');
                else if (/^(true|false)$/i.test(s)) flag(e, 'boolStr');
                else if (/^(null|undefined|nan|n\/a|na|none|nil)$/i.test(s.trim())) flag(e, 'nullStr');
                if (/Ã[\u0080-¿]|Â[ -¿]|â€|�/.test(s)) flag(e, 'mojibake');
                if (/\\u[0-9a-fA-F]{4}|\\n|\\r|\\t/.test(s)) flag(e, 'escaped');
                if (s.length > 2000) flag(e, 'longStr');
                if ((s[0] === '{' || s[0] === '[') && s.length > 1 && embeddedTries < 300) {
                    embeddedTries++;
                    try { const r = JSON.parse(s); if (r !== null && typeof r === 'object') flag(e, 'embedded'); } catch (_) { /* no es JSON */ }
                }
                // Fechas
                let m;
                if ((m = DATE_ISO.exec(s))) {
                    const fmt = m[4] !== undefined ? 'ISO fecha-hora' : 'ISO fecha';
                    e.dateFormats[fmt] = (e.dateFormats[fmt] || 0) + 1;
                    if (!e.dateSamples[fmt]) e.dateSamples[fmt] = s;
                    if (!validYmd(+m[1], +m[2], +m[3]) || (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59)))) flag(e, 'dateInvalid');
                } else if ((m = DATE_DMY.exec(s))) {
                    e.dateFormats['D/M/AAAA'] = (e.dateFormats['D/M/AAAA'] || 0) + 1;
                    if (!e.dateSamples['D/M/AAAA']) e.dateSamples['D/M/AAAA'] = s;
                    const a = +m[1], b = +m[2];
                    if (!validYmd(+m[3], b, a) && !validYmd(+m[3], a, b)) flag(e, 'dateInvalid');
                } else if ((m = DATE_YMD_SLASH.exec(s))) {
                    e.dateFormats['AAAA/MM/DD'] = (e.dateFormats['AAAA/MM/DD'] || 0) + 1;
                    if (!e.dateSamples['AAAA/MM/DD']) e.dateSamples['AAAA/MM/DD'] = s;
                    if (!validYmd(+m[1], +m[2], +m[3])) flag(e, 'dateInvalid');
                }
                return;
            }

            if (t === 'number') {
                if (e.sample === undefined) e.sample = v;
                if (v < e.min) e.min = v;
                if (v > e.max) e.max = v;
                if (!e.uniqOverflow) { e.uniq.add(v); if (e.uniq.size > 5000) { e.uniqOverflow = true; e.uniq.clear(); } }
                if (/^-?\d+\.\d{10,}$/.test(String(v))) flag(e, 'floatNoise');
                return;
            }

            if (t === 'boolean') {
                if (e.sample === undefined) e.sample = v;
                if (!e.uniqOverflow) e.uniq.add(v);
                return;
            }

            if (t === 'array') {
                if (v.length > stats.maxArray) stats.maxArray = v.length;
                if (v.length === 0) { flag(e, 'emptyArr'); return; }
                const itemPattern = pattern + '[]';
                if (v.length >= 1 && v.every(isObj)) {
                    tables.push({ path: pathToString(segs), segs: segs.slice(), length: v.length, pattern });
                    checkArrayOfObjects(v, pattern);
                }
                for (let i = 0; i < v.length; i++) {
                    segs.push(i);
                    visit(v[i], itemPattern, pattern, '[]', depth + 1);
                    segs.pop();
                }
                return;
            }

            // objeto
            e.objs++;
            const keys = Object.keys(v);
            if (keys.length === 0) { flag(e, 'emptyObj'); return; }
            const lower = new Map();
            for (const k of keys) {
                stats.keysTotal++;
                stats.uniqueKeys.add(k);
                const st = keyStyle(k);
                if (st) {
                    const s = styles[st] || (styles[st] = { count: 0, samples: [] });
                    s.count++;
                    if (s.samples.length < 4 && !s.samples.includes(k)) s.samples.push(k);
                }
                if (k === '') { segs.push(k); flag(e, 'keyEmpty'); segs.pop(); }
                else if (k !== k.trim()) { segs.push(k); flag(e, 'keySpace'); segs.pop(); }
                const lk = k.toLowerCase();
                if (lower.has(lk)) { segs.push(k); flag(e, 'keyCase'); segs.pop(); }
                else lower.set(lk, k);
            }
            for (const k of keys) {
                segs.push(k);
                visit(v[k], pattern + '.' + k, pattern, k, depth + 1);
                segs.pop();
            }
        }

        function checkArrayOfObjects(arr, pattern) {
            const base = pathToString(segs);
            if (arr.length < 2) return;

            // Duplicados por campos tipo id
            const keySet = new Set();
            arr.forEach((o) => Object.keys(o).forEach((k) => keySet.add(k)));
            for (const k of keySet) {
                if (!ID_KEY.test(k)) continue;
                const seen = new Map();
                const dups = new Map();
                arr.forEach((o, i) => {
                    const val = o[k];
                    if (val === undefined || val === null || typeof val === 'object') return;
                    const key = typeof val + ':' + val;
                    if (seen.has(key)) {
                        const d = dups.get(key) || { value: val, idx: [seen.get(key)] };
                        d.idx.push(i);
                        dups.set(key, d);
                    } else seen.set(key, i);
                });
                if (dups.size) {
                    const list = Array.from(dups.values());
                    const rows = list.reduce((a, d) => a + d.idx.length, 0);
                    extraFindings.push({
                        sev: 'warn',
                        title: `Valores repetidos en un campo tipo identificador: ${k}`,
                        detail: `${list.length} valor(es) se repiten (${rows} registros afectados). Ejemplos: ` +
                            list.slice(0, 3).map((d) => `${JSON.stringify(d.value)} → posiciones ${d.idx.slice(0, 5).join(', ')}`).join(' · '),
                        pattern: pattern + '[].' + k,
                        count: rows, total: arr.length,
                        samples: list.slice(0, MAX_SAMPLES).map((d) => `${base}[${d.idx[0]}]` + (/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`)),
                    });
                }
            }

            // Registros completamente duplicados
            if (arr.length <= 5000) {
                const seen = new Map();
                const dupIdx = [];
                let budget = 8e6;
                for (let i = 0; i < arr.length && budget > 0; i++) {
                    const s = JSON.stringify(arr[i]);
                    budget -= s.length;
                    if (seen.has(s)) dupIdx.push([seen.get(s), i]);
                    else seen.set(s, i);
                }
                if (dupIdx.length) {
                    extraFindings.push({
                        sev: 'warn',
                        title: 'Registros completamente duplicados',
                        detail: `${dupIdx.length} registro(s) son idénticos a otro anterior de la misma lista. Ejemplos: ` +
                            dupIdx.slice(0, 3).map(([a, b]) => `posición ${b} = posición ${a}`).join(' · '),
                        pattern: pattern + '[]',
                        count: dupIdx.length, total: arr.length,
                        samples: dupIdx.slice(0, MAX_SAMPLES).map(([, b]) => `${base}[${b}]`),
                    });
                }
            }
        }

        visit(rootValue, '$', null, '$', 0);

        /* ---- Hallazgos del parser ---------------------------------- */
        const findings = [];
        let nid = 0;
        const push = (f) => findings.push(Object.assign({ id: ++nid, samples: [], count: 1, total: null }, f));

        if (parseInfo && parseInfo.issues) {
            const dk = parseInfo.issues.duplicateKeys;
            if (dk.length) {
                push({
                    sev: 'error',
                    title: 'Claves duplicadas en el mismo objeto',
                    detail: 'JSON permite repetir una clave pero solo se conserva el ÚLTIMO valor; los anteriores se pierden en silencio. Suele indicar un bug del generador.',
                    pattern: dk[0].path, count: dk.length,
                    samples: dk.slice(0, MAX_SAMPLES).map((d) => d.path),
                });
            }
            const bn = parseInfo.issues.bigNumbers;
            if (bn.length) {
                push({
                    sev: 'error',
                    title: 'Enteros demasiado grandes (pierden precisión)',
                    detail: `JavaScript solo representa con exactitud enteros hasta 9 007 199 254 740 991. Ejemplo: ${bn[0].raw} se leería distinto. Estos valores deberían viajar como texto.`,
                    pattern: bn[0].path, count: bn.length,
                    samples: bn.slice(0, MAX_SAMPLES).map((d) => d.path),
                });
            }
        }

        /* ---- Hallazgos por patrón de esquema ------------------------ */
        for (const e of schema.values()) {
            const nonNull = Object.keys(e.types).filter((t) => t !== 'null');

            if (nonNull.length > 1) {
                const desc = nonNull.map((t) => `${t} ×${e.types[t]}`).join(', ');
                push({
                    sev: 'warn', title: 'Tipos de dato mezclados en el mismo campo',
                    detail: `Se encontraron distintos tipos: ${desc}. Un consumidor que espera un solo tipo puede fallar.`,
                    pattern: e.pattern, count: e.count, total: e.count, samples: [],
                    needSamples: true,
                });
            }

            if (e.pattern !== '$' && e.count >= 3 && e.nulls === e.count) {
                push({
                    sev: 'warn', title: 'Campo siempre null',
                    detail: 'En todas sus apariciones el valor es null: el campo no aporta información (¿no se está poblando?).',
                    pattern: e.pattern, count: e.count, total: e.count, needSamples: true, samples: [],
                });
            } else if (e.nulls > 0 && e.pattern !== '$') {
                push({
                    sev: 'info', title: 'Valores null',
                    detail: `${e.nulls} de ${e.count} apariciones son null.`,
                    pattern: e.pattern, count: e.nulls, total: e.count, needSamples: true, samples: [],
                });
            }

            const fmts = Object.keys(e.dateFormats);
            if (fmts.length > 1) {
                push({
                    sev: 'warn', title: 'Formatos de fecha mezclados',
                    detail: fmts.map((f) => `${f} ×${e.dateFormats[f]} (ej. "${e.dateSamples[f]}")`).join(' · '),
                    pattern: e.pattern, count: e.count, total: e.count, samples: [], needSamples: true,
                });
            }

            const stringsHere = e.types.string || e.count;
            for (const [name, f] of Object.entries(e.flags)) {
                const def = FLAGS[name];
                if (!def) continue;
                const isStrFlag = !['emptyArr', 'emptyObj', 'keySpace', 'keyEmpty', 'keyCase', 'floatNoise'].includes(name);
                const total = name === 'emptyArr' ? (e.types.array || e.count) : name === 'emptyObj' ? (e.types.object || e.count) : name === 'floatNoise' ? (e.types.number || e.count) : isStrFlag ? stringsHere : e.objs;
                push({
                    sev: def.sev, title: def.title, detail: def.detail,
                    pattern: e.pattern, count: f.count, total, samples: f.samples.slice(),
                    flagName: name,
                });
            }
        }

        extraFindings.forEach(push);

        // Presencia de claves (campos opcionales)
        for (const e of schema.values()) {
            if (!e.parent || e.keyName === '[]') continue;
            const p = schema.get(e.parent);
            if (!p || p.objs < 2) continue;
            const present = e.count;
            if (present < p.objs) {
                const missing = p.objs - present;
                const ratio = missing / p.objs;
                push({
                    sev: ratio <= 0.1 ? 'warn' : 'info',
                    title: 'Campo ausente en algunos registros',
                    detail: `Presente en ${present} de ${p.objs} objetos (falta en ${missing}). ${ratio <= 0.1 ? 'Al ser una minoría pequeña, probablemente sea una omisión.' : 'Puede ser un campo opcional legítimo.'}`,
                    pattern: e.pattern, count: missing, total: p.objs, samples: [], needSamples: true, missingKey: true,
                });
            }
        }

        // Convención de nombres
        const styleNames = Object.keys(styles);
        if (styleNames.length > 1) {
            push({
                sev: 'info', title: 'Convenciones de nombres de claves mezcladas',
                detail: styleNames.map((s) => `${s}: ${styles[s].count} (ej. ${styles[s].samples.join(', ')})`).join(' · '),
                pattern: '$', count: styleNames.length, total: null,
            });
        }

        if (stats.maxDepth > 12) {
            push({ sev: 'info', title: 'Anidación muy profunda', detail: `El JSON llega a ${stats.maxDepth} niveles de profundidad.`, pattern: '$', count: stats.maxDepth });
        }
        if (stats.maxArray > 10000) {
            push({ sev: 'info', title: 'Arreglos muy grandes', detail: `Hay un arreglo con ${stats.maxArray.toLocaleString('es')} elementos; la vista tabla muestra por páginas.`, pattern: '$', count: stats.maxArray });
        }

        /* ---- Rellenar muestras (rutas concretas) donde falten --------- */
        const needs = findings.filter((f) => f.needSamples);
        if (needs.length) fillSamples(rootValue, needs);

        findings.sort((a, b) => SEVERITY_ORDER[a.sev] - SEVERITY_ORDER[b.sev] || (b.count / (b.total || b.count)) - (a.count / (a.total || a.count)) || b.count - a.count);

        const counts = { error: 0, warn: 0, info: 0 };
        findings.forEach((f) => counts[f.sev]++);

        /* ---- Filas de esquema ---------------------------------------- */
        const rows = [];
        for (const e of schema.values()) {
            const p = e.parent ? schema.get(e.parent) : null;
            const presence = p && p.objs && e.keyName !== '[]' ? e.count / p.objs : null;
            rows.push({
                pattern: e.pattern,
                types: e.types,
                count: e.count,
                nulls: e.nulls,
                presence,
                unique: e.uniqOverflow ? '5000+' : (e.uniq.size || (e.count && !('string' in e.types || 'number' in e.types || 'boolean' in e.types) ? '' : e.uniq.size)),
                min: e.min === Infinity ? null : e.min,
                max: e.max === -Infinity ? null : e.max,
                maxLen: e.maxLen || null,
                sample: e.sample,
            });
        }

        tables.sort((a, b) => b.length - a.length);

        return {
            stats: {
                nodes: stats.nodes, maxDepth: stats.maxDepth, keysTotal: stats.keysTotal,
                uniqueKeys: stats.uniqueKeys.size, types: stats.types, maxArray: stats.maxArray,
            },
            findings, counts, schema: rows, tables: tables.slice(0, 40),
        };
    }

    /* Busca rutas concretas para los hallazgos basados en patrón */
    function fillSamples(rootValue, needs) {
        const byPattern = new Map();
        needs.forEach((f) => {
            if (!byPattern.has(f.pattern)) byPattern.set(f.pattern, []);
            byPattern.get(f.pattern).push(f);
        });
        let pending = needs.length;
        const segs = [];
        const done = (f) => f.samples.length >= MAX_SAMPLES;

        function walk(v, pattern) {
            if (pending <= 0) return;
            const list = byPattern.get(pattern);
            if (list) {
                for (const f of list) {
                    if (done(f)) continue;
                    let hit = false;
                    if (f.title === 'Valores null' || f.title === 'Campo siempre null') hit = v === null;
                    else if (f.title === 'Tipos de dato mezclados en el mismo campo') hit = true; // se filtra abajo
                    else if (f.title === 'Formatos de fecha mezclados') hit = typeof v === 'string' && /^\d{4}[-/]\d{2}[-/]\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}/.test(v);
                    if (hit) f.samples.push(pathToString(segs));
                    if (done(f)) pending--;
                }
            }
            if (Array.isArray(v)) {
                const p = pattern + '[]';
                for (let i = 0; i < v.length && pending > 0; i++) { segs.push(i); walk(v[i], p); segs.pop(); }
            } else if (v && typeof v === 'object') {
                for (const k of Object.keys(v)) {
                    if (pending <= 0) break;
                    segs.push(k);
                    walk(v[k], pattern + '.' + k);
                    segs.pop();
                }
                // Campos ausentes: la muestra es el objeto que no tiene la clave
                const miss = (byPattern.get(pattern) || []).filter((f) => f.missingKey);
                void miss;
            }
        }

        // Campos ausentes: se procesan aparte (objeto padre sin la clave)
        const missing = needs.filter((f) => f.missingKey);
        missing.forEach((f) => { f.samples = []; });
        const parentOf = (pattern) => pattern.replace(/(\.[^.[\]]+|\[\])$/, '');
        const keyOf = (pattern) => pattern.slice(parentOf(pattern).length + 1);
        const missByParent = new Map();
        missing.forEach((f) => {
            const par = parentOf(f.pattern);
            if (!missByParent.has(par)) missByParent.set(par, []);
            missByParent.get(par).push(f);
        });

        function walkMissing(v, pattern) {
            const list = missByParent.get(pattern);
            if (list && v && typeof v === 'object' && !Array.isArray(v)) {
                for (const f of list) {
                    if (f.samples.length < MAX_SAMPLES && !Object.prototype.hasOwnProperty.call(v, keyOf(f.pattern))) f.samples.push(pathToString(segs));
                }
            }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) { segs.push(i); walkMissing(v[i], pattern + '[]'); segs.pop(); }
            } else if (v && typeof v === 'object') {
                for (const k of Object.keys(v)) { segs.push(k); walkMissing(v[k], pattern + '.' + k); segs.pop(); }
            }
        }

        const nonMissing = needs.filter((f) => !f.missingKey);
        byPattern.clear();
        nonMissing.forEach((f) => {
            if (!byPattern.has(f.pattern)) byPattern.set(f.pattern, []);
            byPattern.get(f.pattern).push(f);
        });
        pending = nonMissing.length;
        walk(rootValue, '$');

        // Tipos mezclados: quedarse con rutas del tipo minoritario
        nonMissing.filter((f) => f.title === 'Tipos de dato mezclados en el mismo campo').forEach((f) => { f.samples = []; });
        if (missing.length) walkMissing(rootValue, '$');
        mixedSamples(rootValue, nonMissing.filter((f) => f.title === 'Tipos de dato mezclados en el mismo campo'));
    }

    function mixedSamples(rootValue, list) {
        if (!list.length) return;
        const map = new Map(list.map((f) => [f.pattern, { f, firstType: null, seen: {} }]));
        const segs = [];
        function walk(v, pattern) {
            const m = map.get(pattern);
            if (m && v !== null) {
                const t = typeOf(v);
                if (m.firstType === null) m.firstType = t;
                if (!m.seen[t]) m.seen[t] = 0;
                // muestra 1 ejemplo por tipo distinto (hasta 5)
                if (m.seen[t] === 0 && m.f.samples.length < MAX_SAMPLES) m.f.samples.push(pathToString(segs));
                m.seen[t]++;
            }
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) { segs.push(i); walk(v[i], pattern + '[]'); segs.pop(); }
            } else if (v && typeof v === 'object') {
                for (const k of Object.keys(v)) { segs.push(k); walk(v[k], pattern + '.' + k); segs.pop(); }
            }
        }
        walk(rootValue, '$');
    }

    /* ------------------------------------------------------------------ */
    /* Comparación                                                         */
    /* ------------------------------------------------------------------ */
    function diff(a, b, limit) {
        limit = limit || 2000;
        const out = [];
        const counts = { added: 0, removed: 0, changed: 0, type: 0 };
        const segs = [];
        const preview = (v) => {
            if (v === undefined) return '';
            const s = JSON.stringify(v);
            return s.length > 120 ? s.slice(0, 120) + '…' : s;
        };
        const emit = (kind, av, bv) => {
            counts[kind]++;
            if (out.length < limit) out.push({ kind, path: pathToString(segs), a: preview(av), b: preview(bv) });
        };

        function walk(x, y) {
            const tx = typeOf(x), ty = typeOf(y);
            if (tx !== ty) { emit('type', x, y); return; }
            if (tx === 'array') {
                const n = Math.max(x.length, y.length);
                for (let i = 0; i < n; i++) {
                    segs.push(i);
                    if (i >= x.length) emit('added', undefined, y[i]);
                    else if (i >= y.length) emit('removed', x[i], undefined);
                    else walk(x[i], y[i]);
                    segs.pop();
                }
            } else if (tx === 'object') {
                const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
                for (const k of keys) {
                    segs.push(k);
                    const inX = Object.prototype.hasOwnProperty.call(x, k);
                    const inY = Object.prototype.hasOwnProperty.call(y, k);
                    if (!inX) emit('added', undefined, y[k]);
                    else if (!inY) emit('removed', x[k], undefined);
                    else walk(x[k], y[k]);
                    segs.pop();
                }
            } else if (x !== y) emit('changed', x, y);
        }
        walk(a, b);
        return { items: out, counts, truncated: out.length < counts.added + counts.removed + counts.changed + counts.type };
    }

    /* ------------------------------------------------------------------ */
    /* Reporte para tickets                                                */
    /* ------------------------------------------------------------------ */
    function report(an, info) {
        const L = [];
        L.push('REPORTE DE ANÁLISIS JSON');
        L.push('========================');
        if (info) {
            L.push(`Tamaño: ${info.sizeLabel} · Forma: ${info.shape}`);
            if (info.notes && info.notes.length) {
                L.push('Ajustes automáticos aplicados:');
                info.notes.forEach((n) => L.push(`  - ${n}`));
            }
        }
        L.push(`Profundidad máx.: ${an.stats.maxDepth} · Nodos: ${an.stats.nodes} · Claves únicas: ${an.stats.uniqueKeys}`);
        L.push(`Hallazgos: ${an.counts.error} errores, ${an.counts.warn} avisos, ${an.counts.info} informativos`);
        L.push('');
        const labels = { error: 'ERROR', warn: 'AVISO', info: 'INFO' };
        an.findings.forEach((f, i) => {
            const ratio = f.total ? ` (${f.count}/${f.total})` : f.count > 1 ? ` (${f.count})` : '';
            L.push(`${i + 1}. [${labels[f.sev]}] ${f.title}${ratio}`);
            L.push(`   Campo: ${f.pattern}`);
            L.push(`   ${f.detail}`);
            if (f.samples.length) L.push(`   Ejemplos: ${f.samples.join(', ')}`);
            L.push('');
        });
        if (!an.findings.length) L.push('Sin hallazgos.');
        return L.join('\n');
    }

    JT.analyze = analyze;
    JT.diff = diff;
    JT.report = report;
    JT.typeOf = typeOf;
})(typeof window !== 'undefined' ? window : globalThis);