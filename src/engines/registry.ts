/** Optional search engines, in get_capabilities order. Add new engines here. */
import type { EngineModule } from './types.js';
import { bingEngine } from './bing/index.js';

export const ENGINES: readonly EngineModule[] = [bingEngine];
