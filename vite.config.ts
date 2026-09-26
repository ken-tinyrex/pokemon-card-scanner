import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// The dev server listens on your local network as well as localhost, over HTTPS:
// phones (iOS especially) only allow live camera access on secure pages. The certificate
// is self-signed, so each device shows a one-time warning to accept.
// `npm run dev:http` serves plain HTTP instead (fine for desktop, where localhost counts as secure).
// A fixed port of its own, so it doesn't collide with other projects' Vite servers on 5173.
// strictPort makes a clash an error instead of silently moving to another port.
const PORT = 5190;

export default defineConfig(({ mode }) => ({
  plugins: mode === 'http' ? [] : [basicSsl()],
  server: { host: true, port: PORT, strictPort: true },
  preview: { host: true, port: PORT + 1, strictPort: true },
}));
