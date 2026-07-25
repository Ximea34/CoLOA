# CoLOA

Assistant temps réel pour contrôleurs IVAO Aurora (secteur Marseille ACC) :
suggestion de règle LOA (lettre d'accord) et de niveau/point de transfert,
séquenceur d'arrivées (AMAN), et simulateur de trafic pour les tests.

## Fonctionnalités

- **Assistant LoA** — mode mono-avion (suit la sélection dans Aurora) ou
  balayage global (surveille tous les avions assumés en continu, n'affiche
  que les écarts par rapport à la LOA).
- **AMAN** — séquenceur d'arrivées : ETA calculée géométriquement le long
  des transitions publiées (porte → IF → seuil), bascule automatique en
  guidage radar (projection du cap réel sur l'axe final) quand un avion est
  vectorisé par le contrôleur, frise chronologique (ladder) par porte et
  par piste fusionnée avec séparation par catégorie de sillage.
- **Simulateur de trafic** — place des avions fictifs sur une carte pour
  tester l'AMAN quand le trafic réel est trop rare : pilotage manuel,
  "suivre la procédure" (pilote automatique sur la transition), "capturer
  l'ILS" (établissement instantané sur l'axe final), vitesse du temps
  accélérée.
- **Consultation manuelle** — recherche de règle LOA hors ligne, sans
  connexion Aurora.

Tous les modules s'ouvrent depuis une fenêtre de base à onglets (dockables
ou détachables en fenêtre à part), avec connexion Aurora et journal de
debug centralisés.

## Prérequis

- IVAO Aurora, avec l'accès tierce partie activé :
  **F7 → Other → 3rd Party Software Access**.
- Node.js pour lancer ou développer depuis les sources.

## Lancer en développement

```bash
npm install
npm start
```

## Construire un exécutable Windows

```bash
npm run dist
```

Produit un `.exe` portable autonome dans `dist/` (aucune installation
requise, un seul fichier à distribuer).

## Configuration AMAN

Chaque aéroport a un fichier `AMAN/<ICAO>.json` décrivant les points de
transition (porte → IF → seuil) par configuration de piste. Voir
`AMAN/LFLL.json` pour un exemple complet.

## Structure

- `loa/` — règles LOA par FIR (source de données du moteur LOA).
- `STAR/` — procédures d'arrivée publiées (source des portes/transitions).
- `AMAN/` — configuration du séquenceur d'arrivées par aéroport.
- `assets/` — icône de l'application.

## Branches

- `main` — version stable.
- `DEV` — développement actif.
- `BETA_TEST` — version de test, celle packagée en exécutable.
