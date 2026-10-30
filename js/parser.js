'use strict';

/**
 * Parser tolerante de JSON para Soporte.
 *  - Limpia prefijos/sufijos típicos (p. ej. "[REST] aux_json=", fences ```json, doble serialización).
 *  - Reporta errores con línea/columna, contexto y pista de qué pudo pasar.
 *  - Detecta claves duplicadas y enteros que pierden precisión.
 *  - Intenta reparar los errores más comunes.
 */
(function (root) {
    const JT = (root.JT = root.JT || {});

    class JsonParseError extends Error {
        constructor(message, pos, hint) {
            super(message);
            this.pos = pos;
            this.hint = hint || null;
        }
    }

    const IDENT = /^[A-Za-z_$][\w$]*$/;

    function pathToString(segs) {
        let s = '$';
        for (const seg of segs) {
            if (typeof seg === 'number') s += `[${seg}]`;
            else if (IDENT.test(seg)) s += '.' + seg;
            else s += `[${JSON.stringify(seg)}]`;
        }
        return s;
    }

    function lineCol(text, pos) {
        let line = 1;
        let last = -1;
        for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
            line++;
            last = i;
        }
        return { line, col: pos - last };
    }

    /* ------------------------------------------------------------------ */
    /* Parser estricto con posiciones                                      */
    /* ------------------------------------------------------------------ */
    function parseAt(text, start) {
        const n = text.length;
        let i = start;
        const path = [];
        const open = [];
        const issues = { duplicateKeys: [], bigNumbers: [] };
        const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
        const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

        const fail = (msg, pos, hint) => {
            throw new JsonParseError(msg, pos === undefined ? i : pos, hint);
        };

        const describe = (c) => (c === '\n' ? 'un salto de línea' : `"${c}"`);

        function eof(expected) {
            let hint = null;
            if (open.length) {
                const last = open[open.length - 1];
                hint = `Quedan ${open.length} estructura(s) sin cerrar; el texto parece truncado (copia incompleta, límite de longitud de un log, etc.). La última abierta es "${last.ch}" en la línea ${lineCol(text, last.pos).line}.`;
            }
            fail(`Fin inesperado del texto: se esperaba ${expected}`, n, hint);
        }

        function ws() {
            for (; ;) {
                const c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) i++;
                else if (c === 47) {
                    const nx = text[i + 1];
                    if (nx === '/' || nx === '*') {
                        fail('Comentario dentro del JSON', i, 'JSON estándar no admite comentarios (// o /* */). Elimínalos.');
                    }
                    return;
                } else return;
            }
        }

        function value() {
            ws();
            if (i >= n) eof('un valor');
            const c = text[i];
            if (c === '{') return object();
            if (c === '[') return array();
            if (c === '"') return string();
            if (c === '-' || (c >= '0' && c <= '9')) return number();

            const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 24));
            if (word) {
                const w = word[0];
                if (w === 'true') { i += 4; return true; }
                if (w === 'false') { i += 5; return false; }
                if (w === 'null') { i += 4; return null; }
                if (w === 'undefined' || w === 'NaN' || w === 'Infinity') {
                    fail(`Valor no válido en JSON: ${w}`, i, `"${w}" no existe en JSON; debió serializarse como null o como texto.`);
                }
                if (w === 'True' || w === 'False' || w === 'None') {
                    fail(`Valor de Python en JSON: ${w}`, i, 'Parece salida de Python (print/repr). Usa true / false / null.');
                }
                fail(`Texto sin comillas: ${w}`, i, 'Las cadenas deben ir entre comillas dobles. ¿Es un prefijo/sufijo adjunto al JSON o falta un valor?');
            }
            if (c === "'") fail('Cadena con comillas simples', i, 'JSON exige comillas dobles (") en las cadenas.');
            if (c === '}' || c === ']' || c === ',' || c === ':') {
                let b = i - 1;
                while (b >= start && /\s/.test(text[b])) b--;
                if (text[b] === ':' && c !== ':') {
                    const k = path.length ? path[path.length - 1] : null;
                    fail(`Valor vacío${typeof k === 'string' ? ` en la clave "${k}"` : ''}`, i,
                        'Después de ":" no viene ningún valor (por ejemplo "valor": ,). El sistema de origen no envió el dato: debería ser un valor o null.');
                }
                fail(`Se esperaba un valor pero se encontró ${describe(c)}`, i, 'Falta un valor, o sobra una coma / dos puntos.');
            }
            fail(`Carácter inesperado ${describe(c)}`, i);
        }

        function number() {
            NUM.lastIndex = i;
            const m = NUM.exec(text);
            if (!m) fail('Número mal formado', i);
            const raw = m[0];
            const after = text[i + raw.length];
            if (after !== undefined && /[\w.]/.test(after)) {
                if (/^-?0$/.test(raw) && /\d/.test(after)) fail('Número con ceros a la izquierda', i, 'JSON no admite ceros a la izquierda (007). Si es un código, debe ir como texto: "007".');
                fail('Número mal formado', i, 'Revisa el valor: puede tener un punto decimal incompleto, letras pegadas o más de un punto.');
            }
            if (!/[.eE]/.test(raw) && !Number.isSafeInteger(Number(raw))) {
                issues.bigNumbers.push({ path: pathToString(path), raw });
            }
            i += raw.length;
            return Number(raw);
        }

        function string() {
            const startPos = i;
            i++;
            let out = '';
            let seg = i;
            for (; ;) {
                if (i >= n) {
                    fail('Cadena sin cerrar', startPos, 'Falta la comilla de cierre ("). El texto puede estar truncado o una comilla interna no está escapada (\\").');
                }
                const c = text.charCodeAt(i);
                if (c === 34) {
                    out += text.slice(seg, i);
                    i++;
                    return out;
                }
                if (c === 92) {
                    out += text.slice(seg, i);
                    const e = text[i + 1];
                    if (e === 'u') {
                        const hex = text.substr(i + 2, 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Secuencia \\u inválida', i, 'Después de \\u deben ir exactamente 4 dígitos hexadecimales.');
                        out += String.fromCharCode(parseInt(hex, 16));
                        i += 6;
                    } else if (e !== undefined && Object.prototype.hasOwnProperty.call(ESC, e)) {
                        out += ESC[e];
                        i += 2;
                    } else {
                        fail(`Escape inválido "\\${e === undefined ? '' : e}"`, i, 'Las barras invertidas deben duplicarse (\\\\) salvo en \\" \\n \\t \\r \\b \\f \\/ \\uXXXX. Típico en rutas de Windows.');
                    }
                    seg = i;
                    continue;
                }
                if (c < 32) {
                    fail(c === 10 || c === 13 ? 'Salto de línea dentro de una cadena' : 'Carácter de control sin escapar dentro de una cadena', i,
                        'Dentro de un texto los saltos de línea deben escribirse como \\n.');
                }
                i++;
            }
        }

        function sepError(close) {
            const c = text[i];
            if (c === '}' || c === ']') {
                fail(`Cierre incorrecto: se esperaba "${close}" pero hay "${c}"`, i, 'Hay llaves y corchetes mezclados o mal anidados. Revisa qué estructura quedó abierta.');
            }
            const hint = /["{[\d-]/.test(c)
                ? 'Falta una coma entre dos elementos.'
                : 'Si el texto anterior contenía comillas dobles internas, deben escaparse como \\".';
            fail(`Se esperaba "," o "${close}" pero se encontró ${describe(c)}`, i, hint);
        }

        function object() {
            open.push({ ch: '{', pos: i });
            i++;
            const obj = Object.create(null);
            const seen = new Set();
            ws();
            if (text[i] === '}') { i++; open.pop(); return obj; }
            let comma = -1;
            for (; ;) {
                ws();
                if (i >= n) eof('una clave o "}"');
                const c = text[i];
                if (c !== '"') {
                    if (c === '}' && comma >= 0) fail('Coma sobrante antes de "}"', comma, 'Elimina la última coma (trailing comma).');
                    if (c === "'") fail('Clave con comillas simples', i, 'Las claves deben ir entre comillas dobles (").');
                    if (c === ',') fail('Coma doble o elemento vacío', i, 'Hay dos comas seguidas o una coma al inicio.');
                    const w = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40));
                    if (w) fail(`Clave sin comillas: ${w[0]}`, i, 'Las claves deben ir entre comillas dobles. Parece un objeto de JavaScript, no JSON.');
                    fail(`Se esperaba una clave entre comillas pero se encontró ${describe(c)}`, i);
                }
                const keyPos = i;
                const key = string();
                ws();
                if (i >= n) eof('":"');
                if (text[i] !== ':') fail(`Falta ":" después de la clave "${key}"`, i);
                i++;
                if (seen.has(key)) issues.duplicateKeys.push({ path: pathToString(path.concat(key)), key, pos: keyPos });
                seen.add(key);
                path.push(key);
                const v = value();
                path.pop();
                obj[key] = v;
                ws();
                if (i >= n) eof('"," o "}"');
                const d = text[i];
                if (d === ',') { comma = i; i++; continue; }
                if (d === '}') { i++; open.pop(); return obj; }
                sepError('}');
            }
        }

        function array() {
            open.push({ ch: '[', pos: i });
            i++;
            const arr = [];
            ws();
            if (text[i] === ']') { i++; open.pop(); return arr; }
            let comma = -1;
            for (; ;) {
                ws();
                if (i >= n) eof('un valor o "]"');
                const c = text[i];
                if (c === ']' && comma >= 0) fail('Coma sobrante antes de "]"', comma, 'Elimina la última coma (trailing comma).');
                if (c === ',') fail('Coma doble o elemento vacío', i, 'Hay dos comas seguidas o una coma al inicio.');
                path.push(arr.length);
                arr.push(value());
                path.pop();
                ws();
                if (i >= n) eof('"," o "]"');
                const d = text[i];
                if (d === ',') { comma = i; i++; continue; }
                if (d === ']') { i++; open.pop(); return arr; }
                sepError(']');
            }
        }

        const v = value();
        return { value: v, end: i, issues };
    }

    function attempt(text, start) {
        try {
            return { ok: true, r: parseAt(text, start), start };
        } catch (e) {
            if (e instanceof JsonParseError) return { ok: false, e, start };
            if (e instanceof RangeError) {
                return { ok: false, e: new JsonParseError('Anidación demasiado profunda', start, 'El JSON tiene una profundidad que el navegador no puede procesar.'), start };
            }
            throw e;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Contexto del error                                                  */
    /* ------------------------------------------------------------------ */
    function errorContext(text, pos) {
        const lines = text.split('\n');
        const { line, col } = lineCol(text, pos);
        const from = Math.max(1, line - 2);
        const to = Math.min(lines.length, line + 2);
        const out = [];
        for (let ln = from; ln <= to; ln++) {
            let t = lines[ln - 1].replace(/\r$/, '');
            let caret = null;
            if (ln === line) caret = Math.max(0, col - 1);
            if (t.length > 160) {
                const center = ln === line ? col - 1 : 0;
                const s = Math.max(0, center - 80);
                const e = Math.min(t.length, center + 80);
                t = (s > 0 ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : '');
                if (caret !== null) caret = caret - s + (s > 0 ? 1 : 0);
            }
            out.push({ no: ln, text: t, caret, isErr: ln === line });
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* Limpieza + parseo inteligente                                       */
    /* ------------------------------------------------------------------ */
    function snippet(s, max) {
        const t = s.replace(/\s+/g, ' ').trim();
        return t.length > max ? t.slice(0, max) + '…' : t;
    }

    function parseSmart(raw) {
        const notes = [];
        let text = String(raw);

        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
            notes.push('Se eliminó el BOM inicial del archivo.');
        }

        const fence = /^\s*```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/.exec(text);
        if (fence) {
            text = fence[1];
            notes.push('Se quitó el bloque de código Markdown (```).');
        }

        if (/^\s*%(7B|5B|22)/i.test(text)) {
            try {
                text = decodeURIComponent(text.trim());
                notes.push('El contenido venía codificado como URL (%7B…); se decodificó.');
            } catch (_) { /* se deja tal cual */ }
        }

        // Doble serialización: el JSON viene como una cadena JSON
        for (let k = 0; k < 3; k++) {
            const t = text.trim();
            if (t[0] !== '"') break;
            const a = attempt(t, 0);
            if (!a.ok || typeof a.r.value !== 'string') break;
            const inner = a.r.value.trim();
            if (inner[0] !== '{' && inner[0] !== '[' && inner[0] !== '"') break;
            text = inner;
            notes.push('El JSON venía serializado como una cadena de texto (doble serialización); se desempaquetó.');
        }

        const first = text.search(/\S/);
        if (first === -1) {
            return { ok: false, text, start: 0, notes, error: { message: 'El texto está vacío', hint: null, pos: 0, line: 1, col: 1, context: [] } };
        }

        const finish = (a, extraNote) => {
            const { r, start } = a;
            const trailing = text.slice(r.end);
            const notes2 = notes.slice();
            if (start > first) notes2.push(`Se ignoró el prefijo: "${snippet(text.slice(first, start), 70)}"`);
            if (extraNote) notes2.push(extraNote);
            let end = r.end;
            if (trailing.trim()) notes2.push(`Se ignoró texto sobrante al final: "${snippet(trailing, 70)}"`);
            return { ok: true, value: r.value, text, start, end, notes: notes2, issues: r.issues };
        };

        const isContainer = (v) => v !== null && typeof v === 'object';
        const a0 = attempt(text, first);

        if (a0.ok) {
            const trailing = text.slice(a0.r.end).trim();
            if (!trailing || isContainer(a0.r.value)) return finish(a0);
        }

        // Buscar un inicio válido más adelante (prefijo tipo "[REST] aux_json=")
        const failures = [];
        if (!a0.ok) failures.push(a0);
        let skipUntil = a0.ok ? first : a0.e.pos;
        const re = /[{[]/g;
        re.lastIndex = first + 1;
        let m;
        let tries = 0;
        const a0Real = !a0.ok && (a0.e.pos - a0.start >= 12 || /"\s*:/.test(text.slice(a0.start, a0.e.pos)));
        while (!a0Real && (m = re.exec(text)) && tries < 60) {
            if (m.index <= skipUntil) continue;
            tries++;
            const a = attempt(text, m.index);
            if (a.ok) {
                if (isContainer(a.r.value)) return finish(a);
            } else {
                failures.push(a);
                // Un intento que avanzó bastante o ya tenía forma de objeto ("clave":) es el JSON real
                // con un error; lo que venga después no es un nuevo inicio sino parte de él.
                if (a.e.pos - a.start >= 12 || /"\s*:/.test(text.slice(a.start, a.e.pos))) break;
                skipUntil = Math.max(skipUntil, a.e.pos);
            }
        }

        if (a0.ok) return finish(a0); // valor primitivo con texto después

        const best = failures.reduce((b, f) => (f.e.pos - f.start > b.e.pos - b.start ? f : b), failures[0]);
        const { line, col } = lineCol(text, best.e.pos);
        const errNotes = notes.slice();
        if (best.start > first) errNotes.push(`Se ignoró el prefijo: "${snippet(text.slice(first, best.start), 70)}"`);
        return {
            ok: false,
            text,
            start: best.start,
            notes: errNotes,
            error: {
                message: best.e.message,
                hint: best.e.hint,
                pos: best.e.pos,
                line,
                col,
                context: errorContext(text, best.e.pos),
            },
        };
    }

    /* ------------------------------------------------------------------ */
    /* Reparación de errores comunes                                       */
    /* ------------------------------------------------------------------ */
    function repair(text, start) {
        const src = text.slice(start || 0);
        const n = src.length;
        const changes = {};
        const add = (k) => { changes[k] = (changes[k] || 0) + 1; };
        let out = '';
        let i = 0;
        let last = 'o'; // 'v' = acaba de cerrarse un valor, 'o' = otro
        const stack = [];

        const needComma = () => {
            if (last === 'v' && stack.length) { out += ','; add('Comas faltantes añadidas'); }
        };

        while (i < n) {
            const c = src[i];

            if (c === '"' || c === "'") {
                needComma();
                const q = c;
                let j = i + 1;
                let s = '';
                while (j < n && src[j] !== q) {
                    const ch = src[j];
                    if (ch === '\\') {
                        const nx = src[j + 1];
                        if (nx === "'") { s += "'"; j += 2; continue; }
                        if (nx === undefined) { j++; continue; }
                        if (/["\\/bfnrtu]/.test(nx)) { s += ch + nx; j += 2; continue; }
                        s += '\\\\'; // barra suelta: se duplica
                        add('Barras invertidas sin escapar corregidas');
                        j++;
                        continue;
                    }
                    if (ch === '\n') { s += '\\n'; add('Saltos de línea dentro de cadenas escapados'); }
                    else if (ch === '\r') { /* se descarta */ }
                    else if (ch === '\t') s += '\\t';
                    else if (ch.charCodeAt(0) < 32) s += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
                    else if (ch === '"' && q === "'") s += '\\"';
                    else s += ch;
                    j++;
                }
                if (q === "'") add('Comillas simples convertidas a dobles');
                if (j >= n) add('Cadena sin cerrar completada');
                out += '"' + s + '"';
                i = j + 1;
                last = 'v';
                continue;
            }

            if (c === '/' && src[i + 1] === '/') {
                while (i < n && src[i] !== '\n') i++;
                add('Comentarios eliminados');
                continue;
            }
            if (c === '/' && src[i + 1] === '*') {
                const e = src.indexOf('*/', i + 2);
                i = e === -1 ? n : e + 2;
                add('Comentarios eliminados');
                continue;
            }

            if (c === '{' || c === '[') {
                needComma();
                stack.push(c === '{' ? '}' : ']');
                out += c;
                i++;
                last = 'o';
                continue;
            }
            if (c === '}' || c === ']') {
                if (/,\s*$/.test(out)) { out = out.replace(/,(\s*)$/, '$1'); add('Comas sobrantes eliminadas'); }
                if (/:\s*$/.test(out)) { out += 'null'; add('Valores faltantes completados con null'); }
                if (stack.length) {
                    const expected = stack.pop();
                    if (expected !== c) add('Cierres mal emparejados corregidos');
                    out += expected;
                } else {
                    add('Cierres sobrantes eliminados');
                }
                i++;
                last = 'v';
                continue;
            }
            if (c === ',' || c === ':') {
                if (c === ',' && last !== 'v') { i++; add('Comas dobles eliminadas'); continue; }
                out += c;
                i++;
                last = 'o';
                continue;
            }
            if (/\s/.test(c)) { out += c; i++; continue; }

            if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') {
                needComma();
                const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 60));
                if (m) {
                    let num = m[0];
                    if (num[0] === '+') { num = num.slice(1); add('Signo + eliminado de números'); }
                    if (num[0] === '.') { num = '0' + num; add('Decimales sin cero inicial corregidos'); }
                    if (/\.$/.test(num)) { num = num.slice(0, -1); add('Decimales incompletos corregidos'); }
                    if (/^-?0\d/.test(num)) { out += '"' + num + '"'; add('Números con ceros a la izquierda convertidos a texto'); }
                    else out += num;
                    i += m[0].length;
                    last = 'v';
                    continue;
                }
                i++;
                add('Caracteres inválidos eliminados');
                continue;
            }

            const w = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
            if (w) {
                needComma();
                const word = w[0];
                const map = { true: 'true', false: 'false', null: 'null', True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null', Infinity: 'null' };
                if (Object.prototype.hasOwnProperty.call(map, word)) {
                    out += map[word];
                    if (!/^(true|false|null)$/.test(word)) add('Valores no JSON (undefined, NaN, True, None…) convertidos');
                } else {
                    out += JSON.stringify(word);
                    const rest = src.slice(i + word.length);
                    add(/^\s*:/.test(rest) ? 'Claves sin comillas entrecomilladas' : 'Textos sin comillas entrecomillados');
                }
                i += word.length;
                last = 'v';
                continue;
            }

            i++;
            add('Caracteres inválidos eliminados');
        }

        if (stack.length) {
            if (/,\s*$/.test(out)) out = out.replace(/,(\s*)$/, '$1');
            if (/:\s*$/.test(out)) { out += 'null'; add('Valores faltantes completados con null'); }
            // clave suelta sin ":" al final (texto truncado)
            if (stack[stack.length - 1] === '}' && /[{,]\s*"(?:[^"\\]|\\.)*"\s*$/.test(out)) {
                out = out.replace(/(,?)\s*"(?:[^"\\]|\\.)*"\s*$/, '');
                if (/,\s*$/.test(out)) out = out.replace(/,(\s*)$/, '$1');
                add('Clave incompleta al final eliminada');
            }
            out += stack.reverse().join('');
            add(`JSON truncado: se cerraron ${stack.length} estructura(s)`);
        }

        const list = Object.entries(changes).map(([label, count]) => ({ label, count }));
        const a = attempt(out, 0);
        return { text: out, changes: list, valid: a.ok && out.trim().length > 0 };
    }

    JT.JsonParseError = JsonParseError;
    JT.pathToString = pathToString;
    JT.lineCol = lineCol;
    JT.parseAt = parseAt;
    JT.parseSmart = parseSmart;
    JT.repair = repair;
})(typeof window !== 'undefined' ? window : globalThis);