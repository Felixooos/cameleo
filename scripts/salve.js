/*
 * Salve de test : compose un caméléon dans chaque scène du manifeste et
 * exporte le résultat en PNG lisible (dossier _salve/). Vérifie visuellement
 * que le compositing @napi-rs/canvas + shared/imprint fonctionne.
 * Lancement : node scripts/salve.js
 */
const path = require("path");
const fs = require("fs");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const C = require("../shared/constants");
const Imprint = require("../shared/imprint");
const MANIFEST = require("../shared/scenes/manifest.json");

Imprint.init((w, h) => createCanvas(w, h));
const W = C.PHOTO_SCENE_W, H = C.PHOTO_SCENE_H;
const OUT = path.join(__dirname, "..", "_salve");
fs.mkdirSync(OUT, { recursive: true });

// Placements pseudo-aléatoires déterministes (pas de Math.random pour rester reproductible).
function placementFor(i) {
  const gx = (i % 4) / 4 + 0.18;
  const gy = Math.floor(i / 4) / 3 + 0.28;
  return { x: Math.min(0.85, gx), y: Math.min(0.8, gy), flip: i % 2 === 0 };
}

(async () => {
  let ok = 0;
  const rows = [];
  for (let i = 0; i < MANIFEST.scenes.length; i++) {
    const s = MANIFEST.scenes[i];
    const preset = s.difficulty === "normal" ? "normal" : s.difficulty;
    const sz = C.PHOTO_CHAR_SCALE[preset === "normal" ? "normal" : s.difficulty] * H;
    const pl = placementFor(i);
    try {
      const img = await loadImage(path.join(__dirname, "..", "public", s.file));
      const c = createCanvas(W, H);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, W, H);
      Imprint.draw(ctx, pl.x * W, pl.y * H, sz, preset, pl.flip);
      const buf = c.toBuffer("image/png");
      const name = `${String(i + 1).padStart(2, "0")}-${s.id}.png`;
      fs.writeFileSync(path.join(OUT, name), buf);
      rows.push(`  ✅ ${name.padEnd(28)} ${(buf.length / 1024).toFixed(1)} Ko  (${s.difficulty}, pos ${pl.x.toFixed(2)}/${pl.y.toFixed(2)})`);
      ok++;
    } catch (e) {
      rows.push(`  ❌ ${s.id} : ${e.message}`);
    }
  }
  console.log(rows.join("\n"));
  console.log(`\n===== salve : ${ok}/${MANIFEST.scenes.length} composites générés -> ${OUT} =====`);
})();
