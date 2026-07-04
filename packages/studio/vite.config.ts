import { defineConfig } from 'vite';
import { viteTransform, viteAssets } from '@yaw-rx/vite';
import { dtsBundlePlugin } from './plugins/vite-dts-bundle.js';

const yawAssets = () => {
    const plugin = viteAssets(['.css', '.html', '.wgsl']);
    const origResolveId = plugin.resolveId as Function;
    return {
        ...plugin,
        resolveId(source: string, importer: string | undefined) {
            if (importer?.includes('node_modules')) return;
            return origResolveId.call(this, source, importer);
        },
    };
};

export default defineConfig({
    root: '.',
    plugins: [
        yawAssets(),
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