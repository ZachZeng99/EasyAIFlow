var _a, _b;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var clientPort = Number((_a = process.env.EASYAIFLOW_WEB_CLIENT_PORT) !== null && _a !== void 0 ? _a : 4273);
var serverPort = Number((_b = process.env.EASYAIFLOW_WEB_SERVER_PORT) !== null && _b !== void 0 ? _b : 8887);
export default defineConfig({
    base: './',
    plugins: [react()],
    server: {
        host: '0.0.0.0',
        port: clientPort,
        strictPort: true,
        proxy: {
            '/api': {
                target: "http://127.0.0.1:".concat(serverPort),
            },
        },
    },
});
