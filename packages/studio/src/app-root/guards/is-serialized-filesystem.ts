import { isPlainObject } from './is-plain-object.js';
import { isSerializedWorkspace } from './is-serialized-workspace.js';
import { SerializedFilesystem } from '../types/serialized-filesystem.types.js';

export function isSerializedFilesystem(value: unknown): value is SerializedFilesystem {
    if (!isPlainObject(value)) return false;

    return (
        Array.isArray(value['workspaces']) &&
        value['workspaces'].every(isSerializedWorkspace) &&
        isPlainObject(value['dependencyGraph'])
    );
}