import {expect,test} from 'vitest';
import {clampRatio,compatiblePosition,originalRow,prosePosition,proseTop,readPosition} from './position';

test('PDF pages survive persistence without being mistaken for HTML scroll ratios', () => {
  const pos = readPosition({kind:'pdf',page:42,ignored:true});
  expect(pos).toEqual({kind:'pdf',page:42});
  expect(compatiblePosition(pos,'frame',false,'pdf')).toEqual(pos);
  expect(compatiblePosition(pos,'frame',false,'html')).toBeUndefined();
  expect(compatiblePosition({kind:'frame',ratio:0.5},'frame',false,'pdf')).toBeUndefined();
  for (const page of [0,-1,0.5,Infinity,'2']) expect(readPosition({kind:'pdf',page})).toBeUndefined();
});

test('positions reject malformed coordinates and discard unknown fields', () => {
  for (const pos of [null,{}, {kind:'raw',line:-1}, {kind:'raw',line:1.2}, {kind:'grid',row:'4'},
    {kind:'grid',row:0,collection:4}, {kind:'frame',ratio:NaN}, {kind:'frame',ratio:2},
    {kind:'prose',ratio:0,heading:''}, {kind:'tree',path:3}, {kind:'tree',path:'x'.repeat(65537)}]) {
    expect(readPosition(pos)).toBeUndefined();
  }
  expect(readPosition({kind:'raw',line:300,extra:'ignored'})).toEqual({kind:'raw',line:300});
  expect(readPosition({kind:'grid',row:42,collection:'시트'})).toEqual({kind:'grid',row:42,collection:'시트'});
});

test('heading offsets follow their section when preceding layout changes', () => {
  const headings = [{id:'a',top:0},{id:'b',top:100},{id:'c',top:500}];
  const pos = prosePosition(headings,300,1000);
  expect(pos).toEqual({kind:'prose',heading:'b',ratio:0.5});
  expect(proseTop(pos,[{id:'a',top:0},{id:'b',top:200},{id:'c',top:800}],1200)).toBe(500);
  expect(proseTop(pos,[{id:'a',top:0}],1200)).toBe(0);
  expect(proseTop(prosePosition([],500,1000),[],2000)).toBe(1000);
  expect(prosePosition([],0,0)).toEqual({kind:'prose',ratio:0});
  expect(clampRatio(Infinity)).toBe(0); expect(clampRatio(-1)).toBe(0); expect(clampRatio(2)).toBe(1);
});

test('grid coordinates use source row numbers rather than sorted display ordinals', () => {
  const rows = [{index:500},{index:29},{index:0}];
  expect(originalRow(rows,100,101)).toBe(29);
  expect(originalRow(rows,100,99)).toBeUndefined();
  expect(compatiblePosition({kind:'grid',row:29},'collection',false)).toEqual({kind:'grid',row:29});
  expect(compatiblePosition({kind:'grid',row:29},'prose',false)).toBeUndefined();
  expect(compatiblePosition({kind:'raw',line:29},'frame',true)).toEqual({kind:'raw',line:29});
});
