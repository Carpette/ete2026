// Worker Cloudflare — sert le site (public/) + API de position des pilotes.
//
//   GET  /api/position  → lecture publique : liste des positions [ {id,name,color,lat,lng,accuracy,updatedAt}, ... ]
//   POST /api/position  → écriture protégée. Le mot de passe (en-tête x-admin-token)
//                         identifie QUEL pilote met à jour sa position.
//
// Pour ajouter / renommer un pilote : modifie la liste RIDERS ci-dessous,
// puis crée le secret correspondant :  npx wrangler secret put <tokenVar>
//
// Bindings attendus (voir wrangler.toml + secrets) :
//   - ASSETS            : fichiers statiques du dossier public/
//   - POSITION_KV       : namespace KV pour stocker les positions
//   - ADMIN_TOKEN       : mot de passe du pilote "moi" (Quentin)
//   - ADMIN_TOKEN_AMIE  : mot de passe du pilote "amie"

const RIDERS = [
  { id: "moi",   name: "Quentin",        color: "#3ba0ff", tokenVar: "ADMIN_TOKEN" },
  { id: "jilly", name: "Jilly & Emilie", color: "#e05c1a", tokenVar: "ADMIN_TOKEN_JILLY" },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/position") {
      if (request.method === "GET") {
        const out = [];
        for (const r of RIDERS) {
          const d = await env.POSITION_KV.get("pos:" + r.id);
          if (d) out.push(JSON.parse(d));
        }
        return json(out);
      }

      if (request.method === "POST") {
        const token = request.headers.get("x-admin-token") || "";
        const rider = riderForToken(token, env);
        if (!rider) return json({ error: "unauthorized" }, 401);

        let body;
        try { body = await request.json(); }
        catch { return json({ error: "bad json" }, 400); }

        const lat = Number(body.lat), lng = Number(body.lng);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return json({ error: "bad coords" }, 400);
        }
        const rec = {
          id: rider.id,
          name: rider.name,
          color: rider.color,
          lat, lng,
          accuracy: Math.round(Number(body.accuracy) || 0),
          updatedAt: Date.now()
        };
        await env.POSITION_KV.put("pos:" + rider.id, JSON.stringify(rec));
        return json(rec);
      }

      return json({ error: "method not allowed" }, 405);
    }

    // Tout le reste → fichiers statiques (index.html, etc.)
    return env.ASSETS.fetch(request);
  }
};

// Identifie le pilote à partir de son mot de passe (jamais exposé côté client).
function riderForToken(token, env) {
  if (!token) return null;
  for (const r of RIDERS) {
    const secret = env[r.tokenVar];
    if (secret && token === secret) return r;
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
