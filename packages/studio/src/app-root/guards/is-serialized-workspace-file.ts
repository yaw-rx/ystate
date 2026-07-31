import { isPlainObject } from './is-plain-object.js';
import { SerializedWorkspaceFile } from '../types/serialized-filesystem.types.js';

export function isSerializedWorkspaceFile(value: unknown): value is SerializedWorkspaceFile {
    console.log('isSerializedWorkspaceFile', value);
    if (!isPlainObject(value)) return false;
    return (
        typeof value['name'] === 'string' &&
        typeof value['content'] === 'string' &&
        typeof value['status'] === 'string' && // Fixed here
        (value['sections'] === undefined || isPlainObject(value['sections'])) &&
        (value['analysis'] === undefined || isPlainObject(value['analysis'])) &&
        (value['error'] === undefined || typeof value['error'] === 'string')
    );
}