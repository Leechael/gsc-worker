/** Optional search engines, in get_capabilities order. Add new engines here. */
import type { EngineModule } from './types.js';
import { bingEngine } from './bing/index.js';
import { indexNowEngine } from './indexnow/index.js';
import { yandexEngine } from './yandex/index.js';

export const ENGINES: readonly EngineModule[] = [bingEngine, indexNowEngine, yandexEngine];
