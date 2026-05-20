import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./tests/__mocks__/obsidian.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['constants.ts', 'i18n.ts', 'types.ts', 'fonts/**', 'locales/**'],
            exclude: ['main.ts', 'input/**', 'ui/**'],
        },
    },
    resolve: {
        alias: {
            // 讓測試環境使用 mock 取代真實 obsidian 套件
            obsidian: fileURLToPath(new URL('./tests/__mocks__/obsidian.ts', import.meta.url)),
        },
    },
    define: {
        // esbuild 在 build 時注入，測試時給空字串即可
        __GOOGLE_CLIENT_ID__: JSON.stringify(''),
        __GOOGLE_CLIENT_SECRET__: JSON.stringify(''),
    },
});
