/* ═══════════════════════════════════════════════════════════════
   Pedidos — se guardan en Cloudflare KV
   ───────────────────────────────────────────────────────────────
   POST /api/pedido   graba un pedido (lo llama la propia web)
   GET  /api/pedidos  panel privado para ver y despachar

   Hace falta:
     PEDIDOS      binding de KV (se agrega en wrangler.jsonc)
     ADMIN_CLAVE  contraseña del panel (va como SECRETO)

   Si falta el binding, nada rompe: la web sigue andando y los
   pedidos simplemente no se guardan.
   ═══════════════════════════════════════════════════════════════ */

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8' }
});
const pagina = (t, s = 200, extra = {}) => new Response(t, {
  status: s, headers: { 'content-type': 'text/html; charset=utf-8', ...extra }
});
const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const plata = n => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

/* La clave más nueva ordena primero: KV lista alfabéticamente. */
const armarClave = (ms, ref) => `pedido:${(1e14 - ms)}:${ref}`;

export async function guardarPedido(env, datos){
  if(!env.PEDIDOS) return null;
  const ms  = Date.now();
  const ref = datos.ref || ('OF-' + ms.toString(36).toUpperCase());
  const p = {
    ...datos,
    ref,
    creado: new Date(ms).toISOString(),
    estado: datos.estado || 'pendiente'
  };
  await env.PEDIDOS.put(armarClave(ms, ref), JSON.stringify(p),
    { expirationTtl: 60 * 60 * 24 * 400 });   // se guardan 400 días
  return ref;
}

async function todos(env){
  const out = [];
  let cursor;
  do {
    const l = await env.PEDIDOS.list({ prefix: 'pedido:', cursor });
    for(const k of l.keys){
      const v = await env.PEDIDOS.get(k.name);
      if(v){ try { out.push({ clave: k.name, ...JSON.parse(v) }); } catch(_){} }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while(cursor);
  return out;
}

/* ── POST /api/pedido ─────────────────────────────────────────── */
export async function registrarPedido(request, env){
  let b;
  try { b = await request.json(); } catch(_){ return json({ error:'json' }, 400); }

  /* Marcar uno existente (por ejemplo: volvió pagado de Mercado Pago) */
  if(b.marcar && b.ref){
    if(!env.PEDIDOS) return json({ ok:false });
    const lista = await todos(env);
    const p = lista.find(x => x.ref === b.ref);
    if(!p) return json({ ok:false });
    p.estado = String(b.marcar).slice(0, 24);
    const { clave, ...resto } = p;
    await env.PEDIDOS.put(clave, JSON.stringify(resto),
      { expirationTtl: 60 * 60 * 24 * 400 });
    return json({ ok:true });
  }

  const ref = await guardarPedido(env, {
    medio:     b.medio || 'transferencia',
    estado:    b.estado || 'pendiente',
    items:     Array.isArray(b.items) ? b.items : [],
    envio:     b.envio || {},
    comprador: b.comprador || {},
    cupon:     b.cupon || null,
    total:     Number(b.total) || 0
  });
  return json({ ok: !!ref, ref });
}

/* ── GET/POST /api/pedidos — panel privado ────────────────────── */
const autorizado = (request, env) => {
  if(!env.ADMIN_CLAVE) return false;
  const m = (request.headers.get('Cookie') || '')
    .match(/(?:^|;\s*)ofelia_admin=([^;]+)/);
  return !!m && decodeURIComponent(m[1]) === env.ADMIN_CLAVE;
};

const ENTRAR = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pedidos</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;
      background:#E3CDBD;color:#331C14;font-family:Georgia,serif}
 form{display:flex;flex-direction:column;gap:14px;width:min(320px,86vw)}
 h1{font-size:1.3rem;font-weight:500;margin:0 0 6px;letter-spacing:.04em}
 input{font:inherit;padding:12px 14px;border:1px solid #c9b3a3;border-radius:3px;
       background:#f3e7dc;color:#331C14}
 button{font:inherit;padding:12px;border:0;border-radius:3px;cursor:pointer;
        background:#331C14;color:#E3CDBD;letter-spacing:.1em;text-transform:uppercase;
        font-size:.78rem}
</style>
<form method="post">
  <h1>Pedidos — Ofelia St</h1>
  <input type="password" name="clave" placeholder="Contraseña" autofocus>
  <button>Entrar</button>
</form>`;

export async function panelPedidos(request, env){
  /* Login: la contraseña viaja en el cuerpo, nunca en la dirección. */
  if(request.method === 'POST'){
    const f = await request.formData();
    if(env.ADMIN_CLAVE && f.get('clave') === env.ADMIN_CLAVE){
      return new Response('', { status: 303, headers: {
        'Location': '/api/pedidos',
        'Set-Cookie': `ofelia_admin=${encodeURIComponent(env.ADMIN_CLAVE)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
      }});
    }
    return pagina(ENTRAR.replace('<input type="password"',
      '<p style="color:#8a2b22;margin:0">Contraseña incorrecta.</p><input type="password"'), 401);
  }

  if(!autorizado(request, env)) return pagina(ENTRAR, 401);
  if(!env.PEDIDOS) return pagina(cuerpoHTML('<p class="vacio">Falta conectar la base de pedidos (binding PEDIDOS en wrangler.jsonc).</p>'));

  const url = new URL(request.url);

  /* Cambiar el estado de un pedido */
  const despachar = url.searchParams.get('despachar');
  const volver    = url.searchParams.get('volver');
  for(const [clave, nuevo] of [[despachar, 'despachado'], [volver, 'pendiente']]){
    if(!clave) continue;
    const v = await env.PEDIDOS.get(clave);
    if(v){
      const p = JSON.parse(v); p.estado = nuevo;
      await env.PEDIDOS.put(clave, JSON.stringify(p), { expirationTtl: 60*60*24*400 });
    }
    return new Response('', { status: 303, headers: { Location: '/api/pedidos' } });
  }

  const lista = await todos(env);
  if(!lista.length) return pagina(cuerpoHTML('<p class="vacio">Todavía no hay pedidos.</p>'));
  return pagina(cuerpoHTML(lista.map(tarjeta).join('')));
}

