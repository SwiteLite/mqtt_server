## MQTT Afficheur ESP32S3 + BeagleBone

Ce projet affiche des messages défilants sur une matrice HUB75 pilotée par un ESP32-S3. 
Une BeagleBone (Debian) héberge le broker MQTT et une petite API HTTP pour publier facilement des commandes.

### Architecture
- **ESP32-S3**: client MQTT, afficheur HUB75. Projet Arduino: `Arduino/ESP32S3-DMA_jeu_de_la_vie/sketch_dec5b`.
- **BeagleBone**: broker MQTT (Aedes) + API HTTP (`Express`) dans `Projets/beaglebone_server`.
- **Topics MQTT** utilisés:
  - `panel/mode`: `messages` ou `conway`
  - `panel/message`: texte à afficher
  - `panel/speed`: entier millisecondes par pas de défilement (ex: 25)

## 1) BeagleBone: Broker MQTT + API HTTP

### Prérequis
- Node.js (>= 14 recommandé)

### Installation
Dans `Projets/beaglebone_server`:
```bash
npm install
npm start
```

- Par défaut:
  - Broker MQTT TCP sur port `1883` (env `MQTT_PORT` possible)
  - API HTTP sur port `3000` (env `HTTP_PORT` possible)

### Endpoints HTTP
- `POST /publish`
  - Body JSON: `{ "topic": "panel/message", "message": "Bonjour" }`
- `POST /message`
  - Body JSON: `{ "text": "Bonjour Paul !" }` → publie sur `panel/message`
- `POST /mode`
  - Body JSON: `{ "mode": "messages" }` (ou `conway`) → publie sur `panel/mode`
- `POST /speed`
  - Body JSON: `{ "ms": 40 }` → publie sur `panel/speed`

Exemples rapides (sur la BeagleBone):
```bash
curl -X POST http://localhost:3000/message \
     -H "Content-Type: application/json" \
     -d '{"text":"Bonjour depuis la BeagleBone!"}'

curl -X POST http://localhost:3000/mode \
     -H "Content-Type: application/json" \
     -d '{"mode":"messages"}'

curl -X POST http://localhost:3000/speed \
     -H "Content-Type: application/json" \
     -d '{"ms":25}'
```

Publication MQTT directe (si `mosquitto-clients` est installé):
```bash
mosquitto_pub -h localhost -t panel/message -m "Hello MQTT"
mosquitto_pub -h localhost -t panel/mode -m "conway"
mosquitto_pub -h localhost -t panel/speed -m "30"
```

## Test en local (PC)

Le front se build sur le PC (pas sur la BeagleBone). Pour vérifier le site et l’API avant déploiement :

### Prérequis
```bash
npm install
npm install --prefix web
```

### Mode dev (hot reload Svelte)

Lancer **3 terminaux** à la racine du projet :

```bash
# Terminal 1 — broker MQTT
node broker.js

# Terminal 2 — API + cache températures + historique (lit logs/ local)
node webapp.js

# Terminal 3 — front Svelte (Vite)
npm run dev:web
```

Ouvrir **http://localhost:5173** — Vite proxyfie `/temperatures` et `/api` vers le port 3000.

### Mode prod local (comme sur la BeagleBone)

```bash
# Terminal 1
node broker.js

# Terminal 2 — sert web/dist sur le port 3000
node webapp.js
```

Ouvrir **http://localhost:3000**. Rebuild le front si le code Svelte a changé :

```bash
npm run build:web
```

### Vérifications rapides

```bash
curl http://localhost:3000/temperatures
curl "http://localhost:3000/temperatures/history?range=1d"
```

Sous PowerShell :

```powershell
(Invoke-WebRequest http://localhost:3000/temperatures -UseBasicParsing).Content
(Invoke-WebRequest "http://localhost:3000/temperatures/history?range=1d" -UseBasicParsing).Content
```

- **Historique / graphiques** : fonctionnent si le dossier `logs/history/` est présent sur le PC.
- **Températures live** : nécessitent des capteurs MQTT connectés au broker local (`127.0.0.1:1883`).

## 2) ESP32-S3: Afficheur + Client MQTT

### Code
- Sketch: `Arduino/ESP32S3-DMA_jeu_de_la_vie/sketch_dec5b/sketch_dec5b.ino`
- Modules d’affichage: `messages_mode.*` et `conway_game.*`

### Dépendances Arduino
- `PubSubClient` (Nick O’Leary) pour MQTT.
  - Arduino IDE → Outils → Gérer les bibliothèques → chercher « PubSubClient ».

### Paramétrage MQTT
Dans `sketch_dec5b.ino`, configure l’IP du broker (BeagleBone):
```cpp
const char* mqtt_server = "XX.XX.XX.XX"; // adresse IP de la BeagleBone
const uint16_t mqtt_port = 1883;
```

Topics écoutés par l’ESP32-S3:
- `panel/mode`: payload `messages` ou `conway`
- `panel/message`: payload texte (affiché en défilement)
- `panel/speed`: payload entier (ms/pas, p.ex. 25)

Au changement de message via `panel/message`, le scroll repart du début.

## 3) Dépannage rapide
- **Connexion réseau**:
  - Ping la BeagleBone depuis le poste: `ping XX.XX.XX.XX`
  - Vérifie le port broker: `ss -ltnp | grep 1883` (sur la BeagleBone)
  - Pare-feu: autoriser 1883/TCP et 3000/TCP si accès distant requis.
- **Logs broker**: observe la console `npm start` pour connexions/publications.
- **ESP32-S3**:
  - Moniteur série (115200) pour voir l’IP WiFi et l’état MQTT.
  - Vérifie SSID/mot de passe et la portée WiFi.
- **Taille de message**: `PubSubClient` a une taille de paquet par défaut (~256 o). Allonger si nécessaire via `MQTT_MAX_PACKET_SIZE`.
- **Accents/UTF‑8**: `Adafruit_GFX` ne gère pas l’UTF‑8 complet par défaut; privilégier ASCII simple ou intégrer une police adaptée si besoin.

## 4) Sécurité (optionnel)
- Actuellement, broker ouvert sur le LAN (sans authentification/TLS).
- Pour un usage élargi, envisager: authentification (`aedes` auth), ACL, TLS, VLAN isolé.

## 5) Roadmap possible
- Playlist de messages avec priorités/expiration.
- Persistance (retenue) côté broker.
- Commandes supplémentaires (couleur, taille du texte, pause/reprise).


