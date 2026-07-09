/*
 * Module partagé de l'effet "empreinte" (mode photo).
 * Tourne à l'identique côté navigateur (prévisu du cacheur) et côté Node
 * via @napi-rs/canvas (composite serveur = vérité anti-triche).
 *
 * Principe : le personnage n'est jamais peint en aplat, la texture de la scène
 * continue à travers la silhouette ; seuls des calques d'ombre/lumière la
 * trahissent (ombre de contact pondérée vers le bas, liseré d'occlusion au sol,
 * voile interne, liseré lumineux haut). Intensités par difficulté.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(); // Node : injecter la factory via init()
  } else {
    root.MCImprint = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MS = 512; // résolution du masque silhouette (espace "masque")

  let createCanvasFn = null; // (w,h) -> canvas
  if (typeof document !== "undefined") {
    createCanvasFn = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    };
  }

  function init(fn) { createCanvasFn = fn; }
  function cv(w, h) {
    if (!createCanvasFn) throw new Error("MCImprint.init(createCanvas) requis côté Node");
    return createCanvasFn(w, h || w);
  }

  // -------------------------------------------------------------------------
  // Silhouette mannequin (référence utilisateur : humanoïde lisse vu de face,
  // tête ovale, bras légèrement écartés, jambes jointes). Dessinée dans un
  // carré size x size, hauteur du perso = size.
  // -------------------------------------------------------------------------
  function capsule(c, x1, y1, x2, y2, r) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
    c.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
    c.closePath();
    c.fill();
  }

  function drawMannequin(c, s) {
    const cx = s / 2;
    c.fillStyle = "#fff";
    c.beginPath(); c.ellipse(cx, s * 0.13, s * 0.105, s * 0.125, 0, 0, 7); c.fill();
    capsule(c, cx, s * 0.23, cx, s * 0.28, s * 0.05); // cou
    c.beginPath(); c.ellipse(cx, s * 0.315, s * 0.155, s * 0.075, 0, 0, 7); c.fill(); // épaules
    c.beginPath();
    c.moveTo(cx - s * 0.155, s * 0.315);
    c.bezierCurveTo(cx - s * 0.165, s * 0.45, cx - s * 0.135, s * 0.52, cx - s * 0.125, s * 0.565);
    c.lineTo(cx + s * 0.125, s * 0.565);
    c.bezierCurveTo(cx + s * 0.135, s * 0.52, cx + s * 0.165, s * 0.45, cx + s * 0.155, s * 0.315);
    c.closePath(); c.fill();
    c.beginPath(); c.ellipse(cx, s * 0.565, s * 0.125, s * 0.06, 0, 0, 7); c.fill(); // bassin
    capsule(c, cx - s * 0.19, s * 0.33, cx - s * 0.225, s * 0.60, s * 0.048); // bras
    capsule(c, cx + s * 0.19, s * 0.33, cx + s * 0.225, s * 0.60, s * 0.048);
    capsule(c, cx - s * 0.062, s * 0.60, cx - s * 0.068, s * 0.945, s * 0.062); // jambes
    capsule(c, cx + s * 0.062, s * 0.60, cx + s * 0.068, s * 0.945, s * 0.062);
  }

  let _mask = null, _maskData = null;
  function mask() {
    if (!_mask) {
      _mask = cv(MS);
      drawMannequin(_mask.getContext("2d"), MS);
    }
    return _mask;
  }
  function maskData() {
    if (!_maskData) {
      _maskData = mask().getContext("2d").getImageData(0, 0, MS, MS).data;
    }
    return _maskData;
  }

  // -------------------------------------------------------------------------
  // Calques dérivés du masque
  // -------------------------------------------------------------------------
  // liseré : masque moins masque décalé. dir=+1 : bords bas ; -1 : bords haut
  function rimMask(offsetPx, dir) {
    const c = cv(MS);
    const x = c.getContext("2d");
    x.drawImage(mask(), 0, 0);
    x.globalCompositeOperation = "destination-out";
    x.drawImage(mask(), 0, -dir * offsetPx);
    return c;
  }
  // ombre externe : masque flouté moins masque net, pondérée par un gradient
  // vertical (lumière du haut : quasi rien à la tête, plein aux pieds)
  function outerShadowMask(blurPx, dyPx) {
    const c = cv(MS);
    const x = c.getContext("2d");
    x.filter = "blur(" + blurPx + "px)";
    x.drawImage(mask(), 0, dyPx);
    x.filter = "none";
    x.globalCompositeOperation = "destination-out";
    x.drawImage(mask(), 0, 0);
    x.globalCompositeOperation = "destination-in";
    const g = x.createLinearGradient(0, 0, 0, MS);
    g.addColorStop(0, "rgba(0,0,0,0.08)");
    g.addColorStop(0.45, "rgba(0,0,0,0.40)");
    g.addColorStop(0.8, "rgba(0,0,0,1)");
    x.fillStyle = g;
    x.fillRect(0, 0, MS, MS);
    return c;
  }
  function tinted(src, color) {
    const c = cv(MS);
    const x = c.getContext("2d");
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = "source-in";
    x.fillStyle = color;
    x.fillRect(0, 0, MS, MS);
    return c;
  }

  // -------------------------------------------------------------------------
  // Presets de difficulté (validés visuellement sur le banc de test).
  // Unités : px dans l'espace masque 512, alphas [0..1].
  // -------------------------------------------------------------------------
  const PRESETS = {
    easy: { shadowAlpha: 0.50, shadowBlur: 5, shadowDy: 18, rimDarkAlpha: 0.40, rimSize: 18, rimLightAlpha: 0.30, veilAlpha: 0.09 },
    normal: { shadowAlpha: 0.38, shadowBlur: 7, shadowDy: 15, rimDarkAlpha: 0.30, rimSize: 15, rimLightAlpha: 0.22, veilAlpha: 0.05 },
    hard: { shadowAlpha: 0.26, shadowBlur: 9, shadowDy: 12, rimDarkAlpha: 0.20, rimSize: 12, rimLightAlpha: 0.13, veilAlpha: 0.03 },
  };

  // -------------------------------------------------------------------------
  // Rendu : dessine l'empreinte sur ctx, perso centré en (x,y), hauteur sizePx.
  // flip : miroir horizontal. p : preset (ou objet de mêmes champs).
  // -------------------------------------------------------------------------
  function draw(ctx, x, y, sizePx, p, flip) {
    p = typeof p === "string" ? PRESETS[p] || PRESETS.normal : p || PRESETS.normal;
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    ctx.translate(-sizePx / 2, -sizePx / 2);

    const osm = tinted(outerShadowMask(p.shadowBlur, p.shadowDy), "#2c2418");
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = p.shadowAlpha;
    ctx.drawImage(osm, 0, 0, sizePx, sizePx);

    const dark = tinted(rimMask(p.rimSize, +1), "#33291c");
    ctx.globalAlpha = p.rimDarkAlpha;
    ctx.drawImage(dark, 0, 0, sizePx, sizePx);

    const veil = tinted(mask(), "#241f16");
    ctx.globalAlpha = p.veilAlpha;
    ctx.drawImage(veil, 0, 0, sizePx, sizePx);

    const lite = tinted(rimMask(p.rimSize * 0.75, -1), "#fffbe8");
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = p.rimLightAlpha;
    ctx.drawImage(lite, 0, 0, sizePx, sizePx);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Hit test : (clickX, clickY) et (px, py) dans le MÊME espace (px scène),
  // sizePx = hauteur du perso, tolPx = tolérance. Échantillonne l'alpha du
  // masque au point + sur deux anneaux de tolérance.
  // -------------------------------------------------------------------------
  function alphaAt(mx, my) {
    if (mx < 0 || my < 0 || mx >= MS || my >= MS) return 0;
    return maskData()[((my | 0) * MS + (mx | 0)) * 4 + 3];
  }
  function hitTest(clickX, clickY, px, py, sizePx, flip, tolPx) {
    const k = MS / sizePx; // px scène -> px masque
    let mx = (clickX - px) * k + MS / 2;
    const my = (clickY - py) * k + MS / 2;
    if (flip) mx = MS - mx;
    if (alphaAt(mx, my) > 10) return true;
    const tolM = (tolPx || 0) * k;
    if (tolM <= 0) return false;
    for (const r of [tolM, tolM * 0.5]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        if (alphaAt(mx + Math.cos(a) * r, my + Math.sin(a) * r) > 10) return true;
      }
    }
    return false;
  }

  // Silhouette pleine (pour l'animation de révélation : le perso "apparaît").
  function drawSolid(ctx, x, y, sizePx, flip, color) {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    ctx.translate(-sizePx / 2, -sizePx / 2);
    ctx.drawImage(tinted(mask(), color || "#f2ede4"), 0, 0, sizePx, sizePx);
    ctx.restore();
  }

  return { init, draw, drawSolid, hitTest, PRESETS, MASK_SIZE: MS, _maskCanvas: mask };
});
