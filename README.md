# MovieBox Media Resolver API

Standalone Node.js microservice for TV Pulsar that resolves MovieBox titles and episodes to direct, downloadable MP4 URLs with required CDN headers.

Designed to run smoothly on lightweight environments (e.g., Botkeep free tier with 512MB RAM).

---

## 🚀 Installation & Local Run

### Prerequisites
- Node.js >= 18
- npm

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Default port is `10000`.

### 3. Start Server
```bash
npm start
```
Or for live reload during development:
```bash
npm run dev
```

---

## 📡 API Endpoints

### 1. Health Check
```http
GET /health
```
**Response (200 OK):**
```json
{
  "status": "ok"
}
```

---

### 2. Resolve MovieBox Media to Direct MP4
```http
POST /api/moviebox/resolve
Content-Type: application/json
```

#### Request Body
| Field | Type | Required | Description |
|---|---|---|---|
| `detailPath` | string | Yes | The MovieBox detail identifier (e.g. `titanic-m7a9yt0abq6`) |
| `type` | string | Yes | `"movie"` or `"episode"` |
| `season` | number | No | Season number (required for episodes, default: `1`) |
| `episode` | number | No | Episode number (required for episodes, default: `1`) |
| `quality` | string | No | Desired quality (e.g. `"1080p"`, `"720p"`, `"480p"`, or `"best"`) |

#### Example: Movie Request (curl)
```bash
curl -X POST http://localhost:10000/api/moviebox/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "detailPath": "titanic-m7a9yt0abq6",
    "type": "movie",
    "quality": "1080p"
  }'
```

#### Example Response (200 OK)
```json
{
  "url": "https://bcdnxw.hakunaymatata.com/resource/51f86f8256537ccbbdbacdf1a679961e.mp4?sign=...&t=...",
  "headers": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://h5.aoneroom.com/",
    "Accept": "*/*"
  },
  "fileName": "Titanic.mp4"
}
```

#### Example: TV Episode Request (curl)
```bash
curl -X POST http://localhost:10000/api/moviebox/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "detailPath": "merlin-s1e1",
    "type": "episode",
    "season": 1,
    "episode": 1,
    "quality": "720p"
  }'
```

#### Error Response (400 / 404 / 502)
```json
{
  "error": "Missing required field: detailPath must be a non-empty string."
}
```

---

## 🛠️ Botkeep Deployment Notes
- **Runtime:** Node.js 18+
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Port:** `10000` (or leave default `$PORT` provided by Botkeep)
- **Environment Variables:**
  - `PORT=10000`
  - `NODE_ENV=production`
- **Memory Footprint:** Stateless, zero database, memory consumption typically under 60MB RAM (well within 512MB RAM tier).
