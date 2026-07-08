// netlify/functions/odoo-cc.js
// Inventarios CÍCLICOS · etcétera accesorios
//
// Flujo:
//   1) Admin (Mónica) arma una tarea: filtra productos por identificadores de
//      product.template y elige a qué sucursales se manda.
//   2) Cada sucursal cuenta (captura piezas por variante) y marca "Terminé".
//   3) Un admin revisa (contado vs teórico Odoo + diferencia). Al aprobar,
//      SOLO las líneas aprobadas ajustan Odoo (stock.quant). Las rechazadas
//      regresan a la sucursal para recontar.
//
// Esta app es INDEPENDIENTE de la app de conteo físico:
//   - función propia (odoo-cc.js), tablas propias (prefijo cc_), deploy propio.
//   - Odoo es compartido; la única escritura es el ajuste al aprobar.
//
// Variables de entorno en Netlify:
//   ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (service_role, solo backend)

const ODOO_URL = process.env.ODOO_URL;
const DB = process.env.ODOO_DB;
const USER = process.env.ODOO_USER;
const API_KEY = process.env.ODOO_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Al aprobar: true = aplica el ajuste en Odoo (cambia el on-hand).
// false = solo deja la cantidad "contada" en el ajuste de inventario, lista
// para aplicar manualmente en Odoo. Cámbialo si prefieres no aplicar.
const APPLY_ON_APPROVE = true;

// Campos identificadores (selection) en product.template.
const IDENT_FIELDS = [
  "x_marca_ident", "x_descuento_ident", "x_familia_ident", "x_grupo_ident",
  "x_subgrupo_ident", "x_caracteristica_ident", "x_color1_ident", "x_color2_ident",
  "x_material1_ident", "x_material2_ident", "x_temporada_ident", "x_ao_ident",
  "x_segmento_ident", "x_talla_ident", "x_acabado_ident", "x_linea_ident",
];
const IDENT_LABELS = {
  x_marca_ident: "Marca", x_descuento_ident: "Descuento", x_familia_ident: "Familia",
  x_grupo_ident: "Grupo", x_subgrupo_ident: "Subgrupo", x_caracteristica_ident: "Característica",
  x_color1_ident: "Color 1", x_color2_ident: "Color 2", x_material1_ident: "Material 1",
  x_material2_ident: "Material 2", x_temporada_ident: "Temporada", x_ao_ident: "Año",
  x_segmento_ident: "Segmento", x_talla_ident: "Talla", x_acabado_ident: "Acabado",
  x_linea_ident: "Línea",
};

// ---------- Odoo JSON-RPC ----------
async function jsonrpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error?.data?.message || JSON.stringify(data.error));
  return data.result;
}
async function execKw(uid, model, method, args, kwargs = {}) {
  return jsonrpc("object", "execute_kw", [DB, uid, API_KEY, model, method, args, kwargs]);
}
let cachedUid = null;
async function authenticate() {
  if (cachedUid) return cachedUid;
  cachedUid = await jsonrpc("common", "authenticate", [DB, USER, API_KEY, {}]);
  if (!cachedUid) throw new Error("Autenticación con Odoo fallida.");
  return cachedUid;
}

