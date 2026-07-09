/*
 * Moteur de peinture du bonhomme local (sans aucune UI/DOM).
 * game.js applique les coups de pinceau directement dans la vue de jeu (in-world).
 * Produit le canvas final du perso : contour sombre TOUJOURS visible + peau + finition.
 */
(function () {
  const S = window.SHARED;
  const SZ = S.SPRITE_SIZE; // résolution de la peau/silhouette

  let skin, sx, mask, mx, dark, dkx;
  let color = "#7fae5a";
  let finish = "matte"; // matte | glossy
  let charCache = null, dirty = true;

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h || w;
    return c;
  }

  // Silhouette du bonhomme (tête + corps + bras + pieds).
  function silhouette(ctx, s) {
    const cx = s / 2;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(cx, s * 0.27, s * 0.15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, s * 0.58, s * 0.20, s * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx - s * 0.21, s * 0.55, s * 0.07, s * 0.15, 0.3, 0, Math.PI * 2);
    ctx.ellipse(cx + s * 0.21, s * 0.55, s * 0.07, s * 0.15, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx - s * 0.10, s * 0.82, s * 0.08, s * 0.06, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + s * 0.10, s * 0.82, s * 0.08, s * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function init(c, f) {
    color = c || color;
    finish = f || finish;
    skin = canvas(SZ); sx = skin.getContext("2d");
    mask = canvas(SZ); mx = mask.getContext("2d");
    dark = canvas(SZ); dkx = dark.getContext("2d");
    silhouette(mx, SZ);
    silhouette(dkx, SZ);
    dkx.globalCompositeOperation = "source-in";
    dkx.fillStyle = "rgba(40,40,40,0.5)"; // contour gris semi-transparent (discret)
    dkx.fillRect(0, 0, SZ, SZ);
    dkx.globalCompositeOperation = "source-over";
    sx.fillStyle = color;
    sx.fillRect(0, 0, SZ, SZ);
    dirty = true;
  }

  function ensure() { if (!skin) init(); }

  function setColor(c) { color = c; }
  function setFinish(f) { finish = f; dirty = true; }
  function getColor() { return color; }
  function getFinish() { return finish; }

  function fill(c) {
    ensure();
    if (c) color = c;
    sx.fillStyle = color;
    sx.fillRect(0, 0, SZ, SZ);
    dirty = true;
  }

  // Coup de pinceau en coordonnées texture [0..SZ].
  function stroke(u, v, radius, c) {
    ensure();
    sx.fillStyle = c || color;
    sx.beginPath();
    sx.arc(u, v, radius, 0, Math.PI * 2);
    sx.fill();
    dirty = true;
  }

  // Peau découpée à la silhouette.
  function clippedSkin() {
    const t = canvas(SZ);
    const tx = t.getContext("2d");
    tx.drawImage(skin, 0, 0);
    tx.globalCompositeOperation = "destination-in";
    tx.drawImage(mask, 0, 0);
    return t;
  }

  // Construit le perso final : contour + peau + finition.
  function build() {
    ensure();
    if (!dirty && charCache) return charCache;
    const c = canvas(SZ);
    const cx = c.getContext("2d");
    // contour : silhouette grise agrandie derrière (très fin)
    const ring = 1.025, off = (SZ * (ring - 1)) / 2;
    cx.drawImage(dark, -off, -off, SZ * ring, SZ * ring);
    // peau découpée
    cx.drawImage(clippedSkin(), 0, 0);
    // Finition : seul le BRILLANT ajoute un reflet. Le MAT garde la couleur
    // EXACTE -> la pipette retrouve la teinte peinte au pixel près.
    if (finish === "glossy") {
      const overlay = canvas(SZ);
      const ox = overlay.getContext("2d");
      const g = ox.createLinearGradient(0, 0, 0, SZ);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.35, "rgba(255,255,255,0.10)");
      g.addColorStop(1, "rgba(0,0,0,0.12)");
      ox.fillStyle = g;
      ox.fillRect(0, 0, SZ, SZ);
      ox.globalCompositeOperation = "destination-in";
      ox.drawImage(mask, 0, 0);
      cx.drawImage(overlay, 0, 0);
    }
    charCache = c;
    dirty = false;
    return c;
  }

  function exportSprite() {
    return build().toDataURL("image/png");
  }

  // True si (u,v) en coordonnées texture tombe dans la silhouette (pour limiter la peinture).
  function inSilhouette(u, v) {
    ensure();
    if (u < 0 || v < 0 || u >= SZ || v >= SZ) return false;
    const a = mx.getImageData(u | 0, v | 0, 1, 1).data[3];
    return a > 10;
  }

  window.MCPaint = {
    init, fill, stroke, setColor, setFinish, getColor, getFinish,
    build, exportSprite, inSilhouette, SIZE: SZ,
  };
})();
