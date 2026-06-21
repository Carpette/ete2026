// Worker Cloudflare — sert le site (public/) + API de position du pilote.
//
//   GET  /api/position  → lecture publique : { lat, lng, accuracy, updatedAt } ou null
//   POST /api/position  → écriture protégée (en-tête x-admin-token == secret ADMIN_TOKEN)
//
// Bindings attendus (voir wrangler.toml) :
//   - ASSETS       : fichiers statiques du dossier public/
//   - POSITION_KV  : namespace KV pour stocker la position
//   - ADMIN_TOKEN  : secret (mot de passe admin), défini dans le dashboard Cloudflare

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/position") {
      if (request.method === "GET") {
        const data = await env.POSITION_KV.get("current");
        return json(data ? JSON.parse(data) : null);
      }

      if (request.method === "POST") {
        const token = request.headers.get("x-admin-token") || "";
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
          return json({ error: "unauthorized" }, 401);
        }
        let body;
        try { body = await request.json(); }
        catch { return json({ error: "bad json" }, 400); }

        const lat = Number(body.lat), lng = Number(body.lng);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return json({ error: "bad coords" }, 400);
        }
        const rec = {
          lat, lng,
          accuracy: Math.round(Number(body.accuracy) || 0),
          updatedAt: Date.now()
        };
        await env.POSITION_KV.put("current", JSON.stringify(rec));
        return json(rec);
      }

      return json({ error: "method not allowed" }, 405);
    }

    // Tout le reste → fichiers statiques (index.html, etc.)
    return env.ASSETS.fetch(request);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
