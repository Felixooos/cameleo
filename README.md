# 🦎 Mecha Cameleo

Deux modes de jeu de camouflage :

- **📸 Cache-cache photo (tour par tour)** : 2-8 joueurs. Chacun cache son mannequin sur une
  scène illustrée (style livre d'images, générées par IA avec une DA verrouillée). Le personnage
  n'est trahi que par une **empreinte** : la texture du décor continue à travers lui, seules des
  ombres douces le révèlent. Puis, tour par tour, la scène de chaque joueur s'affiche chez les
  autres : premier clic juste = points, 3 essais max, verrou entre les essais.
- **🦎 Mode carte (Mecha)** : cacheurs qui se peignent pour se fondre dans une carte vectorielle
  « tapis d'enfant », traqués par un chasseur en temps réel.

> Stack : **Node.js + Express + Socket.IO** (serveur autoritaire temps réel) ·
> **HTML5 Canvas + JS vanilla** (client, zéro build) · **@napi-rs/canvas** (compositing serveur).

## Anti-triche du mode photo (par construction)
- La position du cacheur **ne quitte jamais le serveur** avant la fin du tour.
- L'empreinte est **cuite dans l'image côté serveur** (module de rendu partagé
  `shared/imprint.js`, exécuté par Skia côté Node et par le canvas côté navigateur pour la
  prévisu). Les chercheurs ne reçoivent qu'un WebP tokenisé (`/photo/img/:token`, `no-store`,
  invalidé à la fin du tour).
- Le clic est **validé côté serveur** (hitTest sur le masque de la silhouette, tolérance
  réglée par la difficulté : 20/14/9 px).

## Pack de scènes
12 scènes générées via Seedream 4.5 (1 crédit/scène) avec un bloc de style verrouillé et une
image ancre en référence : 4 faciles (prairie, plage, neige, potager), 4 normales (hortensias,
fonds marins, marché, toits), 4 difficiles (jungle, bibliothèque, nuit, automne). Stockées en
WebP 1920x1080 dans `public/scenes/`, décrites dans `shared/scenes/manifest.json`.
Ajouter une scène : `node scripts/add_scene.js <id> <url> <thème> <difficulté>`.

---

## Lancer en local

```bash
npm install
npm start
# -> http://localhost:4000
```

Puis : **ouvre la page dans 2 onglets/fenêtres** (chacun au premier plan dans sa fenêtre).
1. Onglet A : choisis un pseudo → **Héberger** (tu démarres *chasseur*). Note le **code** affiché.
2. Onglet B : entre le code → **Rejoindre** (tu démarres *cacheur*).
3. Onglet A (hôte) : **Démarrer**.

> ⚠️ Les navigateurs **mettent en pause** le rendu (`requestAnimationFrame`) d'un onglet en arrière-plan.
> Pour jouer à 2 sur la même machine, garde **chaque onglet dans sa propre fenêtre visible**
> (ou utilise 2 machines). C'est le comportement normal des jeux web, pas un bug.

Changer le port : `PORT=5173 npm start` (le défaut est **4000** ; 3000 est pris par ton projet MMAD).

## Tester (sans navigateur)

```bash
npm test                    # mode carte : 32 assertions (normal, infecté, rejouer)
node test/photo-smoke.js    # mode photo : 23 assertions (flux 3 joueurs + anti-fuite)
node scripts/imprint-harness.js  # effet empreinte : composite serveur + hitTest
```

---

## Boucle de jeu

| Phase | Cacheur | Chasseur |
|-------|---------|----------|
| **Préparation** (2 min) | se place (flèches), verrouille sa rotation (R), peint son camouflage 🎨, caméra libre (C) | écran d'attente — peut survoler la carte (ne voit **pas** les positions : anti-triche) |
| **Chasse** (3 min) | fuit, reste camouflé | vise à la souris, tire (clic / Espace), recharge 2 s, portée limitée |

- **Score** : plus un cacheur est proche du chasseur, plus il marque (maj toutes les 15 s).
- **Mode normal** : cacheur touché = éliminé (spectateur).
- **Mode infecté** : cacheur touché = devient chasseur.
- **Fin** : temps écoulé (les survivants gagnent) ou tous les cacheurs éliminés (le chasseur gagne).

### Peinture in-world 🎨
On peint **directement sur son bonhomme dans la vue de jeu** (pas de fenêtre popup) :
bouton **🎨 Peindre** (ou touche **P**) → les outils se dockent sur le bord gauche et la caméra
zoome sur le perso. Outils : **pipette** (échantillonne le **vrai sol** sous le curseur),
taille de pinceau, finition **mat/brillant**, remplir. **Molette = zoom** sur soi.
Disponible en préparation **et** pendant la chasse (re-camouflage). Un **léger contour sombre**
reste toujours visible : impossible d'être 100 % invisible (aide le chasseur).

### Contrôles
| Touche | Action |
|--------|--------|
| Flèches / WASD | se déplacer (ou panoramique en caméra libre) |
| P | entrer / sortir du mode peinture (cacheur) |
| Clic gauche | peindre sur son perso (mode peinture) · tirer (chasseur) |
| R | verrouiller / libérer la rotation |
| C | caméra libre (cacheur vivant) |
| Q / E | rotation manuelle (cacheur) |
| Souris | viser (chasseur) · déplacer le pinceau (peinture) |
| Espace | tirer (chasseur) |
| Molette | zoom (jusqu'à ×6, pour peindre fin) |
| Échap | quitter le mode peinture |

---

## Architecture

```
cameleo/
├─ server.js              # Serveur autoritaire : rooms, phases, tir, score, infection, fin
├─ shared/constants.js    # Constantes partagées serveur <-> client (UMD)
├─ public/
│  ├─ index.html          # Écrans : menu, lobby, HUD, atelier, fin
│  ├─ css/style.css
│  └─ js/
│     ├─ map.js           # Carte vectorielle procédurale déterministe + pipette (mapColorAt)
│     ├─ paint.js         # Atelier de peinture, export PNG transparent
│     ├─ game.js          # Contrôleur en jeu : rendu, caméra, inputs, état
│     └─ main.js          # Menu, lobby, bascule vers le jeu
└─ test/smoke.js          # Test de fumée réseau (npm test)
```

**Le serveur est l'unique source de vérité** (tir, score, infection, fin). Le déplacement du joueur
local est prédit côté client pour la réactivité, puis validé/clampé par le serveur. Pendant la
préparation, le serveur **n'envoie pas** les positions des autres (anti-triche réel, pas seulement visuel).

## Limites connues (prototype)
- Pas de persistance, pas de matchmaking en ligne (parties privées par code uniquement).
- Mouvement client-autoritaire (anti-triche léger : clamp au monde). À durcir pour la prod.
- Carte unique déterministe (graine fixe). Conçue pour être étendue.
