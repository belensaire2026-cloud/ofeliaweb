/* ═══════════════════════════════════════════════════════════════
   /api/envios — cotiza el envío con Correo Argentino (MiCorreo)
   ───────────────────────────────────────────────────────────────
   Variables de entorno que hay que cargar en Cloudflare:
     CORREO_USER_TOKEN      usuario de la API (lo da Correo)
     CORREO_PASSWORD_TOKEN  contraseña de la API
     CORREO_CUSTOMER_ID     tu número de cliente
     CORREO_CP_ORIGEN       tu código postal (desde dónde despachás)
     CORREO_ENTORNO         "test" o "prod"   (por defecto: test)

   Si falta cualquiera de esas, la función NO rompe: devuelve las
   tarifas fijas de abajo y avisa origen:"fijas". Así la web anda
   igual mientras Correo te habilita las credenciales.
   ═══════════════════════════════════════════════════════════════ */

const TARIFAS_FIJAS = [
  { tipo:'S', nombre:'Correo Argentino — a sucursal',  precio: 6500 },
  { tipo:'D', nombre:'Correo Argentino — a domicilio', precio: 8500 },
];

/* Un pedido de joyería entra en una caja chica. */
const PAQUETE = { weight: 500, height: 6, width: 16, length: 12 };

const BASE = e => e === 'prod'
  ? 'https://api.correoargentino.com.ar/micorreo/v1'
  : 'https://apitest.correoargentino.com.ar/micorreo/v1';

async function token(env){
  const r = await fetch(BASE(env.CORREO_ENTORNO) + '/token', {
    method:'POST',
    headers:{ Authorization:'Basic ' + btoa(`${env.CORREO_USER_TOKEN}:${env.CORREO_PASSWORD_TOKEN}`) }
  });
  if(!r.ok) throw new Error('token ' + r.status);
  return (await r.json()).token;
}

const listo = env => env.CORREO_USER_TOKEN && env.CORREO_PASSWORD_TOKEN
                  && env.CORREO_CUSTOMER_ID && env.CORREO_CP_ORIGEN;

const json = (o, s=200) => new Response(JSON.stringify(o), {
  status:s, headers:{ 'content-type':'application/json; charset=utf-8' }
});

export async function onRequestPost({ request, env }){
  let cp = '';
  try { cp = String((await request.json()).cp || '').replace(/\D/g,''); } catch(_){}
  if(cp.length < 4) return json({ error:'cp_invalido' }, 400);

  if(!listo(env)) return json({ origen:'fijas', opciones:TARIFAS_FIJAS });

  try{
    const t = await token(env);
    const pedir = async deliveredType => {
      const r = await fetch(BASE(env.CORREO_ENTORNO) + '/rates', {
        method:'POST',
        headers:{ Authorization:'Bearer ' + t, 'Content-Type':'application/json' },
        body: JSON.stringify({
          customerId: env.CORREO_CUSTOMER_ID,
          postalCodeOrigin: env.CORREO_CP_ORIGEN,
          postalCodeDestination: cp,
          deliveredType,
          dimensions: PAQUETE
        })
      });
      if(!r.ok) return [];
      const d = await r.json();
      return (d.rates || []).map(x => ({
        tipo: x.deliveredType,
        nombre: (x.productName || 'Correo Argentino') +
                (x.deliveredType === 'S' ? ' — a sucursal' : ' — a domicilio'),
        precio: Math.ceil(Number(x.price) || 0)
      }));
    };
    const opciones = [...await pedir('S'), ...await pedir('D')].filter(o => o.precio > 0);
    if(!opciones.length) return json({ origen:'fijas', opciones:TARIFAS_FIJAS });
    return json({ origen:'correo', opciones });
  }catch(e){
    return json({ origen:'fijas', opciones:TARIFAS_FIJAS, nota:String(e.message||e) });
  }
}

/* Sucursales de Correo para la opción "retirar en sucursal". */
export async function onRequestGet({ request, env }){
  const prov = new URL(request.url).searchParams.get('provincia');
  if(!prov) return json({ error:'falta_provincia' }, 400);
  if(!listo(env)) return json({ sucursales:[] });
  try{
    const t = await token(env);
    const r = await fetch(
      `${BASE(env.CORREO_ENTORNO)}/agencies?customerId=${env.CORREO_CUSTOMER_ID}&provinceCode=${encodeURIComponent(prov)}`,
      { headers:{ Authorization:'Bearer ' + t } });
    if(!r.ok) return json({ sucursales:[] });
    const d = await r.json();
    return json({ sucursales: (Array.isArray(d)?d:[])
      .filter(s => s.status === 'ACTIVE' && s.services?.pickupAvailability)
      .map(s => ({
        code: s.code,
        nombre: s.name,
        direccion: [s.location?.address?.streetName, s.location?.address?.streetNumber]
                     .filter(Boolean).join(' '),
        localidad: s.location?.address?.locality || '',
        cp: s.location?.address?.postalCode || ''
      })) });
  }catch(_){ return json({ sucursales:[] }); }
}
