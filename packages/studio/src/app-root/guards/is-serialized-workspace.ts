import { isPlainObject } from './is-plain-object.js';
import { isSerializedWorkspaceFile } from './is-serialized-workspace-file.js';
import { SerializedWorkspace } from '../types/serialized-filesystem.types.js';

export function isSerializedWorkspace(value: unknown): value is SerializedWorkspace {
    if (!isPlainObject(value)) return false;

    console.log(value['files'].every(isSerializedWorkspaceFile),'is a file?');
    return (
        typeof value['name'] === 'string' &&
        isPlainObject(value['manifest']) &&
        Array.isArray(value['files']) &&
        value['files'].every(isSerializedWorkspaceFile)
    );
}