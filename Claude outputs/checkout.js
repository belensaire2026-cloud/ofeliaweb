/* ═══════════════════════════════════════════════════════════════
   /api/checkout — arma el pago en Mercado Pago (Checkout Pro)
   ───────────────────────────────────────────────────────────────
   Variables de entorno en Cloudflare:
     MP_ACCESS_TOKEN   credencial de producción de Mercado Pago
                       (va como SECRETO, encriptada)
     SITE_URL          https://tudominio.com   (sin barra al final)

   IMPORTANTE: los precios NO se toman de lo que manda el navegador.
   Se vuelven a leer de tu planilla publicada. Si alguien edita el
   precio desde la consola del navegador, acá se descarta.
   ═══════════════════════════════════════════════════════════════ */

/* En 0: no se le suma nada al pago por Mercado Pago.
   Si alguna vez lo cambiás, tiene que ser igual al
   RECARGO_TARJETA de index.html o el total no coincide. */
const RECARGO_TARJETA = 0;

const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSd6xMPGRN1S6Bu2aeRmDE4FiUGLxV5lFeIEbsA9QTqc9cjSUnxeDKwGFjFig96TiuCwXr5ZRlHaGVw/pub?gid=158291260&single=true&output=csv';

const json = (o, s=200) => new Response(JSON.stringify(o), {
  status:s, headers:{ 'content-type':'application/json; charset=utf-8' }
});

const slug = s => String(s||'').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

function parseCSV(txt){
  const filas=[]; let f=[], c='', q=false;
  for(let i=0;i<txt.length;i++){
    const ch=txt[i];
    if(q){ if(ch==='"'){ if(txt[i+1]==='"'){c+='"';i++;} else q=false; } else c+=ch; }
    else if(ch==='"') q=true;
    else if(ch===','){ f.push(c); c=''; }
    else if(ch==='\n'){ f.push(c); filas.push(f); f=[]; c=''; }
    else if(ch!=='\r') c+=ch;
  }
  if(c||f.length){ f.push(c); filas.push(f); }
  return filas;
}
const plata = s => Number(String(s||'').replace(/[^\d]/g,'')) || 0;

/* Catálogo real, con precio y stock, leído de la planilla. */
async function catalogo(){
  const r = await fetch(SHEET_CSV + '&cb=' + Math.floor(Date.now()/60000));
  if(!r.ok) throw new Error('planilla');
  const filas = parseCSV(await r.text());
  const iHead = filas.findIndex(f => /^producto$/i.test((f[0]||'').trim()));
  const mapa = new Map();
  for(const f of filas.slice(iHead+1)){
    const nombre = (f[0]||'').trim();
    if(!nombre) continue;
    mapa.set(slug(nombre) + '-' + slug(f[1]), {
      nombre, material:(f[1]||'').trim(),
      precio: plata(f[3]),
      stock: Number(f[4])||0,
      talles: { 'Chico':Number(f[5])||0, 'Mediano':Number(f[6])||0, 'Grande':Number(f[7])||0 }
    });
  }
  return mapa;
}

export async function crearPago(request, env){
  if(!env.MP_ACCESS_TOKEN) return json({ error:'mp_sin_configurar' }, 503);

  let body;
  try { body = await request.json(); } catch(_){ return json({ error:'json' }, 400); }
  const { items = [], envio = {}, comprador = {} } = body;

  if(!Array.isArray(items) || !items.length) return json({ error:'carrito_vacio' }, 400);
  if(!comprador.email || !comprador.nombre)   return json({ error:'faltan_datos' }, 400);

  let cat;
  try { cat = await catalogo(); } catch(_){ return json({ error:'catalogo' }, 502); }

  /* Revalidar cada línea contra la planilla. */
  const mpItems = [];
  for(const it of items){
    const p = cat.get(String(it.id||''));
    if(!p)            return json({ error:'pieza_inexistente', id:it.id }, 409);
    if(p.precio <= 0) return json({ error:'sin_precio', id:it.id }, 409);

    const qty = Math.max(1, Math.min(20, parseInt(it.qty,10) || 1));
    const talle = String(it.talle || 'Único');
    const hay = talle === 'Único'
      ? p.stock - (p.talles.Chico + p.talles.Mediano + p.talles.Grande)
      : (p.talles[talle] || 0);
    const disponible = talle === 'Único' ? (hay > 0 ? hay : p.stock) : hay;
    if(qty > disponible) return json({ error:'sin_stock', id:it.id, talle, disponible }, 409);

    mpItems.push({
      id: it.id,
      title: p.nombre + (talle !== 'Único' ? ` · talle ${talle}` : ''),
      description: p.material,
      quantity: qty,
      unit_price: p.precio,
      currency_id: 'ARS'
    });
  }

  const costoEnvio = Math.max(0, Math.round(Number(envio.precio) || 0));

  /* El recargo se recalcula acá; no se confía en el navegador. */
  const subtotal = mpItems.reduce((a, i) => a + i.unit_price * i.quantity, 0);
  const recargo  = Math.round((subtotal + costoEnvio) * RECARGO_TARJETA);

  const ref  = 'OF-' + Date.now().toString(36).toUpperCase();
  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const dos  = n => (Math.round(n * 100) / 100).toFixed(2);

  /* Orders API: los items van con importes en texto y con dos decimales.
     El envío y el recargo se suman como líneas más. */
  const lineas = mpItems.map(i => ({
    title: i.title,
    description: i.description,
    quantity: i.quantity,
    unit_price: dos(i.unit_price),
    total_amount: dos(i.unit_price * i.quantity),
    unit_measure: 'unit'
  }));
  if (costoEnvio > 0) lineas.push({
    title: envio.nombre || 'Envío', quantity: 1,
    unit_price: dos(costoEnvio), total_amount: dos(costoEnvio), unit_measure: 'unit'
  });
  if (recargo > 0) lineas.push({
    title: 'Costo de pago', quantity: 1,
    unit_price: dos(recargo), total_amount: dos(recargo), unit_measure: 'unit'
  });

  const total = subtotal + costoEnvio + recargo;

  const armarOrden = modo => ({
    type: 'online',
    processing_mode: modo,
    total_amount: dos(total),
    external_reference: ref,
    payer: {
      email: comprador.email,
      first_name: String(comprador.nombre || '').split(' ')[0] || undefined,
      identification: comprador.dni
        ? { type: 'DNI', number: String(comprador.dni) } : undefined
    },
    items: lineas,
    config: {
      online: {
        success_url: `${site}/?pago=ok&ref=${ref}`,
        pending_url: `${site}/?pago=pendiente&ref=${ref}`,
        failure_url: `${site}/?pago=error&ref=${ref}`,
        auto_return: 'approved'
      }
    }
  });

  const intentar = async modo => {
    const r = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        accept: 'application/json',
        'X-Idempotency-Key': ref + '-' + modo + '-' + crypto.randomUUID()
      },
      body: JSON.stringify(armarOrden(modo))
    });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (_) {}
    return { ok: r.ok, status: r.status, d, txt };
  };

  let res = await intentar('automatic');
  if (!res.ok || !res.d || !res.d.checkout_url) {
    const alt = await intentar('manual');
    if (alt.ok && alt.d && alt.d.checkout_url) res = alt;
    else return json({
      error: 'mp',
      detalle: 'Mercado Pago rechazo la orden',
      automatic: { status: res.status, cuerpo: res.txt.slice(0, 700) },
      manual:    { status: alt.status, cuerpo: alt.txt.slice(0, 700) }
    }, 502);
  }

  return json({ ref, url: res.d.checkout_url });
}
