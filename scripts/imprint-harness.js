/*
 * Harness Node de l'effet empreinte : composite la silhouette sur une vraie
 * scène aux 3 difficultés + vérifie le hitTest. Sorties PNG pour inspection.
 * Usage : node scripts/imprint-harness.js [outDir]
 */
const path = require("path");
const fs = require("fs");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const Imprint = require("../shared/imprint");

Imprint.init((w, h) => createCanvas(w, h));

const SCENE = path.join(__dirname, "..", "public", "scenes", "meadow-fish-clouds.webp");
const OUT = process.argv[2] || path.join(__dirname, "..", "public", "dev");
const W = 1920, H = 1080;

(async () => {
  const img = await loadImage(SCENE);
  let pass = 0, fail = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; console.log("  ✅ " + name); }
    else { fail++; console.log("  ❌ " + name); }
  };

  // --- composites aux 3 difficultés ---
  for (const diff of ["easy", "normal", "hard"]) {
    const c = createCanvas(W, H);
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, W, H);
    // perso en bas à droite dans l'herbe, ~9% de la hauteur d'écran... non :
    // hauteur perso = 12% de H pour l'inspection (visible dans le PNG de test)
    Imprint.draw(x, W * 0.62, H * 0.78, H * 0.13, diff, diff === "hard");
    const buf = c.toBuffer("image/png");
    const f = path.join(OUT, "composite-" + diff + ".png");
    fs.writeFileSync(f, buf);
    console.log("  \u{1F4C4} " + f + " (" + Math.round(buf.length / 1024) + " Ko)");
  }

  // --- webp (format servi en jeu) ---
  {
    const c = createCanvas(W, H);
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, W, H);
    Imprint.draw(x, W * 0.3, H * 0.7, H * 0.09, "normal", false);
    const webp = c.toBuffer("image/webp", 80);
    ok("encodage WebP < 600 Ko (" + Math.round(webp.length / 1024) + " Ko)", webp.length < 600 * 1024);
  }

  // --- hitTest ---
  const px = 960, py = 540, size = 140, tol = 14;
  ok("hit au centre du corps", Imprint.hitTest(px, py + size * 0.05, px, py, size, false, tol));
  ok("hit sur la tête", Imprint.hitTest(px, py - size * 0.37, px, py, size, false, tol));
  ok("hit sur un pied", Imprint.hitTest(px - size * 0.065, py + size * 0.44, px, py, size, false, tol));
  ok("miss loin du perso", !Imprint.hitTest(px + size * 2, py, px, py, size, false, tol));
  ok("miss juste hors tolérance (bras + tol + 6px)",
     !Imprint.hitTest(px + size * 0.273 + tol + 6, py + size * 0.05, px, py, size, false, tol));
  ok("hit dans la tolérance (bras + tol - 2px)",
     Imprint.hitTest(px + size * 0.273 + tol - 2, py + size * 0.05, px, py, size, false, tol));
  // flip : le point du bras droit devient bras gauche
  ok("hit symétrique avec flip", Imprint.hitTest(px - size * 0.21, py, px, py, size, true, tol));

  console.log(`\n===== imprint-harness : ${pass} ok, ${fail} ko =====`);
  process.exit(fail ? 1 : 0);
})();
