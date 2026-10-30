'use strict';

/**
 * Analizador JSON · Soporte
 * Interfaz: entrada, errores con contexto, análisis, tabla, árbol, búsqueda,
 * texto y comparación. Depende de js/parser.js y js/analyzer.js.
 */
(function () {
    const JT = window.JT;
    const { pathToString } = JT;

    /* ------------------------------------------------------------------ */
    /* Referencias al DOM                                                  */
    /* ------------------------------------------------------------------ */
    const $ = (sel) => document.querySelector(sel);

    const dom = {
        input: $('#jsonInput'),
        output: $('#output'),
        shapeBadge: $('#shapeBadge'),
        inputAcc: $('#inputAcc'),
        notice: $('#notice'),
        errorPanel: $('#errorPanel'),
        workspace: $('#workspace'),
        emptyState: $('#emptyState'),
        tabs: $('#tabs'),
        tabFindings: $('#tabFindings'),
        filterInput: $('#filterInput'),
        btnRender: $('#btnRender'),
        btnExample: $('#btnExample'),
        btnClear: $('#btnClear'),
        btnCsv: $('#btnCsv'),
        flattenCsv: $('#flattenCsv'),
        flattenWrap: $('#flattenWrap'),
        fileInput: $('#fileInput'),
        tableSource: $('#tableSource'),
        tableInfo: $('#tableInfo'),
        treeRoot: $('#treeRoot'),
        treeExpand: $('#treeExpand'),
        treeCollapse: $('#treeCollapse'),
        searchInput: $('#searchInput'),
        searchScope: $('#searchScope'),
        searchCase: $('#searchCase'),
        searchExact: $('#searchExact'),
        searchRegex: $('#searchRegex'),
        searchInfo: $('#searchInfo'),
        searchResults: $('#searchResults'),
        textMode: $('#textMode'),
        textSort: $('#textSort'),
        textOut: $('#textOut'),
        textWarn: $('#textWarn'),
        btnCopyText: $('#btnCopyText'),
        btnDownloadText: $('#btnDownloadText'),
        compareInput: $('#compareInput'),
        compareResults: $('#compareResults'),
        btnCompare: $('#btnCompare'),
        btnSwap: $('#btnSwap'),
    };

    /* ------------------------------------------------------------------ */
    /* Estado                                                              */
    /* ------------------------------------------------------------------ */
    const state = {
        parse: null,
        root: null,
        jsonText: '',
        analysis: null,
        info: null,
        activeTab: 'analysis',
        built: { table: false, tree: false, text: false },
        table: null,
        rows: [],
        fFilter: { sev: 'all', q: '' },
        extraNotes: [],
        repairText: null,
    };

    // Límites defensivos: protegen la pestaña de entradas gigantes o patrones costosos
    const LIMITS = {
        SOFT_CHARS: 10e6,      // pide confirmación
        HARD_CHARS: 50e6,      // se rechaza
        REGEX_LEN: 200,        // longitud máxima de una regex de búsqueda
        REGEX_TEXT: 2000,      // caracteres máximos evaluados por valor al usar regex
        SEARCH_MS: 3000,       // tiempo máximo de una búsqueda
    };

    const SAMPLE_PREFIX = '[REST] aux_json=';
    const EXAMPLE_DATA = {
        ok: true,
        generado: '2026-10-29T08:15:00Z',
        clientes: [
            { id: 1, nombre: 'Ana Vargas', activo: true, saldo: 12500.5, telefono: '8888-1234', email: 'ana@correo.com', registro: '2026-01-15', etiquetas: ['frontend', 'diseño'], contacto: { canal: 'email', intentos: 2 } },
            { id: 2, nombre: 'Luis Mora ', activo: 'false', saldo: '8300', telefono: null, email: 'luis@correo', registro: '15/03/2026', etiquetas: [], contacto: { canal: 'tel', intentos: 0 } },
            { id: 3, nombre: 'Karla RÃ­os', activo: true, saldo: 0.30000000000000004, telefono: '8888-9090', email: 'karla@correo.com', registro: '2026-02-30', etiquetas: ['sql'], contacto: null },
            { id: 3, nombre: 'Pedro Solís', activo: true, saldo: 2100, telefono: 'N/A', registro: '2026-04-02T10:30:00Z', etiquetas: ['devops'], contacto: { canal: 'email', intentos: 1 } },
            { id: 5, nombre: 'María Jiménez', activo: false, saldo: null, telefono: '8777-4545', email: 'maria@correo.com', registro: '2026-05-20', etiquetas: ['qa'], contacto: { canal: 'email', intentos: 3 }, detalle: '{"origen":"web","campania":"otoño"}' },
        ],
        paginacion: { pagina: 1, total: 5, siguiente: null },
    };

    /* ------------------------------------------------------------------ */
    /* Utilidades                                                          */
    /* ------------------------------------------------------------------ */
    const escapeHtml = (str) =>
        String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

    const inferType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const isPrimitive = (v) => v === null || typeof v !== 'object';
    const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isArrayOfObjects = (arr) => arr.length > 0 && arr.every(isPlainObj);
    const unionCols = (arr) => {
        const set = new Set();
        arr.forEach((o) => Object.keys(o).forEach((k) => set.add(k)));
        return Array.from(set);
    };

    function formatBytes(n) {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    const PATH_TOKEN = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/y;
    function parsePath(p) {
        const segs = [];
        PATH_TOKEN.lastIndex = 1;
        let m;
        while (PATH_TOKEN.lastIndex < p.length && (m = PATH_TOKEN.exec(p))) {
            if (m[1] !== undefined) segs.push(m[1]);
            else if (m[2] !== undefined) segs.push(Number(m[2]));
            else segs.push(JSON.parse(m[3]));
        }
        return segs;
    }

    function getBySegs(root, segs) {
        let v = root;
        for (const s of segs) {
            if (v === null || typeof v !== 'object') return undefined;
            v = v[s];
        }
        return v;
    }

    function toast(msg) {
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
    }

    function copyText(text, label) {
        const done = () => toast(label || 'Copiado');
        if (navigator.clipboard && window.isSecureContext !== false) {
            navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
        } else fallbackCopy(text, done);
    }
    function fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (_) { toast('No se pudo copiar'); }
        ta.remove();
    }

    function download(name, text, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ------------------------------------------------------------------ */
    /* Renderizado de valores y tablas anidadas                            */
    /* ------------------------------------------------------------------ */
    const VALUE_RENDERERS = {
        string: (v) => {
            if (v.length > 300) return `<span class="val val-string" title="${escapeHtml(v.slice(0, 2000))}">"${escapeHtml(v.slice(0, 300))}…" <span class="muted">(${v.length} car.)</span></span>`;
            return `<span class="val val-string">"${escapeHtml(v)}"</span>`;
        },
        number: (v) => `<span class="val val-number">${v}</span>`,
        boolean: (v) => `<span class="val val-boolean">${v}</span>`,
        null: () => `<span class="val val-null">null</span>`,
    };

    const renderPrimitive = (v) => {
        const renderer = VALUE_RENDERERS[inferType(v)];
        return renderer ? renderer(v) : escapeHtml(String(v));
    };

    const renderCell = (v, depth) => (isPrimitive(v) ? renderPrimitive(v) : wrapCollapsible(v, depth + 1));

    function wrapCollapsible(value, depth) {
        const summary = Array.isArray(value)
            ? `[ ] arreglo · ${value.length} elem.`
            : `{ } objeto · ${Object.keys(value).length} claves`;
        return `<details class="nested"><summary>${summary}</summary>${renderNode(value, depth)}</details>`;
    }

    /** top = { entries:[{obj,idx}], cols, sortCol, sortDir } para la tabla principal. */
    function renderTableFromObjects(arr, depth, top) {
        const entries = top ? top.entries : arr.map((obj, idx) => ({ obj, idx }));
        const cols = top ? top.cols : unionCols(arr);

        const head = `<th class="idx-col">#</th>` + cols.map((c) => {
            if (!top) return `<th>${escapeHtml(c)}</th>`;
            const arrow = top.sortCol === c ? (top.sortDir > 0 ? '▲' : '▼') : '';
            return `<th class="sortable" data-col="${escapeHtml(c)}" title="Clic para ordenar">${escapeHtml(c)}<span class="arrow">${arrow}</span></th>`;
        }).join('');

        const body = entries.map(({ obj, idx }) => {
            const cells = cols.map((c) => {
                if (!Object.prototype.hasOwnProperty.call(obj, c)) return `<td class="cell empty-cell">—</td>`;
                const v = obj[c];
                const cls = top && (v === null || v === '') ? 'cell cell-null' : 'cell';
                return `<td class="${cls}">${renderCell(v, depth)}</td>`;
            }).join('');
            return `<tr><td class="idx-col">${idx}</td>${cells}</tr>`;
        }).join('');

        return `<div class="table-wrap table-container${top ? ' tall' : ''} depth-${Math.min(depth, 4)}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    function renderKeyValueTable(obj, depth) {
        const rows = Object.entries(obj)
            .map(([k, v]) => `<tr><th class="key-col">${escapeHtml(k)}</th><td class="cell">${renderCell(v, depth)}</td></tr>`)
            .join('');
        return `<div class="table-wrap table-container depth-${Math.min(depth, 4)}"><table class="kv-table"><tbody>${rows}</tbody></table></div>`;
    }

    function renderList(arr, depth) {
        const rows = arr
            .map((v, i) => `<tr><td class="idx-col">${i}</td><td class="cell">${renderCell(v, depth)}</td></tr>`)
            .join('');
        return `<div class="table-wrap table-container depth-${Math.min(depth, 4)}"><table class="list-table"><tbody>${rows}</tbody></table></div>`;
    }

    function renderNode(value, depth) {
        const t = inferType(value);
        if (t === 'array') {
            if (value.length === 0) return `<span class="empty">[ ] arreglo vacío</span>`;
            return isArrayOfObjects(value) ? renderTableFromObjects(value, depth) : renderList(value, depth);
        }
        if (t === 'object') {
            if (Object.keys(value).length === 0) return `<span class="empty">{ } objeto vacío</span>`;
            return renderKeyValueTable(value, depth);
        }
        return `<div class="table-wrap"><table><tbody><tr><td class="cell">${renderPrimitive(value)}</td></tr></tbody></table></div>`;
    }

    function describeShape(root) {
        const t = inferType(root);
        if (t === 'array') {
            let extra = '';
            if (root.length && isArrayOfObjects(root)) extra = ` · <b>${unionCols(root).length}</b> columnas`;
            return `arreglo · <b>${root.length}</b> elementos${extra}`;
        }
        if (t === 'object') return `objeto · <b>${Object.keys(root).length}</b> claves`;
        return `valor primitivo · <b>${t}</b>`;
    }

    /* ------------------------------------------------------------------ */
    /* Pestañas                                                            */
    /* ------------------------------------------------------------------ */
    function switchTab(name) {
        state.activeTab = name;
        dom.tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
        if (name === 'table' && !state.built.table) { setupTable(); state.built.table = true; }
        if (name === 'tree' && !state.built.tree) { buildTree(); state.built.tree = true; }
        if (name === 'text' && !state.built.text) { refreshText(); state.built.text = true; }
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Análisis                                                   */
    /* ------------------------------------------------------------------ */
    const TYPE_COLORS = { string: '#5ec8be', number: '#7fa3f2', boolean: '#d98fca', null: '#6b7280', object: '#e8a33d', array: '#b9a3f0' };
    const TYPE_LABELS = { string: 'texto', number: 'número', boolean: 'booleano', null: 'null', object: 'objeto', array: 'arreglo' };
    const SEV_LABELS = { error: 'Error', warn: 'Aviso', info: 'Info' };

    function renderAnalysis() {
        const an = state.analysis;
        const s = an.stats;
        const total = Object.values(s.types).reduce((a, b) => a + b, 0) || 1;
        const bar = Object.entries(s.types).filter(([, n]) => n > 0)
            .map(([t, n]) => `<i style="width:${(n / total) * 100}%;background:${TYPE_COLORS[t]}" title="${TYPE_LABELS[t]}: ${n}"></i>`).join('');
        const legend = Object.entries(s.types).filter(([, n]) => n > 0)
            .map(([t, n]) => `<span><b style="background:${TYPE_COLORS[t]}"></b>${TYPE_LABELS[t]} ${n.toLocaleString('es')}</span>`).join('');

        const cards = `
            <div class="cards">
                <div class="card"><div class="k">Tamaño</div><div class="v">${state.info.sizeLabel}</div></div>
                <div class="card"><div class="k">Nodos</div><div class="v">${s.nodes.toLocaleString('es')}</div></div>
                <div class="card"><div class="k">Profundidad</div><div class="v">${s.maxDepth}</div></div>
                <div class="card"><div class="k">Claves únicas</div><div class="v">${s.uniqueKeys.toLocaleString('es')}</div></div>
                <div class="card"><div class="k">Hallazgos</div><div class="v">${an.counts.error} / ${an.counts.warn} / ${an.counts.info}</div><div class="muted small">errores / avisos / info</div></div>
            </div>
            <div class="card" style="margin-bottom:18px"><div class="k">Composición por tipo</div><div class="type-bar">${bar}</div><div class="legend">${legend}</div></div>`;

        const toolbar = `
            <div class="f-toolbar">
                <button class="chip" data-sev="all">Todos (${an.findings.length})</button>
                <button class="chip" data-sev="error">Errores (${an.counts.error})</button>
                <button class="chip" data-sev="warn">Avisos (${an.counts.warn})</button>
                <button class="chip" data-sev="info">Info (${an.counts.info})</button>
                <div class="search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
                <input type="text" id="fFilterInput" placeholder="Filtrar hallazgos…"></div>
                <button id="btnReport" style="margin-left:auto">Copiar reporte para ticket</button>
            </div>`;

        const schema = `
            <details class="schema" id="schemaBox">
                <summary>Esquema inferido (${an.schema.length.toLocaleString('es')} rutas)</summary>
                <div class="schema-body">
                    <div class="toolbar"><div class="search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
                    <input type="text" id="schemaFilter" placeholder="Filtrar rutas…"></div></div>
                    <div id="schemaOut"></div>
                </div>
            </details>`;

        const panel = $('#panel-analysis');
        panel.innerHTML = cards + toolbar + `<div class="f-list" id="fList"></div>` + schema;
        state.fFilter = { sev: 'all', q: '' };
        renderFindings();
        dom.tabFindings.textContent = an.counts.error + an.counts.warn > 0 ? String(an.counts.error + an.counts.warn) : '';
        dom.tabFindings.title = 'Errores + avisos';
    }

    function findingHtml(f) {
        const pct = f.total ? ` · ${Math.round((f.count / f.total) * 100)}%` : '';
        const ratio = f.total ? `${f.count.toLocaleString('es')} / ${f.total.toLocaleString('es')}${pct}` : f.count > 1 ? `×${f.count.toLocaleString('es')}` : '';
        const chips = f.samples.map((p) => `<button class="path-chip" data-path="${escapeHtml(p)}" title="Ver en el árbol">${escapeHtml(p)}</button>`).join('');
        const embed = f.flagName === 'embedded' && f.samples[0]
            ? `<button class="mini" data-act="embed" data-path="${escapeHtml(f.samples[0])}">Analizar contenido</button>` : '';
        return `
            <div class="finding ${f.sev}">
                <div class="head"><span class="sev">${SEV_LABELS[f.sev]}</span><span class="title">${escapeHtml(f.title)}</span><span class="ratio">${ratio}</span></div>
                <div class="pat">${escapeHtml(f.pattern)}</div>
                <div class="detail">${escapeHtml(f.detail)}</div>
                ${chips || embed ? `<div class="samples">${f.samples.length ? '<span class="muted small">Ejemplos:</span>' : ''}${chips}${embed}</div>` : ''}
            </div>`;
    }

    function renderFindings() {
        const an = state.analysis;
        const { sev, q } = state.fFilter;
        const ql = q.trim().toLowerCase();
        const list = an.findings.filter((f) =>
            (sev === 'all' || f.sev === sev) &&
            (!ql || (f.title + ' ' + f.pattern + ' ' + f.detail).toLowerCase().includes(ql)));
        const box = $('#fList');
        if (!an.findings.length) {
            box.innerHTML = `<div class="all-ok">✔ No se detectaron problemas de calidad en los datos. La estructura es consistente.</div>`;
        } else if (!list.length) {
            box.innerHTML = `<div class="empty-state">Ningún hallazgo coincide con el filtro.</div>`;
        } else {
            box.innerHTML = list.map(findingHtml).join('');
        }
        document.querySelectorAll('.f-toolbar .chip').forEach((c) => c.classList.toggle('on', c.dataset.sev === sev));
    }

    function renderSchema(q) {
        const ql = (q || '').trim().toLowerCase();
        const rows = state.analysis.schema.filter((r) => !ql || r.pattern.toLowerCase().includes(ql));
        const LIMIT = 1000;
        const body = rows.slice(0, LIMIT).map((r) => {
            const types = Object.entries(r.types).map(([t, n]) => `<span class="t-chip t-${t}">${TYPE_LABELS[t]} ${n}</span>`).join('');
            const pres = r.presence === null ? '' : `${Math.round(r.presence * 100)}%`;
            let range = '';
            if (r.min !== null) range = `${r.min} … ${r.max}`;
            else if (r.maxLen) range = `long. máx ${r.maxLen}`;
            let sample = '';
            if (r.sample !== undefined) {
                const t = typeof r.sample === 'string' ? JSON.stringify(r.sample) : String(r.sample);
                sample = t.length > 60 ? t.slice(0, 60) + '…' : t;
            }
            return `<tr><td class="pat">${escapeHtml(r.pattern)}</td><td>${types}</td><td>${r.count.toLocaleString('es')}</td><td>${r.nulls || ''}</td><td>${pres}</td><td>${r.unique === '' ? '' : r.unique}</td><td>${escapeHtml(range)}</td><td class="sample" title="${escapeHtml(sample)}">${escapeHtml(sample)}</td></tr>`;
        }).join('');
        $('#schemaOut').innerHTML = `<div class="table-wrap table-container tall"><table class="schema-table"><thead><tr><th>Ruta</th><th>Tipos</th><th>Apar.</th><th>Null</th><th>Presencia</th><th>Distintos</th><th>Rango</th><th>Ejemplo</th></tr></thead><tbody>${body}</tbody></table></div>` +
            (rows.length > LIMIT ? `<p class="muted small">Se muestran ${LIMIT} de ${rows.length} rutas; usa el filtro.</p>` : '');
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Tabla                                                      */
    /* ------------------------------------------------------------------ */
    function setupTable() {
        const an = state.analysis;
        dom.tableSource.innerHTML = '';
        an.tables.forEach((t, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = `${t.path} (${t.length.toLocaleString('es')} filas)`;
            dom.tableSource.appendChild(o);
        });
        const o = document.createElement('option');
        o.value = '__root';
        o.textContent = 'Vista anidada completa (raíz)';
        dom.tableSource.appendChild(o);

        let def = '__root';
        const rootIdx = an.tables.findIndex((t) => t.segs.length === 0);
        if (rootIdx !== -1) def = String(rootIdx);
        else if (an.tables.length) def = '0';
        dom.tableSource.value = def;
        selectTableSource(def);
    }

    function selectTableSource(v) {
        dom.filterInput.value = '';
        if (v === '__root') {
            state.table = { mode: 'root' };
            dom.btnCsv.disabled = true;
            dom.flattenWrap.style.display = 'none';
        } else {
            const t = state.analysis.tables[Number(v)];
            const arr = getBySegs(state.root, t.segs);
            state.table = {
                mode: 'array', path: t.path, arr,
                items: arr.map((obj, idx) => ({ obj, idx, hay: null })),
                cols: unionCols(arr), sortCol: null, sortDir: 1, query: '', limit: 500,
            };
            dom.btnCsv.disabled = false;
            dom.flattenWrap.style.display = '';
        }
        renderTable();
    }

    function cmpValues(a, b) {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
        const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
        return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
    }

    function currentEntries() {
        const t = state.table;
        const q = t.query.trim().toLowerCase();
        let list = t.items;
        if (q) {
            list = list.filter((it) => {
                if (it.hay === null) it.hay = JSON.stringify(it.obj).toLowerCase();
                return it.hay.includes(q);
            });
        }
        if (t.sortCol !== null) {
            const c = t.sortCol;
            const dir = t.sortDir;
            const empty = (v) => v === undefined || v === null || v === '';
            list = list.slice().sort((x, y) => {
                const a = x.obj[c], b = y.obj[c];
                const ea = empty(a), eb = empty(b);
                if (ea || eb) return (ea ? 1 : 0) - (eb ? 1 : 0);
                return dir * cmpValues(a, b);
            });
        }
        return list;
    }

    function renderTable() {
        const t = state.table;
        if (t.mode === 'root') {
            dom.output.innerHTML = renderNode(state.root, 0);
            state.rows = Array.from(dom.output.querySelectorAll('table > tbody > tr'));
            dom.tableInfo.textContent = 'Vista anidada: usa el filtro para ocultar filas, o elige una lista en «Origen de la tabla».';
            applyRootFilter(dom.filterInput.value);
            return;
        }
        const all = currentEntries();
        const shown = all.slice(0, t.limit);
        const html = renderTableFromObjects(null, 0, { entries: shown, cols: t.cols, sortCol: t.sortCol, sortDir: t.sortDir });
        const more = all.length > shown.length
            ? `<div class="more-row"><button data-act="table-more">Mostrar ${Math.min(500, all.length - shown.length)} filas más</button></div>` : '';
        dom.output.innerHTML = html + more;
        dom.tableInfo.textContent = `${t.path} · mostrando ${shown.length.toLocaleString('es')} de ${all.length.toLocaleString('es')} filas` +
            (all.length !== t.items.length ? ` (filtradas de ${t.items.length.toLocaleString('es')})` : '') +
            ` · ${t.cols.length} columnas`;
    }

    function applyRootFilter(query) {
        const q = query.trim().toLowerCase();
        state.rows.forEach((tr) => tr.classList.toggle('hidden-row', !!q && !tr.textContent.toLowerCase().includes(q)));
    }

    function flatten(o, prefix, out) {
        for (const k of Object.keys(o)) {
            const v = o[k];
            const key = prefix ? `${prefix}.${k}` : k;
            if (isPlainObj(v) && Object.keys(v).length) flatten(v, key, out);
            else out[key] = v;
        }
        return out;
    }

    function csvFromEntries(entries, doFlatten) {
        const rows = entries.map((e) => (doFlatten ? flatten(e.obj, '', {}) : e.obj));
        const cols = unionCols(rows);
        const esc = (v) => {
            if (v === undefined || v === null) return '';
            let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            // Inyección de fórmulas: Excel interpreta como fórmula el texto que empieza con = + - @ (o tab/CR).
            // Solo se neutraliza el TEXTO; los números reales se dejan intactos.
            if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
            if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        const lines = [cols.map(esc).join(',')];
        rows.forEach((r) => lines.push(cols.map((c) => esc(r[c])).join(',')));
        return '﻿' + lines.join('\r\n');
    }

    function downloadCsv() {
        if (!state.table || state.table.mode !== 'array') return;
        download('tabla.csv', csvFromEntries(currentEntries(), dom.flattenCsv.checked), 'text/csv;charset=utf-8;');
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Árbol                                                      */
    /* ------------------------------------------------------------------ */
    const CHUNK = 200;
    const TS_KEY = /(fecha|date|time|timestamp|_at$|At$|^ts$|creado|created|updated|expira|expires|vence)/i;

    function keyHtml(key, isIdx) {
        return `<span class="tk${isIdx ? ' idx' : ''}" title="Clic para copiar la ruta">${escapeHtml(String(key))}</span>`;
    }

    function epochBadge(key, v) {
        if (typeof v !== 'number' || !Number.isInteger(v) || !TS_KEY.test(String(key))) return '';
        let ms = null;
        if (v >= 1e9 && v <= 4.2e9) ms = v * 1000;
        else if (v >= 1e12 && v <= 4.2e12) ms = v;
        if (ms === null) return '';
        return `<span class="badge" title="Interpretado como marca de tiempo Unix">≈ ${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC</span>`;
    }

    function buildTreeNode(key, value, segs, isIdx) {
        if (isPrimitive(value)) {
            const d = document.createElement('div');
            d.className = 'leaf';
            d._segs = segs;
            let extra = epochBadge(key, value);
            if (typeof value === 'string' && value.length > 1 && (value[0] === '{' || value[0] === '[')) {
                try {
                    const r = JSON.parse(value);
                    if (r !== null && typeof r === 'object') {
                        d._value = value;
                        extra += ` <button class="mini" data-act="tree-embed">Analizar JSON incrustado</button>`;
                    }
                } catch (_) { /* texto normal */ }
            }
            d.innerHTML = `${keyHtml(key, isIdx)}: ${renderPrimitive(value)}${extra}`;
            return d;
        }
        const det = document.createElement('details');
        det._segs = segs;
        det._value = value;
        det._rendered = 0;
        det._entries = null;
        const n = Array.isArray(value) ? value.length : Object.keys(value).length;
        const meta = Array.isArray(value) ? `[ ] ${n} elem.` : `{ } ${n} claves`;
        const sum = document.createElement('summary');
        sum.innerHTML = `${keyHtml(key, isIdx)}<span class="tmeta">${meta}</span>`;
        const box = document.createElement('div');
        box.className = 'tchildren';
        det.append(sum, box);
        det.addEventListener('toggle', () => { if (det.open) fillChildren(det, 0); });
        return det;
    }

    function fillChildren(det, upto) {
        if (!det._entries) {
            det._entries = Array.isArray(det._value) ? det._value.map((v, i) => [i, v]) : Object.entries(det._value);
        }
        const total = det._entries.length;
        const box = det.lastElementChild;
        const want = Math.min(total, Math.max(upto, det._rendered || Math.min(CHUNK, total)));
        const oldMore = box.querySelector(':scope > .more');
        if (oldMore) oldMore.remove();
        const isArr = Array.isArray(det._value);
        for (let i = det._rendered; i < want; i++) {
            const [k, v] = det._entries[i];
            box.appendChild(buildTreeNode(k, v, det._segs.concat(k), isArr));
        }
        det._rendered = want;
        if (want < total) {
            const m = document.createElement('div');
            m.className = 'more';
            m.innerHTML = `<button class="mini" data-act="tree-more">Mostrar ${Math.min(CHUNK, total - want)} más (quedan ${total - want})</button>`;
            box.appendChild(m);
        }
    }

    function buildTree() {
        dom.treeRoot.innerHTML = '';
        const node = buildTreeNode('$', state.root, [], false);
        dom.treeRoot.appendChild(node);
        if (node.tagName === 'DETAILS') { fillChildren(node, 0); node.open = true; }
    }

    function expandLevels(det, levels) {
        if (det.tagName !== 'DETAILS') return;
        fillChildren(det, 0);
        det.open = true;
        if (levels > 1) {
            Array.from(det.lastElementChild.children).forEach((c) => expandLevels(c, levels - 1));
        }
    }

    function revealPath(segs) {
        switchTab('tree');
        let node = dom.treeRoot.firstElementChild;
        for (const seg of segs) {
            if (!node || node.tagName !== 'DETAILS') { node = null; break; }
            fillChildren(node, 0);
            const idx = node._entries.findIndex(([k]) => k === seg);
            if (idx === -1) { node = null; break; }
            fillChildren(node, idx + 1);
            node.open = true;
            node = node.lastElementChild.children[idx];
        }
        if (!node) { toast('No se encontró esa ruta en el árbol'); return; }
        node.classList.add('flash');
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => node.classList.remove('flash'), 2500);
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Buscar                                                     */
    /* ------------------------------------------------------------------ */
    function makeMatcher() {
        const q = dom.searchInput.value;
        if (!q) return null;
        const cs = dom.searchCase.checked;
        if (dom.searchRegex.checked) {
            if (q.length > LIMITS.REGEX_LEN) return { error: `el patrón supera ${LIMITS.REGEX_LEN} caracteres` };
            // Cuantificadores anidados, p. ej. (a+)+ , provocan backtracking catastrófico y congelan la pestaña
            if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(q)) {
                return { error: 'el patrón tiene cuantificadores anidados, como (a+)+, que pueden congelar la página; simplifícalo' };
            }
            let re;
            try { re = new RegExp(q, cs ? '' : 'i'); } catch (e) { return { error: e.message }; }
            return {
                find: (s) => {
                    const m = re.exec(s.length > LIMITS.REGEX_TEXT ? s.slice(0, LIMITS.REGEX_TEXT) : s);
                    return m ? [m.index, m.index + m[0].length] : null;
                },
            };
        }
        const needle = cs ? q : q.toLowerCase();
        if (dom.searchExact.checked) {
            return { find: (s) => ((cs ? s : s.toLowerCase()) === needle ? [0, s.length] : null) };
        }
        return { find: (s) => { const i = (cs ? s : s.toLowerCase()).indexOf(needle); return i === -1 ? null : [i, i + needle.length]; } };
    }

    function highlight(text, range) {
        let s = text, r = range;
        let pre = '', post = '';
        if (s.length > 220) {
            const from = Math.max(0, r[0] - 70);
            const to = Math.min(s.length, from + 220);
            pre = from > 0 ? '…' : '';
            post = to < s.length ? '…' : '';
            s = s.slice(from, to);
            r = [r[0] - from, Math.min(r[1] - from, s.length)];
        }
        return pre + escapeHtml(s.slice(0, r[0])) + '<mark>' + escapeHtml(s.slice(r[0], r[1])) + '</mark>' + escapeHtml(s.slice(r[1])) + post;
    }

    function runSearch() {
        const m = makeMatcher();
        if (!m) { dom.searchResults.innerHTML = ''; dom.searchInfo.textContent = ''; return; }
        if (m.error) { dom.searchInfo.textContent = `Expresión regular inválida: ${m.error}`; dom.searchResults.innerHTML = ''; return; }
        const scope = dom.searchScope.value;
        const results = [];
        let total = 0;
        const CAP = 5000, SHOW = 300;
        const segs = [];
        const t0 = Date.now();
        let visited = 0;
        let timedOut = false;

        function walk(v) {
            if (total >= CAP || timedOut) return;
            if ((++visited & 511) === 0 && Date.now() - t0 > LIMITS.SEARCH_MS) { timedOut = true; return; }
            if (isPrimitive(v)) {
                if (scope !== 'keys') {
                    const s = v === null ? 'null' : String(v);
                    const r = m.find(s);
                    if (r) { total++; if (results.length < SHOW) results.push({ path: pathToString(segs), kind: 'valor', text: s, range: r, type: inferType(v) }); }
                }
                return;
            }
            const isArr = Array.isArray(v);
            const keys = isArr ? null : Object.keys(v);
            const n = isArr ? v.length : keys.length;
            for (let i = 0; i < n; i++) {
                const k = isArr ? i : keys[i];
                segs.push(k);
                if (!isArr && scope !== 'values') {
                    const r = m.find(k);
                    if (r) { total++; if (results.length < SHOW) results.push({ path: pathToString(segs), kind: 'clave', text: k, range: r }); }
                }
                walk(v[k]);
                segs.pop();
                if (total >= CAP || timedOut) return;
            }
        }
        walk(state.root);

        dom.searchInfo.textContent = total === 0 ? 'Sin coincidencias.' : `${total >= CAP ? CAP + '+' : total} coincidencia(s)` + (total > SHOW ? ` · mostrando las primeras ${SHOW}` : '') +
            (timedOut ? ` · búsqueda interrumpida a los ${LIMITS.SEARCH_MS / 1000} s (resultados parciales)` : '');
        dom.searchResults.innerHTML = `<div class="res-list">` + results.map((r) =>
            `<div class="res"><span class="p" data-path="${escapeHtml(r.path)}" title="Ver en el árbol">${escapeHtml(r.path)}</span><span class="v">${r.kind === 'clave' ? '<span class="muted">clave · </span>' : ''}${highlight(r.text, r.range)}</span></div>`).join('') + `</div>`;
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Texto                                                      */
    /* ------------------------------------------------------------------ */
    function sortKeys(v) {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v !== null && typeof v === 'object') {
            const o = Object.create(null);
            Object.keys(v).sort((a, b) => a.localeCompare(b)).forEach((k) => { o[k] = sortKeys(v[k]); });
            return o;
        }
        return v;
    }

    function currentText() {
        const mode = dom.textMode.value;
        if (mode === 'orig') return state.jsonText;
        const v = dom.textSort.checked ? sortKeys(state.root) : state.root;
        return JSON.stringify(v, null, mode === 'pretty' ? 2 : 0);
    }

    function refreshText() {
        const mode = dom.textMode.value;
        const issues = state.parse.issues;
        const warns = [];
        if (mode !== 'orig') {
            if (issues.bigNumbers.length) warns.push('Este JSON tiene enteros grandes: al reformatear pierden precisión. Usa «Texto original» para copiarlos sin alterar.');
            if (issues.duplicateKeys.length) warns.push('Este JSON tiene claves duplicadas: al reformatear solo se conserva el último valor de cada una.');
        }
        dom.textWarn.innerHTML = warns.map((w) => `<div class="notice">${escapeHtml(w)}</div>`).join('');
        dom.textOut.value = currentText();
    }

    /* ------------------------------------------------------------------ */
    /* Pestaña: Comparar                                                   */
    /* ------------------------------------------------------------------ */
    const KIND_LABELS = { added: 'Añadido en B', removed: 'Falta en B', changed: 'Cambió', type: 'Otro tipo' };

    function runCompare() {
        const raw = dom.compareInput.value;
        if (!raw.trim()) { dom.compareResults.innerHTML = '<div class="empty-state">Pega el JSON B para comparar.</div>'; return; }
        if (raw.length > LIMITS.HARD_CHARS) { dom.compareResults.innerHTML = '<div class="empty-state">El JSON B es demasiado grande.</div>'; return; }
        const res = JT.parseSmart(raw);
        if (!res.ok) {
            dom.compareResults.innerHTML = `<div class="err-card"><h3>El JSON B no es válido</h3><div class="where">${escapeHtml(res.error.message)} · línea ${res.error.line}, columna ${res.error.col}</div>${res.error.hint ? `<p class="hint">${escapeHtml(res.error.hint)}</p>` : ''}</div>`;
            return;
        }
        const d = JT.diff(state.root, res.value, 2000);
        const c = d.counts;
        const total = c.added + c.removed + c.changed + c.type;
        let html = '';
        if (res.notes.length) html += `<div class="notice" style="margin-bottom:10px"><ul>${res.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`;
        if (!total) {
            html += `<div class="all-ok">✔ A y B son idénticos.</div>`;
        } else {
            html += `<div class="f-toolbar"><span class="muted small">${total} diferencia(s):</span>
                <span class="path-chip">cambiados ${c.changed}</span><span class="path-chip">otro tipo ${c.type}</span>
                <span class="path-chip">añadidos en B ${c.added}</span><span class="path-chip">faltan en B ${c.removed}</span></div>`;
            html += `<div class="res-list">` + d.items.map((it) => {
                const p = it.kind === 'added'
                    ? `<span class="p" style="cursor:default">${escapeHtml(it.path)}</span>`
                    : `<span class="p" data-path="${escapeHtml(it.path)}" title="Ver en el árbol (A)">${escapeHtml(it.path)}</span>`;
                let ab;
                if (it.kind === 'added') ab = `<span class="b">B: ${escapeHtml(it.b)}</span>`;
                else if (it.kind === 'removed') ab = `<span class="a">A: ${escapeHtml(it.a)}</span>`;
                else ab = `<span class="a">A: ${escapeHtml(it.a)}</span><span class="b">B: ${escapeHtml(it.b)}</span>`;
                return `<div class="res ${it.kind}"><span class="kind">${KIND_LABELS[it.kind]}</span>${p}<span class="ab">${ab}</span></div>`;
            }).join('') + `</div>`;
            if (d.truncated) html += `<p class="muted small">Se muestran las primeras ${d.items.length} diferencias.</p>`;
        }
        dom.compareResults.innerHTML = html;
    }

    /* ------------------------------------------------------------------ */
    /* Errores y reparación                                                */
    /* ------------------------------------------------------------------ */
    function renderNotice(notes) {
        dom.notice.innerHTML = notes.length
            ? `<div class="notice"><strong>Ajustes automáticos aplicados</strong><ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>`
            : '';
    }

    function showError(res) {
        const e = res.error;
        state.root = null;
        state.analysis = null;
        dom.workspace.style.display = 'none';
        dom.emptyState.style.display = 'none';
        dom.shapeBadge.textContent = 'JSON inválido';
        dom.inputAcc.open = true;

        const ctx = e.context.map((l) => {
            let h = `<div class="ln${l.isErr ? ' err' : ''}"><span class="no">${l.no}</span><span>${escapeHtml(l.text)}</span></div>`;
            if (l.isErr && l.caret !== null) h += `<div class="caret" style="padding-left:${12 + 56}px">${' '.repeat(l.caret)}^</div>`;
            return h;
        }).join('');

        dom.errorPanel.innerHTML = `
            <div class="err-card">
                <h3>No se pudo interpretar el JSON</h3>
                <div class="where">${escapeHtml(e.message)} · línea ${e.line}, columna ${e.col}</div>
                <div class="code-ctx">${ctx}</div>
                ${e.hint ? `<p class="hint">💡 ${escapeHtml(e.hint)}</p>` : ''}
                <div class="repair-box">
                    <button id="btnRepair">Intentar reparar automáticamente</button>
                    <div id="repairOut"></div>
                </div>
            </div>`;
    }

    function doRepair() {
        const p = state.parse;
        const rp = JT.repair(p.text, p.start);
        const out = $('#repairOut');
        const list = rp.changes.length ? `<ul>${rp.changes.map((c) => `<li>${escapeHtml(c.label)}${c.count > 1 ? ` (×${c.count})` : ''}</li>`).join('')}</ul>` : '';
        if (rp.valid) {
            state.repairText = rp.text;
            out.innerHTML = `<p>Se encontró una versión válida. Cambios que se aplicarían:</p>${list}
                <button class="primary" data-act="apply-repair">Usar versión reparada y analizar</button>
                <p class="muted small">La reparación es una suposición: revisa el resultado, sobre todo si el texto estaba truncado (los datos que faltan no se recuperan).</p>`;
        } else {
            state.repairText = null;
            out.innerHTML = `<p>No se logró reparar de forma automática. Corrige manualmente el punto señalado arriba y vuelve a analizar.</p>${list ? '<p class="muted small">Cambios intentados:</p>' + list : ''}`;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Orquestación                                                        */
    /* ------------------------------------------------------------------ */
    function resetToEmpty() {
        state.root = null;
        state.analysis = null;
        state.parse = null;
        dom.workspace.style.display = 'none';
        dom.emptyState.style.display = '';
        dom.errorPanel.innerHTML = '';
        dom.notice.innerHTML = '';
        dom.shapeBadge.textContent = 'esperando datos…';
    }

    function showLimit(chars) {
        resetToEmpty();
        dom.emptyState.style.display = 'none';
        dom.shapeBadge.textContent = 'entrada demasiado grande';
        dom.inputAcc.open = true;
        dom.errorPanel.innerHTML = `<div class="err-card"><h3>La entrada es demasiado grande</h3>
            <p class="hint">Tiene ${(chars / 1e6).toFixed(1)} millones de caracteres y el límite es ${LIMITS.HARD_CHARS / 1e6}. Para evitar que la página se congele, recorta el JSON o extrae solo la parte que necesitas.</p></div>`;
    }

    function loadRoot(res, notes) {
        state.root = res.value;
        state.jsonText = res.text.slice(res.start, res.end);
        state.analysis = JT.analyze(res.value, res);
        const size = new TextEncoder().encode(state.jsonText).length;
        const shapeHtml = describeShape(res.value);
        state.info = { sizeLabel: formatBytes(size), shape: shapeHtml.replace(/<[^>]+>/g, ''), notes };
        dom.shapeBadge.innerHTML = shapeHtml;

        state.built = { table: false, tree: false, text: false };
        state.table = null;
        dom.searchResults.innerHTML = '';
        dom.searchInfo.textContent = '';
        dom.compareResults.innerHTML = '';
        dom.treeRoot.innerHTML = '';
        dom.output.innerHTML = '';

        dom.errorPanel.innerHTML = '';
        dom.emptyState.style.display = 'none';
        dom.workspace.style.display = '';
        dom.inputAcc.open = false;

        renderAnalysis();
        switchTab('analysis');
    }

    function run() {
        const raw = dom.input.value;
        if (!raw.trim()) { resetToEmpty(); return; }
        if (raw.length > LIMITS.HARD_CHARS) { showLimit(raw.length); return; }
        if (raw.length > LIMITS.SOFT_CHARS &&
            !window.confirm(`El texto tiene ${(raw.length / 1e6).toFixed(1)} millones de caracteres; analizarlo puede tardar y ralentizar la pestaña. ¿Continuar?`)) return;
        const res = JT.parseSmart(raw);
        state.parse = res;
        const notes = res.notes.concat(state.extraNotes);
        state.extraNotes = [];
        renderNotice(notes);
        if (!res.ok) { showError(res); return; }
        loadRoot(res, notes);
    }

    function loadExample() {
        let raw = JSON.stringify(EXAMPLE_DATA);
        raw = raw.replace('"nombre":"Ana Vargas","activo":true', '"nombre":"Ana Vargas","activo":false,"activo":true');
        dom.input.value = SAMPLE_PREFIX + raw;
        run();
    }

    function clearAll() {
        dom.input.value = '';
        dom.compareInput.value = '';
        resetToEmpty();
        dom.inputAcc.open = true;
        dom.input.focus();
    }

    function loadFile(file) {
        if (!file) return;
        if (file.size > LIMITS.HARD_CHARS) { showLimit(file.size); return; }
        const reader = new FileReader();
        reader.onload = () => { dom.input.value = reader.result; run(); };
        reader.readAsText(file);
    }

    function loadFromString(text, note) {
        dom.input.value = text;
        state.extraNotes = [note];
        run();
    }

    /* ------------------------------------------------------------------ */
    /* Eventos                                                             */
    /* ------------------------------------------------------------------ */
    function debounce(fn, ms) {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    }

    function bindEvents() {
        dom.btnRender.addEventListener('click', run);
        dom.btnExample.addEventListener('click', loadExample);
        dom.btnClear.addEventListener('click', clearAll);
        dom.btnCsv.addEventListener('click', downloadCsv);
        dom.fileInput.addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
        dom.input.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });

        // Arrastrar y soltar archivos
        window.addEventListener('dragover', (e) => { e.preventDefault(); dom.input.classList.add('drag'); dom.inputAcc.open = true; });
        window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dom.input.classList.remove('drag'); });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dom.input.classList.remove('drag');
            if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
        });

        dom.tabs.addEventListener('click', (e) => {
            const b = e.target.closest('.tab');
            if (b) switchTab(b.dataset.tab);
        });

        // Tabla
        dom.tableSource.addEventListener('change', () => selectTableSource(dom.tableSource.value));
        dom.filterInput.addEventListener('input', debounce(() => {
            if (!state.table) return;
            if (state.table.mode === 'root') applyRootFilter(dom.filterInput.value);
            else { state.table.query = dom.filterInput.value; state.table.limit = 500; renderTable(); }
        }, 150));
        dom.output.addEventListener('click', (e) => {
            const th = e.target.closest('th.sortable');
            if (th && state.table && state.table.mode === 'array') {
                const t = state.table;
                const c = th.dataset.col;
                if (t.sortCol !== c) { t.sortCol = c; t.sortDir = 1; }
                else if (t.sortDir === 1) t.sortDir = -1;
                else { t.sortCol = null; t.sortDir = 1; }
                renderTable();
                return;
            }
            if (e.target.closest('[data-act="table-more"]')) { state.table.limit += 500; renderTable(); }
        });

        // Árbol
        dom.treeExpand.addEventListener('click', () => { const n = dom.treeRoot.firstElementChild; if (n) expandLevels(n, 2); });
        dom.treeCollapse.addEventListener('click', () => {
            dom.treeRoot.querySelectorAll('details').forEach((d) => { d.open = false; });
            const n = dom.treeRoot.firstElementChild;
            if (n && n.tagName === 'DETAILS') n.open = true;
        });
        dom.treeRoot.addEventListener('click', (e) => {
            const key = e.target.closest('.tk');
            if (key) {
                e.preventDefault();
                const node = key.closest('.leaf, details');
                copyText(pathToString(node._segs), 'Ruta copiada');
                return;
            }
            const act = e.target.closest('[data-act]');
            if (!act) return;
            if (act.dataset.act === 'tree-more') {
                const det = act.closest('details');
                fillChildren(det, det._rendered + CHUNK);
            } else if (act.dataset.act === 'tree-embed') {
                const leaf = act.closest('.leaf');
                loadFromString(leaf._value, `Contenido extraído del campo ${pathToString(leaf._segs)}`);
            }
        });

        // Búsqueda
        const search = debounce(runSearch, 200);
        [dom.searchInput].forEach((el) => el.addEventListener('input', search));
        [dom.searchScope, dom.searchCase, dom.searchExact, dom.searchRegex].forEach((el) => el.addEventListener('change', runSearch));

        // Texto
        dom.textMode.addEventListener('change', refreshText);
        dom.textSort.addEventListener('change', refreshText);
        dom.btnCopyText.addEventListener('click', () => copyText(dom.textOut.value, 'Texto copiado'));
        dom.btnDownloadText.addEventListener('click', () => download('datos.json', dom.textOut.value, 'application/json'));

        // Comparar
        dom.btnCompare.addEventListener('click', runCompare);
        dom.compareInput.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCompare(); });
        dom.btnSwap.addEventListener('click', () => {
            if (!dom.compareInput.value.trim()) return;
            const tmp = dom.input.value;
            dom.input.value = dom.compareInput.value;
            dom.compareInput.value = tmp;
            run();
            if (state.root !== null) { switchTab('compare'); runCompare(); }
        });

        // Delegación global: rutas, hallazgos, reparación
        document.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-path]:not([data-act])');
            if (chip && state.root !== null) { revealPath(parsePath(chip.dataset.path)); return; }

            const act = e.target.closest('[data-act]');
            if (act) {
                if (act.dataset.act === 'embed') {
                    const v = getBySegs(state.root, parsePath(act.dataset.path));
                    if (typeof v === 'string') loadFromString(v, `Contenido extraído del campo ${act.dataset.path}`);
                } else if (act.dataset.act === 'apply-repair' && state.repairText) {
                    const changes = Array.from(document.querySelectorAll('#repairOut li')).map((li) => li.textContent).join('; ');
                    dom.input.value = state.repairText;
                    state.extraNotes = [`Se aplicó una reparación automática: ${changes || 'ajustes menores'}.`];
                    run();
                }
                return;
            }

            if (e.target.id === 'btnRepair') { doRepair(); return; }
            const sevBtn = e.target.closest('.f-toolbar .chip');
            if (sevBtn) { state.fFilter.sev = sevBtn.dataset.sev; renderFindings(); return; }
            if (e.target.id === 'btnReport') copyText(JT.report(state.analysis, state.info), 'Reporte copiado');
        });

        document.addEventListener('input', (e) => {
            if (e.target.id === 'fFilterInput') { state.fFilter.q = e.target.value; renderFindings(); }
            else if (e.target.id === 'schemaFilter') renderSchema(e.target.value);
        });
        document.addEventListener('toggle', (e) => {
            if (e.target.id === 'schemaBox' && e.target.open && !$('#schemaOut').innerHTML) renderSchema('');
        }, true);
    }

    /* ------------------------------------------------------------------ */
    /* Init                                                                */
    /* ------------------------------------------------------------------ */
    function init() {
        bindEvents();
        resetToEmpty();
    }

    init();
})();