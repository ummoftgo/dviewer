import { expect, test } from 'vitest';
import { bookmarkDocument, currentAnchor, proseAnchor, readBookmarks, resolveAnchor, selectBookmarks, type Bookmark } from './bookmarks';

const item = {id:'saved',label:'why',source:{type:'file',path:'/doc.md'},anchor:{id:'part',text:'Section'},created:123};
const headings = [{id:'first',text:'First',level:1},{id:'part',text:'Section',level:2}];

test('reading keeps valid neighbors, strips unknown fields and rejects malformed or duplicate identities', () => {
  const invalid = [null, {}, {...item,id:''}, {...item,id:3}, {...item,label:2}, {...item,label:' '},
    {...item,created:NaN}, {...item,created:-1}, {...item,created:1.5}, {...item,anchor:{id:2,text:'x'}},
    {...item,anchor:{id:'x',text:2}}, {...item,source:{type:'file',path:2}}, {...item,source:{type:'text'}},
    {...item,source:{type:'url',url:''}}];
  for (const bad of invalid) expect(readBookmarks([bad,item])).toEqual([item]);
  expect(readBookmarks([{...item,extra:true,source:{...item.source,extra:true},anchor:{...item.anchor,extra:true}},item])).toEqual([item]);
  expect(readBookmarks(null)).toEqual([]);
  expect(readBookmarks([{...item,source:{type:'url',url:'https://example.com/doc'},anchor:{id:'',text:''}}])).toHaveLength(1);
});

test('the default label uses the current heading, the first heading before it, or a top marker', () => {
  expect(currentAnchor(headings,'part')).toEqual(item.anchor);
  expect(currentAnchor(headings,'')).toEqual({id:'first',text:'First'});
  expect(currentAnchor([],'')).toEqual({id:'',text:''});
});

test('navigation resolves by id then exact text and distinguishes missing from document top', () => {
  expect(resolveAnchor({...item.anchor,text:'old'},headings)).toEqual(item.anchor);
  expect(resolveAnchor({id:'renamed-id',text:'Section'},headings)).toEqual(item.anchor);
  expect(resolveAnchor({id:'removed',text:'Gone'},headings)).toBeNull();
  expect(resolveAnchor({id:'',text:''},[])).toEqual({id:'',text:''});
});

test('prose bookmarks use the section under the current scroll position, with top reserved for headingless documents', () => {
  const positions = [{id:'first',top:32},{id:'part',top:900}];
  expect(proseAnchor(headings,positions,1200,2000)).toEqual(item.anchor);
  expect(proseAnchor(headings,positions,0,2000)).toEqual({id:'first',text:'First'});
  expect(proseAnchor(headings,[positions[1]],0,2000)).toEqual(item.anchor);
  expect(proseAnchor(headings,[],1200,2000)).toBeNull();
  expect(proseAnchor(headings,[{id:'stale',top:32}],1200,2000)).toBeNull();
  expect(proseAnchor([],[],1200,2000)).toEqual({id:'',text:''});
});

test('current documents sort by heading order including text fallback and top; all sorts by recency without changing storage', () => {
  const entries: Bookmark[] = [
    {...item,id:'second',created:20},
    {...item,id:'first',anchor:{id:'changed',text:'First'},created:30},
    {...item,id:'top',anchor:{id:'',text:''},created:40},
    {...item,id:'gone',anchor:{id:'gone',text:'Gone'},created:50},
    {...item,id:'closed',source:{type:'url',url:'https://example.com/Closed%20file.md'},created:60},
  ] as Bookmark[];
  const original = JSON.stringify(entries);
  expect(selectBookmarks(entries,{type:'file',path:'\\doc.md'},headings,false,'').map(item => item.id)).toEqual(['top','first','second','gone']);
  expect(selectBookmarks(entries,null,[],true,'').map(item => item.id)).toEqual(['closed','gone','top','first','second']);
  expect(selectBookmarks(entries,null,[],true,'CLOSED FILE').map(item => item.id)).toEqual(['closed']);
  expect(selectBookmarks(entries,null,[],true,'why')).toHaveLength(5);
  expect(selectBookmarks(entries,null,[],false,'')).toEqual([]);
  expect(JSON.stringify(entries)).toBe(original);
  expect(bookmarkDocument({type:'file',path:'C:\\Docs\\Report.md'})).toBe('Report.md');
});
