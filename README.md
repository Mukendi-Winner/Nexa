# Nexa

Assistant Live Gemini avec camera et micro.

## Local

```bash
npm install
npm run dev
```

Crée `.env.local` avec :

```env
GEMINI_API_KEY=your_google_ai_studio_api_key
NEXA_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
```

## Render

Service web Node.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Variables Render :

```env
GEMINI_API_KEY=your_google_ai_studio_api_key
NEXA_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
CORS_ORIGIN=https://your-netlify-site.netlify.app
```

## Netlify

Build command:

```bash
npm run build
```

Publish directory:

```txt
dist
```

Variable Netlify :

```env
VITE_API_BASE_URL=https://your-render-service.onrender.com
```

Après avoir changé `VITE_API_BASE_URL`, relance un deploy Netlify. Les variables `VITE_*`
sont injectées au moment du build.
