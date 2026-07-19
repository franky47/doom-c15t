# DOOM c15t

A static DOOM demo that renders a live HTML consent form into the game world with the experimental html-in-canvas API.

## Run locally

Node.js 20 or newer is required.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:3000` in desktop Chrome. Enable `chrome://flags/#canvas-draw-element` and relaunch Chrome if the page asks for it.

## Build

```sh
npm run build
npm run preview
```

The build creates a minimal static site in `dist/`. It includes only the page and runtime assets. Source audio projects, tools, screenshots, and backup files are excluded.

## Deploy to Vercel

`vercel.json` configures Vercel to run `npm run build` and publish `dist/`. Push to the GitHub branch connected to the Vercel project to deploy it.

If the Vercel project already has build settings that override the repository, use:

- Framework preset: Other
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

The deployment is fully static and does not require serverless functions.
