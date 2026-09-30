# Deckstudio : atelier de présentation avec un co-auteur IA

## Pourquoi

Aujourd'hui une présentation se construit en allers-retours entre un chat et un fichier HTML que l'IA réécrit en bloc. Le créateur ne voit pas ce qui a changé, perd le fil des suggestions, et ne peut pas comparer deux versions d'un arc avant de choisir. Deckstudio met le deck au centre : les propositions de l'IA apparaissent comme des lignes parallèles sous le deck, ancrées à la portion qu'elles touchent, avec un accepter/refuser par changement. Le chat reste, mais il parle d'un endroit précis du deck.

Un seul utilisateur, en local, sur ses propres decks. Pas de collaboration multi-personnes : les fils de discussion sont entre le créateur et l'IA.

## Les objets

Deck. Une ligne `main`, suite ordonnée de slides, plus un brief (titre, audience, message en une phrase, pattern narratif : solution d'abord puis décomposition, ou problème par problème). Le brief est la référence des vérifications, pas le goût de l'IA.

Slide. Un titre-affirmation, un corps visuel (schéma, code, image, concepts reliés ; jamais une liste à puces), la story (le message à faire passer, trois ou quatre phrases), les notes. Le corps est un fragment HTML libre placé dans une scène fixe de 1280x720 ; le titre est rendu par le thème, pas par le fragment, pour que les titres restent uniformes et que leur diff soit structurel.

Lane. Une proposition ancrée sur une plage de main (de la slide i à la slide j, ou l'arc entier), affichée sous main sur cette plage seulement. Elle contient des changements typés : insérer, modifier, supprimer, déplacer. Chaque changement porte une raison d'une phrase. Une lane vient du créateur (via le chat) ou d'une vérification (non sollicitée, marquée comme telle).

Changement. L'unité de décision. Accepté, main l'absorbe et une nouvelle version est créée ; refusé, il disparaît de la lane. Une lane sans changement en attente se ferme. Si une acceptation partielle rend l'arc incohérent, une remarque le dit ; rien ne bloque.

Remarque. Un post-it ancré (slide, transition, plage, arc). Texte seul, avec un bouton « propose » qui demande une lane. Produites par les vérifications ou écrites par le créateur.

Fil. Le fil global, à droite, avec une puce de contexte qui reflète la sélection courante (slide, plage, lane). Un fil local s'ouvre quand on discute une remarque ou une lane et reste attaché à elle. Un message posté sur une lane a deux issues possibles : l'IA révise la lane en place, ou ouvre une nouvelle lane à côté pour comparer.

Vérification (check). Une analyse qui tourne dans un contexte frais, après chaque acceptation ou sur demande : arc narratif (hook, montée, retour), ordre des concepts (rien d'utilisé avant d'être posé), gaps par rapport au brief, rendu (débordement, lisibilité, une idée par slide, pas de liste). Elle produit des remarques, et quand elle sait quoi faire, une lane prête.

Version. Chaque acceptation crée une version de main. On peut afficher le deck à n'importe quelle version, comparer deux versions en pellicules, restaurer un changement, ou rouvrir une ancienne version comme lane.

## Les écrans

Quatre écrans, validés sur maquettes le 30 septembre 2026 (`.tool-ideas/1-main-screen.png` à `4-history.png` dans le projet du talk SF).

1. Écran principal : main en pellicule, les lanes en dessous sur leur plage seulement, un accepter/refuser sous chaque slide changée, les remarques en post-its reliés à leur ancrage, le fil global à droite, la ligne des versions en bas.
2. Focus sur un changement : la slide de main et celle de la lane en grand côte à côte, la raison, accepter ou refuser ce changement, précédent/suivant, le fil local de la lane à droite, les deux pellicules en bas avec la plage soulignée.
3. Brief et vérifications : le brief éditable, la liste des checks avec leurs trouvailles ancrées, « show » et « propose » par trouvaille, une lane prête quand il y en a une, la pellicule qui montre où ça pointe.
4. Historique : les versions sur une ligne, deux sélectionnées comparées en pellicules avec ajouts, suppressions, modifications, déplacements ; la liste « what changed » avec « restore » par entrée ; « open vN as a lane ».

Un cinquième écran existe déjà : le mode présentation, qui rend main avec le lecteur HTML actuel (flèches, panneau story, notes).

## Comment l'IA modifie un deck

Décision : l'IA ne touche jamais les fichiers du deck. Elle passe par des outils typés, et l'application possède le modèle. C'est ce qui rend les diffs exacts et l'acceptation par changement triviale. Le corps d'une slide reste un fragment HTML que l'IA compose librement (schéma, code, image générée, positions), donc la rigidité ne porte que sur la structure, pas sur le visuel.

L'alternative écartée : laisser l'IA éditer une copie du deck par lane comme un repo et differ les dossiers. Plus souple, mais les diffs deviennent bruités et une acceptation partielle demande de reconstituer des intentions à partir de lignes de HTML.

Outils exposés à l'IA (serveur MCP en process du Claude Agent SDK) :

- `get_deck`, `get_slide` : lecture du modèle, avec les vignettes rendues.
- `render_slide` : rend un corps HTML candidat en image avant de le proposer, pour que l'IA voie ce qu'elle propose.
- `propose_lane`, `revise_lane` : créer ou réviser une lane avec sa liste de changements et leurs raisons.
- `add_remark` : poser une remarque ancrée.
- `generate_image` : image de schéma via le script d'images existant, style « keynote flat diagram », fond aplati à la couleur de la scène.
- `run_check` : lancer une vérification nommée.

Les outils intégrés du SDK restent disponibles en lecture (Read, Glob, Grep) et pour Bash, avec un hook de permission qui refuse toute écriture dans le dossier du deck hors `assets/`. L'IA peut ainsi exécuter et tester un extrait de code avant de le mettre sur une slide.

Sessions. Une session SDK persistante par deck, reprise par son identifiant stocké avec le deck, `cwd` sur le dossier du deck, `settingSources: ["user", "project"]` pour charger les skills et la base de connaissances du créateur. Tous les fils passent par cette session : chaque message porte en en-tête son ancrage (fil global, lane X, remarque Y) et un résumé de l'état courant de la plage concernée. La réponse est rangée dans le fil d'où venait le message.

Vérifications. Chaque check est un `query()` séparé, sans session, sans skills, avec une sortie JSON structurée : une liste de remarques (ancrage, gravité, texte) et, optionnellement, une lane. Entrées : le brief, la liste des slides (titre, story, notes), et pour le rendu les vignettes. Un check remplace ses propres résultats précédents, jamais ceux d'un autre. Déclencheurs : après une acceptation (avec un délai pour absorber une série), après la création d'une lane (rendu seul, sur les slides de la lane), et sur demande.

Modèle par défaut : `claude-opus-5` pour la session et les checks, configurable par deck. Question ouverte : passer la session de co-auteur en Fable 5.1, plus cher mais mieux sur les arcs longs.

## Rendu

Le thème est extrait du deck du talk SF : scène 1280x720, Archivo et IBM Plex Mono, papier, encre, un accent, motif strata, titre à 82px en haut, grille de 96 à 1184. Le fragment HTML d'une slide est injecté sous le titre. Le lecteur de présentation et les vignettes utilisent le même rendu.

Les vignettes sont des captures Playwright (Chromium), produites en tâche de fond par une file à un seul worker, mises en cache par hash du contenu de la slide. Une lane ne rend que ses slides changées.

Le check de rendu applique les règles de composition : pas de liste, au moins un élément visuel, rien sous 24px, rien hors de la grille, une idée par slide (mesurée par la densité de texte).

## Stockage

Un dossier par deck, lisible à la main, sans base de données :

```
brief.json
deck.json            ordre des slides de main, version courante, id de session
slides/<id>.json     titre, story, notes, body (HTML), assets, kind
assets/              images générées, captures
objects/<hash>.json  instantanés de slides, adressés par contenu
versions/v<n>.json   ordre des slides + hash de chaque slide
lanes/<id>.json      ancrage, origine, changements et leur statut, fil local
remarks.json
threads/global.jsonl
cache/thumbs/<hash>.png
```

Les versions ne dupliquent pas les slides : elles pointent vers des objets par hash. Pas de git sous le capot ; les lanes ne sont pas des branches, ce sont des listes de changements, et l'acceptation partielle est plus simple à raisonner sur ce modèle.

Rebase d'une lane après une acceptation : les changements référencent des slides par identifiant, et les insertions se positionnent par rapport à un identifiant, donc une lane reste valide tant que ses slides de référence existent ; sinon le changement passe en « orphelin » et la lane le signale.

## Application

TypeScript. Serveur Node (Fastify) avec une API REST pour lire et muter le modèle et un WebSocket pour le flux de l'agent et l'état des tâches de rendu et de checks. Interface React (Vite), thème clair, design system partagé avec le rendu des slides. Lancée par `deckstudio <dossier-du-deck>`, qui démarre le serveur et ouvre le navigateur. Un script d'import convertit le `deck.html` actuel du talk SF (sections, titres, `.story`, `.notes`) en premier deck.

Tests : le modèle (application d'un changement, rebase, versions) en tests unitaires ; le rendu et les checks en tests d'intégration contre Chromium et l'API réelle, avec attente par condition et jamais par délai fixe.

## Hors périmètre v1

Multi-utilisateur, hébergement, export PowerPoint, édition visuelle à la souris des slides (le créateur édite le texte des champs ou demande à l'IA), thèmes multiples.

## Ordre de construction

1. Modèle, import du deck SF, rendu et vignettes, écran principal avec main seule.
2. Session agent, fil global, `propose_lane`, lanes sous main, accepter/refuser par changement, versions.
3. Écran focus et fils locaux.
4. Vérifications, remarques, brief.
5. Historique et comparaison.
6. Finition visuelle de l'outil lui-même avec la boucle deck-loop appliquée à ses écrans.

## Questions ouvertes

- Nom du projet (deckstudio est un nom de travail).
- Faut-il brancher le juge deck-loop complet comme cinquième check ? Coûteux en tokens, à réserver à une commande explicite.
- Modèle de la session de co-auteur : Opus 5 par défaut ou Fable 5.1.
