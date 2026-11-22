import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Where the Photoloft service looks for drives in the browser tests: a
// folder made here is a connected drive.
export const MEDIA_ROOT = join(tmpdir(), 'photoloft-e2e-media')
