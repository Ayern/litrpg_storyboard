// The one command channel the app uses, pointed at the in-memory backend.

import { invoke as dispatch } from '../backend';

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return (await dispatch(command, (args ?? {}) as Record<string, any>)) as T;
}

export default { invoke };
