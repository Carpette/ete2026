// Worker Cloudflare — sert le site (public/) + API positions + API médias géolocalisés.
//
// POSITIONS
//   GET  /api/position        → [ {id,name,color,lat,lng,accuracy,updatedAt}, ... ]
//   POST /api/position        → écriture protégée (x-admin-token identifie le pilote)
//
// MÉDIAS (photos + vidéos YouTube), tagués à la position GPS du moment
//   GET  /api/media           → [ {id,type,url,thumb?,caption,lat,lng,rider,createdAt}, ... ]
//   POST /api/media           → écriture protégée :
//                                 - photo : multipart/form-data (file, lat, lng, caption)
//                                 - youtube : JSON { type:"youtube", url, lat, lng, caption }
//   GET  /api/media/file/<id> → sert l'image stockée en KV
//
// Pour ajouter / renommer un pilote : modifie RIDERS + crée le secret (npx wrangler secret put <tokenVar>)
//
// Bindings : ASSETS (public/), POSITION_KV (KV), secrets ADMIN_TOKEN, ADMIN_TOKEN_JILLY

const RIDERS = [
  { id: "moi",   name: "Quentin",        color: "#3ba0ff", tokenVar: "ADMIN_TOKEN" },
  { id: "jilly", name: "Jilly & Emilie", color: "#e05c1a", tokenVar: "ADMIN_TOKEN_JILLY" },
];

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ───────── POSITIONS ─────────
    if (path === "/api/position") {
      if (request.method === "GET") {
        const out = [];
        for (const r of RIDERS) {
          const d = await env.POSITION_KV.get("pos:" + r.id);
          if (d) out.push(JSON.parse(d));
        }
        return json(out);
      }
      if (request.method === "POST") {
        const rider = riderForToken(request.headers.get("x-admin-token"), env);
        if (!rider) return json({ error: "unauthorized" }, 401);
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const { lat, lng } = coords(body);
        if (lat === null) return json({ error: "bad coords" }, 400);
        const rec = {
          id: rider.id, name: rider.name, color: rider.color,
          lat, lng, accuracy: Math.round(Number(body.accuracy) || 0), updatedAt: Date.now()
        };
        await env.POSITION_KV.put("pos:" + rider.id, JSON.stringify(rec));
        return json(rec);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // ───────── MÉDIAS : fichier image ─────────
    if (path.startsWith("/api/media/file/")) {
      const id = path.substring("/api/media/file/".length);
      const { value, metadata } = await env.POSITION_KV.getWithMetadata("media:photo:" + id, { type: "arrayBuffer" });
      if (!value) return new Response("not found", { status: 404 });
      return new Response(value, {
        headers: {
          "content-type": (metadata && metadata.contentType) || "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable"
        }
      });
    }

    // ───────── MÉDIAS : liste / ajout ─────────
    if (path === "/api/media") {
      if (request.method === "GET") {
        const idx = await env.POSITION_KV.get("media:index");
        return json(idx ? JSON.parse(idx) : []);
      }
      if (request.method === "POST") {
        const rider = riderForToken(request.headers.get("x-admin-token"), env);
        if (!rider) return json({ error: "unauthorized" }, 401);

        const ct = request.headers.get("content-type") || "";
        let item;

        if (ct.includes("application/json")) {
          // Vidéo YouTube
          let body;
          try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
          const videoId = parseYouTubeId(body.url || "");
          if (!videoId) return json({ error: "lien YouTube invalide" }, 400);
          const { lat, lng } = coords(body);
          if (lat === null) return json({ error: "bad coords" }, 400);
          item = {
            id: crypto.randomUUID(), type: "youtube", videoId,
            url: "https://www.youtube.com/watch?v=" + videoId,
            thumb: "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg",
            caption: String(body.caption || "").slice(0, 200),
            lat, lng, rider: { name: rider.name, color: rider.color }, createdAt: Date.now()
          };
        } else {
          // Photo (multipart/form-data)
          let form;
          try { form = await request.formData(); } catch { return json({ error: "bad form" }, 400); }
          const file = form.get("file");
          if (!file || typeof file === "string") return json({ error: "no file" }, 400);
          const lat = Number(form.get("lat")), lng = Number(form.get("lng"));
          if (!isFinite(lat) || !isFinite(lng)) return json({ error: "bad coords" }, 400);
          const buf = await file.arrayBuffer();
          if (buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "fichier trop volumineux" }, 413);
          const id = crypto.randomUUID();
          const contentType = file.type || "image/jpeg";
          await env.POSITION_KV.put("media:photo:" + id, buf, { metadata: { contentType } });
          item = {
            id, type: "photo", url: "/api/media/file/" + id, contentType,
            caption: String(form.get("caption") || "").slice(0, 200),
            lat, lng, rider: { name: rider.name, color: rider.color }, createdAt: Date.now()
          };
        }

        const idxRaw = await env.POSITION_KV.get("media:index");
        const idx = idxRaw ? JSON.parse(idxRaw) : [];
        idx.unshift(item);
        if (idx.length > 500) idx.length = 500;
        await env.POSITION_KV.put("media:index", JSON.stringify(idx));
        return json(item);
      }
      return json({ error: "method not allowed" }, 405);
    }

    // Tout le reste → fichiers statiques
    return env.ASSETS.fetch(request);
  }
};

function riderForToken(token, env) {
  if (!token) return null;
  for (const r of RIDERS) {
    const secret = env[r.tokenVar];
    if (secret && token === secret) return r;
  }
  return null;
}

function coords(o) {
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { lat: null, lng: null };
  }
  return { lat, lng };
}

function parseYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
