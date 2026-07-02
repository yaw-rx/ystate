import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, relative, dirname } from 'path'
import { createRequire } from 'module'
import type { Plugin } from 'vite'

const VIRTUAL_ID = 'virtual:dts-bundle'
const RESOLVED_ID = '\0' + VIRTUAL_ID

interface DtsBundleOptions {
    packages: string[]
}

function collectDtsFiles(dir: string): Map<string, string> {
    const result = new Map<string, string>()

    function walk(current: string): void {
        for (const entry of readdirSync(current)) {
            const full = join(current, entry)
            const stat = statSync(full)
            if (stat.isDirectory()) {
                walk(full)
            } else if (entry.endsWith('.d.ts')) {
                const rel = relative(dir, full)
                result.set(rel, readFileSync(full, 'utf-8'))
            }
        }
    }

    walk(dir)
    return result
}

function findPackageJson(startDir: string): string | null {
    let dir = startDir
    while (true) {
        const candidate = join(dir, 'package.json')
        try {
            statSync(candidate)
            return candidate
        } catch { /* */ }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

function resolveTypesDir(packageName: string, root: string): { dir: string; prefix: string; pkgJson: string; pkgJsonContent: string } | null {
    const req = createRequire(resolve(root, 'package.json'))
    try {
        const entryPath = req.resolve(packageName)
        const pkgJsonPath = findPackageJson(dirname(entryPath))
        if (!pkgJsonPath) return null

        const pkgDir = dirname(pkgJsonPath)
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

        let typesEntry: string | undefined
        if (pkg.exports?.['.']?.types) {
            typesEntry = pkg.exports['.'].types
        } else if (pkg.types) {
            typesEntry = pkg.types
        } else if (pkg.typings) {
            typesEntry = pkg.typings
        }

        if (!typesEntry) return null

        const typesFile = resolve(pkgDir, typesEntry)
        const typesDir = dirname(typesFile)
        const prefix = relative(pkgDir, typesDir)
        const pkgJsonContent = readFileSync(pkgJsonPath, 'utf-8')

        return { dir: typesDir, prefix, pkgJson: pkgJsonPath, pkgJsonContent }
    } catch {
        return null
    }
}

export function dtsBundlePlugin(options: DtsBundleOptions): Plugin {
    let projectRoot: string

    return {
        name: 'vite-dts-bundle',
        configResolved(config) {
            projectRoot = config.root
        },
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID
        },
        load(id) {
            if (id !== RESOLVED_ID) return

            const bundle: Record<string, Record<string, string>> = {}

            for (const packageName of options.packages) {
                const resolved = resolveTypesDir(packageName, projectRoot)
                if (!resolved) continue

                const files = collectDtsFiles(resolved.dir)
                const mapped: Record<string, string> = {}

                mapped[`node_modules/${packageName}/package.json`] = resolved.pkgJsonContent

                for (const [rel, content] of files) {
                    const virtualPath = resolved.prefix
                        ? `node_modules/${packageName}/${resolved.prefix}/${rel}`
                        : `node_modules/${packageName}/${rel}`
                    mapped[virtualPath] = content
                }

                bundle[packageName] = mapped
            }

            return `export default ${JSON.stringify(bundle)}`
        },
    }
}
