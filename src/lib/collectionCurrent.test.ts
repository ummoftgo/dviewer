import {expect,test} from 'vitest';
import type {DocTab} from './state/docs.svelte';
import {currentCollection} from './collectionCurrent';

test('a late collection continuation rejects a replacement even when both generations are zero', () => {
  const target = {id:30,status:'ready',meta:{generation:0}} as DocTab;
  const placeholder = {id:-31,status:'opening',meta:{}} as DocTab;
  expect(currentCollection(target,target,30,0,true)).toBe(true);
  expect(currentCollection(target,placeholder,30,0,true)).toBe(false);
  expect(currentCollection(target,{...target} as DocTab,30,0,true)).toBe(false);
  expect(currentCollection(target,target,29,0,true)).toBe(false);
  expect(currentCollection(target,target,30,1,true)).toBe(false);
  expect(currentCollection(target,target,30,0,false)).toBe(false);
  target.status = 'opening';
  expect(currentCollection(target,target,30,0,true)).toBe(false);
});
