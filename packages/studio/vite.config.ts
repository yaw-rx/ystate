import { defineConfig } from 'vite';
import { viteTransform, viteAssets } from '@yaw-rx/vite';
import { dtsBundlePlugin } from './plugins/vite-dts-bundle.js';

export default defineConfig({
    root: '.',
    plugins: [
        viteAssets(['.css', '.html', '.wgsl']),
        viteTransform(),
        dtsBundlePlugin({ packages: ['@yaw-rx/ystate', 'rxjs'] }),
    ],
    esbuild: { target: 'es2022' },
    resolve: {
        dedupe: ['rxjs'],
    },
    server: {
        port: 5176,
    },
    publicDir: false,
    build: {
        outDir: 'dist',
        target: 'es2022',
        minify: 'terser',
        terserOptions: {
            compress: {
                passes: 3,
                pure_getters: true,
                unsafe_math: true,
                unsafe_proto: true,
                unsafe_regexp: true,
                unsafe_undefined: true,
            },
            mangle: true,
        },
    },
});