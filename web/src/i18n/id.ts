import { workspace } from './id/workspace'
import { studio } from './id/studio'
import { documents } from './id/documents'
import { devices } from './id/devices'

/** Indonesian UI strings, keyed by the English source string. Each area keeps its own file. */
export const id: Record<string, string> = { ...workspace, ...studio, ...documents, ...devices }
