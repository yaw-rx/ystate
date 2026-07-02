declare module '*?worker' {
    const workerConstructor: { new (): Worker }
    export default workerConstructor
}

declare module 'virtual:dts-bundle' {
    const bundle: Record<string, Record<string, string>>
    export default bundle
}

interface Window {
    MonacoEnvironment?: {
        getWorker(workerId: string, label: string): Worker
    }
}
