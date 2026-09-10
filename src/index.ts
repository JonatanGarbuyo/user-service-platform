import { createApp } from './app.js';
import type { Env } from './env.js';

// Cloudflare Worker entrypoint: the composed application is the Worker.
const app = createApp();

export default app;
export type { Env };
