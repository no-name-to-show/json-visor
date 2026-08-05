'use strict';

/**
 * Tabulador JSON
 * Convierte cualquier JSON (objeto, arreglo u arreglo de objetos) en tablas
 * HTML legibles, con soporte para estructuras anidadas colapsables.
 */
(function () {

    /* ------------------------------------------------------------------ */
    /* Referencias al DOM                                                  */
    /* ------------------------------------------------------------------ */
    const $ = (sel) => document.querySelector(sel);

    const dom = {
        input: $('#jsonInput'),
        output: $('#output'),
        shapeBadge: $('#shapeBadge'),
        inputAcc: $('#inputAcc'),
        toolbar: $('#toolbar'),
        filterInput: $('#filterInput'),
        btnRender: $('#btnRender'),
        btnExample: $('#btnExample'),
        btnClear: $('#btnClear'),
        btnCsv: $('#btnCsv'),
        fileInput: $('#fileInput'),
    };

    /* ------------------------------------------------------------------ */
    /* Estado                                                              */
    /* ------------------------------------------------------------------ */
    const state = {
        root: null,     // último JSON parseado con éxito
        rows: [],       // filas <tr> del render actual, cacheadas para el filtro
    };

    const EMPTY_MESSAGE = '<div class="empty-state">Pega un JSON arriba y presiona «Tabular» para verlo aquí.</div>';

    const EXAMPLE = [
        {
            id: 1, nombre: 'Ana Vargas', activo: true, puntaje: 87.5,
            contacto: { email: 'ana@correo.com', tel: '8888-1234' },
            etiquetas: ['frontend', 'diseño']
        },
        {
            id: 2, nombre: 'Luis Mora', activo: false, puntaje: 62,
            contacto: { email: 'luis@correo.com', tel: null },
            etiquetas: ['backend']
        },
        {
            id: 3, nombre: 'Karla Ríos', activo: true, puntaje: 95.2,
            contacto: { email: 'karla@correo.com', tel: '8888-9090' },
            etiquetas: ['fullstack', 'devops', 'sql']
        },
    ];

    /* ------------------------------------------------------------------ */
    /* Utilidades de tipo                                                  */
    /* ------------------------------------------------------------------ */
    const escapeHtml = (str) =>
        String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

    const inferType = (v) => {
        if (v === null) return 'null';
        if (Array.isArray(v)) return 'array';
        return typeof v;
    };

    const isPrimitive = (v) => {
        const t = inferType(v);
        return t !== 'object' && t !== 'array';
    };

    const isArrayOfObjects = (arr) =>
        arr.length > 0 && arr.every((item) => inferType(item) === 'object');

    /* ------------------------------------------------------------------ */
    /* Renderizado de valores                                              */
    /* ------------------------------------------------------------------ */
    const VALUE_RENDERERS = {
        string: (v) => `<span class="val val-string">"${escapeHtml(v)}"</span>`,
        number: (v) => `<span class="val val-number">${v}</span>`,
        boolean: (v) => `<span class="val val-boolean">${v}</span>`,
        null: () => `<span class="val val-null">null</span>`,
    };

    const renderPrimitive = (v) => {
        const t = inferType(v);
        const renderer = VALUE_RENDERERS[t];
        return renderer ? renderer(v) : escapeHtml(String(v));
    };

    const renderCell = (v, depth) =>
        isPrimitive(v) ? renderPrimitive(v) : wrapCollapsible(v, depth + 1);

    function wrapCollapsible(value, depth) {
        const t = inferType(value);
        const summary =
            t === 'array'
                ? `[ ] arreglo · ${value.length} elem.`
                : `{ } objeto · ${Object.keys(value).length} claves`;
        return `<details class="nested"><summary>${summary}</summary>${renderNode(value, depth)}</details>`;
    }

    function renderTableFromObjects(arr, depth) {
        const cols = [];
        arr.forEach((obj) => Object.keys(obj).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));

        const head = `<th class="idx-col">#</th>` + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');

        const body = arr
            .map((obj, i) => {
                const cells = cols
                    .map((c) => {
                        if (!Object.prototype.hasOwnProperty.call(obj, c)) {
                            return `<td class="cell empty-cell">—</td>`;
                        }
                        return `<td class="cell">${renderCell(obj[c], depth)}</td>`;
                    })
                    .join('');
                return `<tr><td class="idx-col">${i}</td>${cells}</tr>`;
            })
            .join('');

        return `<div class="table-wrap depth-${Math.min(depth, 4)}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    function renderKeyValueTable(obj, depth) {
        const rows = Object.entries(obj)
            .map(([k, v]) => `<tr><th class="key-col">${escapeHtml(k)}</th><td class="cell">${renderCell(v, depth)}</td></tr>`)
            .join('');
        return `<div class="table-wrap depth-${Math.min(depth, 4)}"><table class="kv-table"><tbody>${rows}</tbody></table></div>`;
    }

    function renderList(arr, depth) {
        const rows = arr
            .map((v, i) => `<tr><td class="idx-col">${i}</td><td class="cell">${renderCell(v, depth)}</td></tr>`)
            .join('');
        return `<div class="table-wrap depth-${Math.min(depth, 4)}"><table class="list-table"><tbody>${rows}</tbody></table></div>`;
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
            if (root.length && isArrayOfObjects(root)) {
                const cols = new Set();
                root.forEach((o) => Object.keys(o).forEach((k) => cols.add(k)));
                extra = ` · <b>${cols.size}</b> columnas`;
            }
            return `arreglo · <b>${root.length}</b> elementos${extra}`;
        }

        if (t === 'object') return `objeto · <b>${Object.keys(root).length}</b> claves`;

        return `valor primitivo · <b>${t}</b>`;
    }

    /* ------------------------------------------------------------------ */
    /* Exportar CSV                                                        */
    /* ------------------------------------------------------------------ */
    function csvFromArray(arr) {
        const cols = [];
        arr.forEach((obj) => Object.keys(obj).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));

        const escapeCsv = (v) => {
            if (v === undefined) return '';
            let s = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
            return s;
        };

        const lines = [cols.map(escapeCsv).join(',')];
        arr.forEach((obj) => lines.push(cols.map((c) => escapeCsv(obj[c])).join(',')));
        return lines.join('\n');
    }

    function downloadCsv() {
        if (!state.root) return;
        const csv = csvFromArray(state.root);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tabla.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    /* ------------------------------------------------------------------ */
    /* Orquestación de render / estado de la UI                            */
    /* ------------------------------------------------------------------ */
    function resetToEmpty() {
        state.root = null;
        state.rows = [];
        dom.output.innerHTML = EMPTY_MESSAGE;
        dom.shapeBadge.textContent = 'esperando datos…';
        dom.toolbar.style.display = 'none';
    }

    function showError(msg) {
        state.root = null;
        state.rows = [];
        dom.toolbar.style.display = 'none';
        dom.output.innerHTML = `<div class="error-box">No se pudo interpretar el JSON: ${escapeHtml(msg)}</div>`;
        dom.shapeBadge.textContent = 'JSON inválido';
    }

    function renderRoot(root) {
        state.root = root;
        dom.shapeBadge.innerHTML = describeShape(root);
        dom.output.innerHTML = renderNode(root, 0);
        state.rows = Array.from(dom.output.querySelectorAll('table > tbody > tr'));

        dom.toolbar.style.display = 'flex';
        dom.btnCsv.style.display = inferType(root) === 'array' && isArrayOfObjects(root) ? 'inline-block' : 'none';
        dom.inputAcc.open = false;
        dom.filterInput.value = '';
    }

    function tryRender() {
        const raw = dom.input.value.trim();
        if (!raw) {
            resetToEmpty();
            return;
        }
        try {
            renderRoot(JSON.parse(raw));
        } catch (e) {
            showError(e.message);
        }
    }

    function applyFilter(query) {
        const q = query.trim().toLowerCase();
        state.rows.forEach((tr) => {
            const match = !q || tr.textContent.toLowerCase().includes(q);
            tr.classList.toggle('hidden-row', !match);
        });
    }

    function loadExample() {
        dom.input.value = JSON.stringify(EXAMPLE, null, 2);
        tryRender();
    }

    function clearAll() {
        dom.input.value = '';
        resetToEmpty();
        dom.inputAcc.open = true;
    }

    function loadFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            dom.input.value = reader.result;
            tryRender();
        };
        reader.readAsText(file);
    }

    /* ------------------------------------------------------------------ */
    /* Eventos                                                             */
    /* ------------------------------------------------------------------ */
    function bindEvents() {
        dom.btnRender.addEventListener('click', tryRender);
        dom.btnExample.addEventListener('click', loadExample);
        dom.btnClear.addEventListener('click', clearAll);
        dom.btnCsv.addEventListener('click', downloadCsv);
        dom.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
        dom.filterInput.addEventListener('input', (e) => applyFilter(e.target.value));
        dom.input.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') tryRender();
        });
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