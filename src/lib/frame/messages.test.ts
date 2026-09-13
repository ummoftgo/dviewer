import {expect, test} from 'vitest';
import {frameMessage, linkKind, parseFrameMessage} from './messages';

test('headings become the existing TOC shape, without untrusted extra fields', () => {
  expect(parseFrameMessage({type:'ready', title:'문서', headings:[{id:'part',level:2,text:'둘째',onclick:'bad'}]}))
    .toEqual({type:'ready',title:'문서',headings:[{id:'part',level:2,text:'둘째'}]});
});
test('malformed and duplicate headings cannot enter a keyed TOC', () => {
  for(const headings of [[{id:'',level:1,text:'a'}],[{id:'x',level:7,text:'a'}],[{id:'x',level:1,text:3}],
    [{id:'x',level:1,text:'a'},{id:'x',level:2,text:'b'}]]) expect(parseFrameMessage({type:'ready',title:'x',headings})).toBeNull();
});
test('an opaque origin is not identity: only the mounted frame may send messages', () => {
  const frame = {} as Window, other = {} as Window;
  const data = {type:'blocked',n:2};
  expect(frameMessage({source:frame,data},frame)).toEqual(data);
  expect(frameMessage({source:other,data},frame)).toBeNull();
  expect(frameMessage({source:null,data},null)).toBeNull();
});
test('unknown messages and unbounded numeric fields are ignored', () => {
  for(const value of [null,{type:'unknown'},{type:'scroll',ratio:Infinity},{type:'scroll',ratio:-1},
    {type:'blocked',n:1.5},{type:'found',n:1,index:2,request:1},{type:'found',n:1,index:1,request:-1}]) expect(parseFrameMessage(value)).toBeNull();
});
test('a document cannot mislabel executable URLs as relative links', () => {
  for(const href of ['javascript:alert(1)','data:text/html,x','//external.test/','file:///secret','#anchor']) {
    expect(linkKind(href)).toBeNull();expect(parseFrameMessage({type:'link',href,kind:'relative'})).toBeNull();
  }
  expect(parseFrameMessage({type:'link',href:'https://example.com/',kind:'relative'})).toBeNull();
});
test('relative links preserve the attribute value for the document resolver', () => {
  expect(parseFrameMessage({type:'link',href:'../설계/notes.md#part',kind:'relative'}))
    .toEqual({type:'link',href:'../설계/notes.md#part',kind:'relative'});
  for(const href of ['https://example.com/','http://example.com/','mailto:a@example.com','tel:123']) expect(linkKind(href)).toBe('external');
});
test('probe timeout remains a failure candidate and execution is a separate message', () => {
  for(const invoke of ['absent','timeout','rejected:Origin header is not a valid URL']) expect(parseFrameMessage({type:'probe',invoke})).toEqual({type:'probe',invoke});
  expect(parseFrameMessage({type:'probe',invoke:'executed'})).toBeNull();
  expect(parseFrameMessage({type:'isolationBroken'})).toEqual({type:'isolationBroken'});
});
test('only the documented search, source and focus shortcuts cross the frame boundary', () => {
  expect(parseFrameMessage({type:'shortcut',key:'find'})).toEqual({type:'shortcut',key:'find'});
  expect(parseFrameMessage({type:'shortcut',key:'raw'})).toEqual({type:'shortcut',key:'raw'});
  expect(parseFrameMessage({type:'shortcut',key:'escape'})).toEqual({type:'shortcut',key:'escape'});
  expect(parseFrameMessage({type:'shortcut',key:'focus'})).toEqual({type:'shortcut',key:'focus'});
  expect(parseFrameMessage({type:'shortcut',key:'Tab'})).toBeNull();
  expect(parseFrameMessage({type:'shortcut',key:'delete'})).toBeNull();
});
