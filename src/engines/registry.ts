/** Optional engines, in get_capabilities order. Add new engines here. */
import type { EngineModule } from './types.js';
import { bingEngine } from './bing/index.js';
import { ga4Engine } from './ga4/index.js';
import { indexNowEngine } from './indexnow/index.js';
import { yandexEngine } from './yandex/index.js';
import { seznamEngine } from './seznam/index.js';

export const ENGINES: readonly EngineModule[] = [ga4Engine, bingEngine, indexNowEngine, yandexEngine, seznamEngine];
