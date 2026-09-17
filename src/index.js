/* ═══════════════════════════════════════════════════════════════
   Ofelia St — Worker
   Sirve la web y atiende /api/envios y /api/checkout.
   ═══════════════════════════════════════════════════════════════ */
import { cotizar, sucursales } from './envios.js';
import { crearPago }           from './checkout.js';

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8' }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/envios') {
      if (request.method === 'POST') return cotizar(request, env);
      if (request.method === 'GET')  return sucursales(url, env);
      return json({ error: 'metodo' }, 405);
    }

    if (url.pathname === '/api/checkout') {
      if (request.method !== 'POST') return json({ error: 'metodo' }, 405);
      return crearPago(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
