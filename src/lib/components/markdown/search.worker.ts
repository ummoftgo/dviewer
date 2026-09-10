import { findMatches, MatchError, type SearchOptions } from './search';

self.onmessage = (event: MessageEvent<{ seq: number; text: string; query: string; options: SearchOptions }>) => {
  const { seq, text, query, options } = event.data;
  try { self.postMessage({ seq, result: findMatches(text, query, options) }); }
  catch (error) {
    self.postMessage({ seq, error: error instanceof MatchError ? error.code : 'worker',
      detail: error instanceof Error ? error.message : '' });
  }
};
