import { createApp } from './app.js';

// Cloudflare Worker entrypoint: the composed application is the Worker.
const app = createApp();

export default app;
