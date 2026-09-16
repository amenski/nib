export {
  StatusLineManager,
  createDefaultProviders,
  defaultCommandRunner,
  defaultModuleImporter,
} from "./manager.js";
export type { SegmentProvider, CommandRunner, ModuleImporter, StatusLineSpawnOptions } from "./manager.js";
export type {
  StatusSegment,
  SessionInfo,
  StatusLineConfig,
  StatusLineProviderConfig,
  CommandProviderConfig,
  ModuleProviderConfig,
} from "./types.js";
export { sanitizeText, MAX_SEGMENT_LENGTH } from "./sanitize.js";