// ---------- Supabase (PostgREST) ----------
function sbHeaders(extra = {}) {
  return { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}
async function sbSelect(query) {
  const res = await fetch(`${SB_URL}/rest/v1/${query}`, { headers: sbHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error("Supabase: " + (data.message || JSON.stringify(data)));
  return data;
}
async function sbSelectAll(query) {
  const PAGE = 1000;
  let off = 0, all = [];
  for (let i = 0; i < 2000; i++) {
    const sep = query.includes("?") ? "&" : "?";
    const res = await fetch(`${SB_URL}/rest/v1/${query}${sep}limit=${PAGE}&offset=${off}`, { headers: sbHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error("Supabase: " + (data.message || JSON.stringify(data)));
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    off += data.length;
    if (data.length < PAGE) break;
  }
  return all;
}
async function sbInsert(table, body, returnRep = false) {
  const pref = returnRep ? "return=representation" : "return=minimal";
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST", headers: sbHeaders({ Prefer: pref }), body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error("Supabase insert: " + txt);
  return returnRep ? JSON.parse(txt) : { ok: true };
}
async function sbUpsert(table, onConflict, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Supabase upsert: " + (await res.text()));
  return { ok: true };
}
async function sbPatch(query, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${query}`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Supabase patch: " + (await res.text()));
  return { ok: true };
}

// ---------- Catálogo / filtros ----------
async function getFilterOptions(uid) {
  const meta = await execKw(uid, "product.template", "fields_get", [IDENT_FIELDS], { attributes: ["selection"] });
  const out = {};
  for (const f of IDENT_FIELDS) {
    const opts = (meta[f] && meta[f].selection) || [];
    out[f] = { label: IDENT_LABELS[f] || f, options: opts.map((o) => o[0]) };
  }
  return out;
}

function buildDomain(filters) {
  const domain = [["active", "=", true]];
  for (const f of IDENT_FIELDS) {
    const vals = (filters && filters[f]) || [];
    if (Array.isArray(vals) && vals.length) domain.push([f, "in", vals]);
  }
  return domain;
}

async function previewProductos(uid, p) {
  const domain = buildDomain(p.filters);
  const tmplIds = await execKw(uid, "product.template", "search", [domain], { limit: 100000 });
  let variants = 0;
  if (tmplIds.length) variants = await execKw(uid, "product.product", "search_count", [[["product_tmpl_id", "in", tmplIds]]]);
  return { templates: tmplIds.length, variants };
}

// Lista real de variantes que se van a inventariar (para la vista previa)
async function previewLista(uid, p) {
  const domain = buildDomain(p.filters);
  const tmplIds = await execKw(uid, "product.template", "search", [domain], { limit: 100000 });
  if (!tmplIds.length) return { total: 0, productos: [] };
  const tmpls = await execKw(uid, "product.template", "read", [tmplIds], { fields: ["id", "name"].concat(IDENT_FIELDS) });
  const tmap = {}; tmpls.forEach((t) => (tmap[t.id] = t));
  const total = await execKw(uid, "product.product", "search_count", [[["product_tmpl_id", "in", tmplIds]]]);
  const variants = await execKw(uid, "product.product", "search_read",
    [[["product_tmpl_id", "in", tmplIds]]],
    { fields: ["id", "name", "default_code", "barcode", "product_tmpl_id"], limit: 500, order: "name asc" });
  const productos = variants.map((v) => {
    const tid = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
    const t = tmap[tid] || {}; const ident = {};
    IDENT_FIELDS.forEach((f) => (ident[f] = t[f] || null));
    return { product_id: v.id, name: v.name, code: v.default_code || "", barcode: v.barcode || "", ident };
  });
  return { total, productos };
}

// ---------- Sucursales (ubicaciones internas /Existencias) ----------
async function listSucursales(uid) {
  const domain = [["usage", "=", "internal"], ["complete_name", "ilike", "Existencias"], ["complete_name", "not ilike", "CEDIS"]];
  const recs = await execKw(uid, "stock.location", "search_read", [domain], { fields: ["id", "name", "complete_name"], limit: 500 });
  recs.sort((a, b) => String(a.complete_name).localeCompare(String(b.complete_name)));
  return recs;
}

// ---------- Crear tarea ----------
async function crearTarea(uid, p) {
  const nombre = (p.nombre || "").trim() || `Cíclico ${new Date().toISOString().slice(0, 10)}`;
  const filters = p.filters || {};
  const hasFilters = IDENT_FIELDS.some((f) => Array.isArray(filters[f]) && filters[f].length);
  const manuales = Array.isArray(p.manuales) ? p.manuales.map(Number).filter(Boolean) : [];
  const sucs = Array.isArray(p.sucursales) ? p.sucursales : [];
  if (!sucs.length) throw new Error("Elige al menos una sucursal.");

  // Reúne ids de variantes: por filtros + manuales (dedup)
  const idSet = new Set(manuales);
  if (hasFilters) {
    const tmplIds = await execKw(uid, "product.template", "search", [buildDomain(filters)], { limit: 100000 });
    if (tmplIds.length) {
      const vids = await execKw(uid, "product.product", "search", [[["product_tmpl_id", "in", tmplIds]]], { limit: 100000 });
      vids.forEach((id) => idSet.add(id));
    }
  }
  if (!idSet.size) throw new Error("No hay productos: agrega filtros o productos manuales.");
  const allIds = Array.from(idSet);

  // Lee variantes (por lotes)
  const variants = [];
  for (let i = 0; i < allIds.length; i += 1000) {
    const chunk = await execKw(uid, "product.product", "read", [allIds.slice(i, i + 1000)],
      { fields: ["id", "name", "default_code", "barcode", "product_tmpl_id"] });
    variants.push(...chunk);
  }
  // Snapshot de identificadores por template
  const tids = Array.from(new Set(variants.map((v) => (Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id))));
  const tmap = {};
  for (let i = 0; i < tids.length; i += 1000) {
    const chunk = await execKw(uid, "product.template", "read", [tids.slice(i, i + 1000)], { fields: ["id"].concat(IDENT_FIELDS) });
    chunk.forEach((t) => (tmap[t.id] = t));
  }

  const [tarea] = await sbInsert("cc_tareas",
    [{ nombre, filtros: filters, creada_por: p.usuario || null, estado: "activa" }], true);
  const tareaId = tarea.id;

  const prodRows = variants.map((v) => {
    const tid = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
    const t = tmap[tid] || {};
    const ident = {};
    IDENT_FIELDS.forEach((f) => (ident[f] = t[f] || null));
    return {
      tarea_id: tareaId, product_id: v.id, template_id: tid,
      name: v.name, default_code: v.default_code || null, barcode: v.barcode || null, ident,
    };
  });
  for (let i = 0; i < prodRows.length; i += 500) await sbInsert("cc_tarea_producto", prodRows.slice(i, i + 500));

  const sucRows = sucs.map((s) => ({
    tarea_id: tareaId, location_id: s.id, location_name: s.name || s.complete_name || ("Ubic " + s.id), estado: "pendiente",
  }));
  await sbInsert("cc_tarea_sucursal", sucRows);

  return { tarea_id: tareaId, nombre, productos: prodRows.length, sucursales: sucRows.length };
}

// Búsqueda de productos para agregar manualmente
async function buscarProductos(uid, p) {
  const q = (p.query || "").trim();
  if (q.length < 2) return [];
  const domain = ["&", ["active", "=", true], "|", "|",
    ["name", "ilike", q], ["default_code", "ilike", q], ["barcode", "ilike", q]];
  const vs = await execKw(uid, "product.product", "search_read", [domain],
    { fields: ["id", "name", "default_code", "barcode", "product_tmpl_id"], limit: 30 });
  const tids = Array.from(new Set(vs.map((v) => (Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id))));
  const tmap = {};
  if (tids.length) {
    const tmpls = await execKw(uid, "product.template", "read", [tids], { fields: ["id"].concat(IDENT_FIELDS) });
    tmpls.forEach((t) => (tmap[t.id] = t));
  }
  return vs.map((v) => {
    const tid = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
    const t = tmap[tid] || {};
    const ident = {};
    IDENT_FIELDS.forEach((f) => (ident[f] = t[f] || null));
    return { product_id: v.id, name: v.name, code: v.default_code || "", barcode: v.barcode || "", template_id: tid, ident };
  });
}

// ---------- Listado de tareas (admin) ----------
async function listTareas() {
  const tareas = await sbSelectAll("cc_tareas?select=id,nombre,estado,creada_por,created_at&order=created_at.desc");
  if (!tareas.length) return [];
  const sucs = await sbSelectAll("cc_tarea_sucursal?select=tarea_id,estado&order=id.asc");
  const prods = await sbSelectAll("cc_tarea_producto?select=tarea_id&order=id.asc");
  const pcount = {}; prods.forEach((r) => (pcount[r.tarea_id] = (pcount[r.tarea_id] || 0) + 1));
  const smap = {};
  sucs.forEach((r) => {
    smap[r.tarea_id] = smap[r.tarea_id] || { total: 0, pendiente: 0, en_conteo: 0, terminada: 0, en_revision: 0, aprobada: 0 };
    smap[r.tarea_id].total++;
    if (smap[r.tarea_id][r.estado] !== undefined) smap[r.tarea_id][r.estado]++;
  });
  return tareas.map((t) => ({ ...t, productos: pcount[t.id] || 0, sucursales: smap[t.id] || { total: 0 } }));
}

// ---------- Dashboard de una tarea ----------
async function dashboard(p) {
  const tareaId = p.tarea_id;
  const sucs = await sbSelectAll(`cc_tarea_sucursal?tarea_id=eq.${tareaId}&select=location_id,location_name,estado,terminada_por,updated_at&order=location_name.asc`);
  const total = (await sbSelectAll(`cc_tarea_producto?tarea_id=eq.${tareaId}&select=product_id&order=id.asc`)).length;
  const cts = await sbSelectAll(`cc_conteos?tarea_id=eq.${tareaId}&select=location_id,product_id,qty&order=id.asc`);
  const counted = {};
  cts.forEach((r) => { if (Number(r.qty) > 0) { counted[r.location_id] = (counted[r.location_id] || 0) + 1; } });
  return {
    total_productos: total,
    sucursales: sucs.map((s) => ({ ...s, contados: counted[s.location_id] || 0 })),
  };
}

// Resumen por sucursal para la lista de revisión (piezas esperadas vs contadas)
async function revisionResumen(uid, p) {
  const tareaId = p.tarea_id;
  const sucs = await sbSelectAll(`cc_tarea_sucursal?tarea_id=eq.${tareaId}&select=location_id,location_name,estado&order=location_name.asc`);
  const prods = await sbSelectAll(`cc_tarea_producto?tarea_id=eq.${tareaId}&select=product_id&order=id.asc`);
  const pids = prods.map((r) => r.product_id);
  const cts = await sbSelectAll(`cc_conteos?tarea_id=eq.${tareaId}&select=location_id,qty&order=id.asc`);
  const contByLoc = {};
  cts.forEach((r) => { contByLoc[r.location_id] = (contByLoc[r.location_id] || 0) + Number(r.qty || 0); });
  const locIds = sucs.map((s) => s.location_id);
  const espByLoc = {};
  if (pids.length && locIds.length) {
    const quants = await execKw(uid, "stock.quant", "search_read",
      [[["location_id", "in", locIds], ["product_id", "in", pids]]],
      { fields: ["location_id", "quantity"] });
    quants.forEach((q) => {
      const lid = Array.isArray(q.location_id) ? q.location_id[0] : q.location_id;
      espByLoc[lid] = (espByLoc[lid] || 0) + Number(q.quantity || 0);
    });
  }
  return { sucursales: sucs.map((s) => ({
    location_id: s.location_id, location_name: s.location_name, estado: s.estado,
    piezas_contadas: contByLoc[s.location_id] || 0,
    piezas_esperadas: espByLoc[s.location_id] || 0,
  })) };
}

// ---------- Sucursal: sus tareas ----------
async function sucursalTareas(p) {
  const loc = p.location_id;
  const links = await sbSelectAll(`cc_tarea_sucursal?location_id=eq.${loc}&select=tarea_id,estado,updated_at&order=id.desc`);
  if (!links.length) return [];
  const ids = Array.from(new Set(links.map((l) => l.tarea_id)));
  const tareas = await sbSelectAll(`cc_tareas?id=in.(${ids.join(",")})&select=id,nombre,estado,created_at`);
  const tmap = {}; tareas.forEach((t) => (tmap[t.id] = t));
  const prods = await sbSelectAll(`cc_tarea_producto?tarea_id=in.(${ids.join(",")})&select=tarea_id&order=id.asc`);
  const pcount = {}; prods.forEach((r) => (pcount[r.tarea_id] = (pcount[r.tarea_id] || 0) + 1));
  const cts = await sbSelectAll(`cc_conteos?location_id=eq.${loc}&tarea_id=in.(${ids.join(",")})&select=tarea_id,product_id,qty&order=id.asc`);
  const ccount = {}; cts.forEach((r) => { if (Number(r.qty) > 0) ccount[r.tarea_id] = (ccount[r.tarea_id] || 0) + 1; });
  return links
    .filter((l) => tmap[l.tarea_id] && tmap[l.tarea_id].estado === "activa")
    .map((l) => ({
      tarea_id: l.tarea_id, nombre: (tmap[l.tarea_id] || {}).nombre, estado: l.estado,
      total: pcount[l.tarea_id] || 0, contados: ccount[l.tarea_id] || 0,
    }));
}

// ---------- Sucursal: productos de una tarea + mis conteos ----------
async function sucursalTarea(p) {
  const { tarea_id, location_id } = p;
  const prods = await sbSelectAll(`cc_tarea_producto?tarea_id=eq.${tarea_id}&select=product_id,template_id,name,default_code,barcode,ident&order=name.asc,product_id.asc`);
  const cts = await sbSelectAll(`cc_conteos?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=product_id,qty`);
  const qmap = {}; cts.forEach((r) => (qmap[r.product_id] = Number(r.qty)));
  const rev = await sbSelectAll(`cc_revision?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=product_id,estado`);
  const rmap = {}; rev.forEach((r) => (rmap[r.product_id] = r.estado));
  const link = await sbSelect(`cc_tarea_sucursal?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=estado`);
  const rows = prods.map((r) => ({
    product_id: r.product_id, name: r.name, code: r.default_code || r.barcode || "",
    barcode: r.barcode || "", ident: r.ident || {},
    counted: qmap[r.product_id] != null ? qmap[r.product_id] : null,
    review: rmap[r.product_id] || null,
  }));
  return { estado: (link[0] && link[0].estado) || "pendiente", productos: rows };
}

// Fotos por lote (image_128 de product.product)
async function getImages(uid, p) {
  const ids = (p.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return {};
  const recs = await execKw(uid, "product.product", "read", [ids], { fields: ["image_128"] });
  const out = {};
  recs.forEach((r) => { if (r.image_128) out[r.id] = "data:image/png;base64," + r.image_128; });
  return out;
}

// Guarda el conteo de una sucursal para una variante (absoluto)
async function setConteo(p) {
  const qty = Math.max(0, Number(p.qty) || 0);
  await sbUpsert("cc_conteos", "tarea_id,location_id,product_id",
    [{ tarea_id: p.tarea_id, location_id: p.location_id, product_id: p.product_id, qty, updated_at: new Date().toISOString() }]);
  // marca la sucursal como en_conteo si estaba pendiente
  await sbPatch(`cc_tarea_sucursal?tarea_id=eq.${p.tarea_id}&location_id=eq.${p.location_id}&estado=eq.pendiente`,
    { estado: "en_conteo", updated_at: new Date().toISOString() });
  return { ok: true };
}

// La sucursal marca "Terminé"
async function terminarSucursal(p) {
  await sbPatch(`cc_tarea_sucursal?tarea_id=eq.${p.tarea_id}&location_id=eq.${p.location_id}`,
    { estado: "terminada", terminada_por: p.usuario || null, updated_at: new Date().toISOString() });
  return { ok: true };
}

// ---------- Revisión ----------
async function teoricoMap(uid, locationId, productIds) {
  if (!productIds.length) return {};
  const quants = await execKw(uid, "stock.quant", "search_read",
    [[["location_id", "=", locationId], ["product_id", "in", productIds]]],
    { fields: ["product_id", "quantity"] });
  const m = {};
  quants.forEach((q) => {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    m[pid] = (m[pid] || 0) + Number(q.quantity || 0);
  });
  return m;
}

async function revisionData(uid, p) {
  const { tarea_id, location_id } = p;
  const prods = await sbSelectAll(`cc_tarea_producto?tarea_id=eq.${tarea_id}&select=product_id,name,default_code,barcode&order=name.asc,product_id.asc`);
  const pids = prods.map((r) => r.product_id);
  const cts = await sbSelectAll(`cc_conteos?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=product_id,qty`);
  const qmap = {}; cts.forEach((r) => (qmap[r.product_id] = Number(r.qty)));
  const rev = await sbSelectAll(`cc_revision?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=product_id,estado`);
  const rmap = {}; rev.forEach((r) => (rmap[r.product_id] = r.estado));
  const teo = await teoricoMap(uid, location_id, pids);
  // marca en_revision
  await sbPatch(`cc_tarea_sucursal?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&estado=eq.terminada`,
    { estado: "en_revision", updated_at: new Date().toISOString() });
  const rows = prods.map((r) => {
    const contado = qmap[r.product_id] != null ? qmap[r.product_id] : 0;
    const teorico = teo[r.product_id] != null ? teo[r.product_id] : 0;
    return {
      product_id: r.product_id, name: r.name, code: r.default_code || r.barcode || "",
      contado, teorico, diff: contado - teorico, review: rmap[r.product_id] || null,
    };
  });
  return { productos: rows };
}

// Aprobar sucursal: líneas NO rechazadas ajustan Odoo; rechazadas regresan a conteo.
async function adjustOdoo(uid, productId, locationId, counted) {
  const ids = await execKw(uid, "stock.quant", "search", [[["product_id", "=", productId], ["location_id", "=", locationId]]]);
  const ctx = { context: { inventory_mode: true } };
  let qid;
  if (ids.length) { qid = ids[0]; await execKw(uid, "stock.quant", "write", [[qid], { inventory_quantity: counted }], ctx); }
  else { qid = await execKw(uid, "stock.quant", "create", [{ product_id: productId, location_id: locationId, inventory_quantity: counted }], ctx); }
  if (APPLY_ON_APPROVE) await execKw(uid, "stock.quant", "action_apply_inventory", [[qid]]);
  return qid;
}

async function aprobarSucursal(uid, p) {
  const { tarea_id, location_id } = p;
  const rejected = new Set((p.rechazadas || []).map(Number));
  const aprobador = p.usuario || null;
  const prods = await sbSelectAll(`cc_tarea_producto?tarea_id=eq.${tarea_id}&select=product_id&order=id.asc`);
  const pids = prods.map((r) => r.product_id);
  const cts = await sbSelectAll(`cc_conteos?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}&select=product_id,qty`);
  const qmap = {}; cts.forEach((r) => (qmap[r.product_id] = Number(r.qty)));
  const teo = await teoricoMap(uid, location_id, pids);

  const revRows = [];
  let aprobadas = 0;
  for (const pid of pids) {
    const contado = qmap[pid] != null ? qmap[pid] : 0;
    const teorico = teo[pid] != null ? teo[pid] : 0;
    if (rejected.has(pid)) {
      revRows.push({ tarea_id, location_id, product_id: pid, estado: "rechazada", contado, teorico, revisada_por: aprobador, updated_at: new Date().toISOString() });
    } else {
      await adjustOdoo(uid, pid, location_id, contado);
      revRows.push({ tarea_id, location_id, product_id: pid, estado: "aprobada", contado, teorico, revisada_por: aprobador, updated_at: new Date().toISOString() });
      aprobadas++;
    }
  }
  for (let i = 0; i < revRows.length; i += 500) await sbUpsert("cc_revision", "tarea_id,location_id,product_id", revRows.slice(i, i + 500));

  const nuevoEstado = rejected.size ? "en_conteo" : "aprobada";
  await sbPatch(`cc_tarea_sucursal?tarea_id=eq.${tarea_id}&location_id=eq.${location_id}`,
    { estado: nuevoEstado, updated_at: new Date().toISOString() });
  return { aprobadas, rechazadas: rejected.size, estado: nuevoEstado, aplicado: APPLY_ON_APPROVE };
}

// Aprobar TODAS las sucursales terminadas / en revisión (sin rechazos)
async function aprobarTodas(uid, p) {
  const tareaId = p.tarea_id;
  const sucs = await sbSelectAll(`cc_tarea_sucursal?tarea_id=eq.${tareaId}&estado=in.(terminada,en_revision)&select=location_id&order=id.asc`);
  let lineas = 0, n = 0;
  for (const s of sucs) {
    const r = await aprobarSucursal(uid, { tarea_id: tareaId, location_id: s.location_id, rechazadas: [], usuario: p.usuario || null });
    lineas += r.aprobadas; n++;
  }
  return { sucursales: n, lineas, aplicado: APPLY_ON_APPROVE };
}

// Cerrar / reabrir tarea
async function setTareaEstado(p) {
  await sbPatch(`cc_tareas?id=eq.${p.tarea_id}`, { estado: p.estado });
  return { ok: true };
}

// ---------- Handler ----------
exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Usa POST" }) };
  try {
    const { action, payload = {} } = JSON.parse(event.body || "{}");
    const uid = await authenticate();
    let result;
    switch (action) {
      case "ping": result = { ok: true, uid }; break;
      case "getFilterOptions": result = await getFilterOptions(uid); break;
      case "previewProductos": result = await previewProductos(uid, payload); break;
      case "previewLista": result = await previewLista(uid, payload); break;
      case "listSucursales": result = await listSucursales(uid); break;
      case "crearTarea": result = await crearTarea(uid, payload); break;
      case "buscarProductos": result = await buscarProductos(uid, payload); break;
      case "listTareas": result = await listTareas(); break;
      case "dashboard": result = await dashboard(payload); break;
      case "revisionResumen": result = await revisionResumen(uid, payload); break;
      case "sucursalTareas": result = await sucursalTareas(payload); break;
      case "sucursalTarea": result = await sucursalTarea(payload); break;
      case "getImages": result = await getImages(uid, payload); break;
      case "setConteo": result = await setConteo(payload); break;
      case "terminarSucursal": result = await terminarSucursal(payload); break;
      case "revisionData": result = await revisionData(uid, payload); break;
      case "aprobarSucursal": result = await aprobarSucursal(uid, payload); break;
      case "aprobarTodas": result = await aprobarTodas(uid, payload); break;
      case "setTareaEstado": result = await setTareaEstado(payload); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: `Acción desconocida: ${action}` }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ result }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