function direccion(e = {}){
  if(e.modo === 'retiro')   return 'Retiro en persona';
  if(e.modo === 'sucursal') return `Sucursal: ${esc(e.sucursal || '(a definir)')}`;
  return [
    esc([e.calle, e.numero].filter(Boolean).join(' ')),
    e.piso ? esc(e.piso) : '',
    esc(e.localidad), `CP ${esc(e.cp)}`, esc(e.provincia)
  ].filter(Boolean).join(', ');
}

function tarjeta(p){
  const f = new Date(p.creado);
  const cuando = f.toLocaleString('es-AR', { timeZone:'America/Argentina/Buenos_Aires',
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  const items = (p.items || []).map(i =>
    `<li>${i.qty || 1} × ${esc(i.id || i.nombre || '')}${i.talle && i.talle !== 'Único' ? ` · talle ${esc(i.talle)}` : ''}</li>`).join('');
  const c = p.comprador || {};
  const despachado = p.estado === 'despachado';

  /* Bloque listo para copiar y pegar en MiCorreo */
  const paraCorreo = [
    c.nombre || '', c.telefono || '', c.email || '',
    c.dni ? `DNI ${c.dni}` : '', direccion(p.envio)
  ].filter(Boolean).join('\n');

  return `<article class="p ${despachado ? 'hecho' : ''}">
    <header>
      <b>${esc(p.ref)}</b>
      <span class="et ${esc(p.estado)}">${esc(p.estado)}</span>
      <span class="fe">${cuando}</span>
    </header>
    <div class="col">
      <div>
        <h4>Quien compra</h4>
        <p>${esc(c.nombre)}<br>${esc(c.telefono)}<br>${esc(c.email)}${c.dni ? `<br>DNI ${esc(c.dni)}` : ''}</p>
        <h4>Entrega</h4>
        <p>${direccion(p.envio)}<br><small>${esc(p.envio?.nombre || '')} ${p.envio?.precio ? plata(p.envio.precio) : ''}</small></p>
      </div>
      <div>
        <h4>Piezas</h4>
        <ul>${items}</ul>
        <h4>Total</h4>
        <p class="tot">${plata(p.total)}${p.cupon ? ` <small>(cupón ${esc(p.cupon)})</small>` : ''}
           <br><small>${esc(p.medio === 'mp' ? 'Mercado Pago' : 'Transferencia')}</small></p>
      </div>
    </div>
    <textarea readonly rows="5" onclick="this.select()">${esc(paraCorreo)}</textarea>
    <footer>
      ${despachado
        ? `<a class="b ghost" href="/api/pedidos?volver=${encodeURIComponent(p.clave)}">Volver a pendiente</a>`
        : `<a class="b" href="/api/pedidos?despachar=${encodeURIComponent(p.clave)}">Marcar despachado</a>`}
    </footer>
  </article>`;
}

function cuerpoHTML(dentro){
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pedidos — Ofelia St</title>
<style>
 :root{--choco:#331C14;--crema:#E3CDBD;--pale:#f3e7dc;--linea:#d7c0ae}
 *{box-sizing:border-box}
 body{margin:0;padding:26px 16px 60px;background:var(--crema);color:var(--choco);
      font-family:Georgia,serif;line-height:1.5}
 h1{font-size:1.4rem;font-weight:500;letter-spacing:.06em;margin:0 0 22px;text-align:center}
 .wrap{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
 .vacio{text-align:center;opacity:.7}
 .p{background:var(--pale);border:1px solid var(--linea);border-radius:5px;padding:18px 20px}
 .p.hecho{opacity:.55}
 .p header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
           border-bottom:1px solid var(--linea);padding-bottom:10px;margin-bottom:12px}
 .p header b{letter-spacing:.06em}
 .fe{margin-left:auto;font-size:.82rem;opacity:.65}
 .et{font-size:.68rem;text-transform:uppercase;letter-spacing:.12em;
     border:1px solid var(--linea);border-radius:99px;padding:3px 10px}
 .et.pagado{background:#2f6b4f;border-color:#2f6b4f;color:#fff}
 .et.despachado{background:var(--choco);border-color:var(--choco);color:var(--crema)}
 .col{display:grid;grid-template-columns:1fr 1fr;gap:20px}
 h4{font-size:.7rem;text-transform:uppercase;letter-spacing:.14em;opacity:.6;
    margin:0 0 4px;font-weight:400}
 .p p{margin:0 0 12px}
 .p ul{margin:0 0 12px;padding-left:18px}
 .tot{font-size:1.15rem}
 textarea{width:100%;font:0.86rem/1.45 Menlo,Consolas,monospace;color:var(--choco);
          background:#fff;border:1px solid var(--linea);border-radius:3px;padding:10px;
          resize:vertical;margin-top:4px}
 footer{margin-top:12px}
 .b{display:inline-block;text-decoration:none;background:var(--choco);color:var(--crema);
    padding:9px 16px;border-radius:3px;font-size:.72rem;letter-spacing:.12em;
    text-transform:uppercase}
 .b.ghost{background:none;color:var(--choco);border:1px solid var(--linea)}
 @media(max-width:640px){ .col{grid-template-columns:1fr} }
</style>
<h1>Pedidos — Ofelia St</h1>
<div class="wrap">${dentro}</div>`;
}
