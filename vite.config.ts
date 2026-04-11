import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientPort = Number(process.env.EASYAIFLOW_WEB_CLIENT_PORT ?? 4273);
const serverPort = Number(process.env.EASYAIFLOW_WEB_SERVER_PORT ?? 8887);

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: clientPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
      },
    },
  },
});
