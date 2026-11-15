/* ═══════════════════════════════════════════════════════════════
   Avisos por mail — se manda uno cada vez que entra un pedido
   ───────────────────────────────────────────────────────────────
   Variables en Cloudflare:
     RESEND_API_KEY   clave de resend.com (va como SECRETO)
     AVISO_EMAIL      a dónde llega el aviso (tu casilla)
     AVISO_FROM       opcional. Por defecto usa el remitente de
                      prueba de Resend, que solo puede escribirle
                      a la casilla con la que abriste la cuenta.

   Si falta cualquiera de las dos primeras, no se manda nada y la
   web sigue funcionando igual: el pedido queda guardado en KV.
   ═══════════════════════════════════════════════════════════════ */

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const plata = n => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

/* Arma el renglón de entrega. Es lo que más importa para despachar:
   si es a sucursal tiene que decir CUÁL, no solo "a sucursal".     */
function comoEntregar(e = {}){
  if(e.modo === 'retiro') return 'Retira en persona';
  if(e.modo === 'sucursal')
    return `Sucursal de Correo: ${e.sucursal || '(no eligió, hay que coordinar)'}`
         + `\n  ${[e.localidad, e.provincia, e.cp && 'CP ' + e.cp].filter(Boolean).join(' · ')}`;
  const calle = [e.calle, e.numero].filter(Boolean).join(' ');
  return `Envío a domicilio: ${calle}${e.piso ? ', ' + e.piso : ''}`
       + `\n  ${[e.localidad, e.provincia, e.cp && 'CP ' + e.cp].filter(Boolean).join(' · ')}`;
}

export function textoPedido(p = {}){
  const c = p.comprador || {};
  const items = (p.items || [])
    .map(i => `  · ${i.qty || 1} × ${i.nombre || i.id}`).join('\n');
  return [
    `Pedido ${p.ref}`,
    `${p.medio === 'mp' ? 'Mercado Pago' : 'Transferencia'} — ${p.estado}`,
    '',
    items || '  (sin piezas)',
    '',
    `Total: ${plata(p.total)}${p.cupon ? `  (cupón ${p.cupon})` : ''}`,
    '',
    comoEntregar(p.envio),
    (p.envio && p.envio.precio ? `  Envío cotizado: ${plata(p.envio.precio)}` : ''),
    '',
    `${c.nombre || '(sin nombre)'}`,
    `  DNI ${c.dni || '—'}`,
    `  Tel ${c.telefono || '—'}`,
    `  ${c.email || '—'}`
  ].filter(l => l !== null).join('\n');
}

function htmlPedido(p = {}, site = ''){
  const cuerpo = esc(textoPedido(p)).replace(/\n/g, '<br>');
  const link = site
    ? `<p style="margin:22px 0 0"><a href="${esc(site)}/api/pedidos"
         style="color:#331C14">Ver todos los pedidos</a></p>` : '';
  return `<div style="font-family:Georgia,serif;color:#331C14;background:#E3CDBD;
     padding:28px;line-height:1.65;font-size:15px">
     <div style="max-width:520px;margin:0 auto;background:#f3e7dc;padding:26px 28px">
     ${cuerpo}${link}</div></div>`;
}

export async function avisarPorMail(env, p, site = ''){
  if(!env.RESEND_API_KEY || !env.AVISO_EMAIL) return false;
  const quien = p.medio === 'mp' ? 'Mercado Pago' : 'transferencia';
  try{
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.AVISO_FROM || 'Ofelia St <onboarding@resend.dev>',
        to: [env.AVISO_EMAIL],
        reply_to: (p.comprador && p.comprador.email) || undefined,
        subject: `${p.estado === 'pagado' ? 'Pedido pagado' : 'Pedido nuevo'} ${p.ref}`
               + ` — ${plata(p.total)} (${quien})`,
        text: textoPedido(p),
        html: htmlPedido(p, site)
      })
    });
    return r.ok;
  }catch(_){ return false; }
}
