import {expect, test} from 'vitest';
import {PDF_STAGES, frameLocation, frameMessage, linkKind, parseFrameMessage} from './messages';

test('PDF diagnostics admit only known stages and bounded error strings from the current frame', () => {
  const frame = {} as Window, load = '?g=2';
  for (const name of PDF_STAGES) {
    const data = {type:'stage',name,load};
    expect(frameMessage({source:frame,data},frame,load)).toEqual({type:'stage',name});
    expect(frameMessage({source:{} as Window,data},frame,load)).toBeNull();
    expect(frameMessage({source:frame,data},frame,'?g=3')).toBeNull();
  }
  for (const name of ['', 'arbitrary', {}, 'x'.repeat(4096)]) expect(parseFrameMessage({type:'stage',name})).toBeNull();
  for (const detail of ['', 'x'.repeat(4096)]) {
    expect(parseFrameMessage({type:'error',code:'pdfFailed',detail})).toEqual({type:'error',code:'pdfFailed',detail});
  }
  for (const detail of [null, {}, 42, 'x'.repeat(4097)]) expect(parseFrameMessage({type:'error',code:'pdfFailed',detail})).toBeNull();
});

test('PDF readiness, page and error messages preserve bounded typed fields', () => {
  for (const deg of [0,90,180,270]) for (const auto of [true,false]) {
    const frame={} as Window, data={type:'rotated',deg,auto,load:'?g=1'};
    expect(frameMessage({source:frame,data},frame,'?g=1')).toEqual({type:'rotated',deg,auto});
    expect(frameMessage({source:frame,data},frame,'?g=2')).toBeNull();
    expect(frameMessage({source:{} as Window,data},frame,'?g=1')).toBeNull();
  }
  for (const deg of [-90,360,45,'90',NaN]) expect(parseFrameMessage({type:'rotated',deg,auto:true})).toBeNull();
  for (const auto of [undefined,null,0,'true']) expect(parseFrameMessage({type:'rotated',deg:90,auto})).toBeNull();
  for (const image of [true,false]) expect(parseFrameMessage({type:'rotated',deg:90,auto:false,image})).toEqual({type:'rotated',deg:90,auto:false,image});
  for (const image of [null,1,'true',{}]) expect(parseFrameMessage({type:'rotated',deg:270,auto:true,image})).toBeNull();
  expect(parseFrameMessage({type:'ready',title:'PDF',pages:2,headings:[]})).toEqual({type:'ready',title:'PDF',pages:2,headings:[]});
  for (const pages of [0,-1,1.5,NaN,'2']) expect(parseFrameMessage({type:'ready',title:'PDF',pages,headings:[]})).toBeNull();
  expect(parseFrameMessage({type:'page',n:2})).toEqual({type:'page',n:2});
  expect(parseFrameMessage({type:'page',n:0})).toBeNull();
  expect(parseFrameMessage({type:'pageText',page:2,hasText:false})).toEqual({type:'pageText',page:2,hasText:false});
  expect(parseFrameMessage({type:'error',code:'pdfEncrypted'})).toEqual({type:'error',code:'pdfEncrypted'});
  expect(parseFrameMessage({type:'error',code:'arbitrary'})).toBeNull();
});

test('viewer file query coexists with generation and source identity', () => {
  const base = 'http://127.0.0.1:123/a/_/pdfjs/web/viewer.html?file=%2Fa%2F';
  const url = new URL(frameLocation(base,'?g=2&x=3',true));
  expect(url.searchParams.get('file')).toBe('/a/');
  expect(url.searchParams.get('g')).toBe('2');
  expect(url.searchParams.get('probe')).toBe('1');
  const frame = {} as Window;
  const data = {type:'page',n:2,load:url.search};
  expect(frameMessage({source:frame,data},frame,url.search)).toEqual({type:'page',n:2});
  expect(frameMessage({source:frame,data},frame,new URL(frameLocation(base,'?g=3&x=3',true)).search)).toBeNull();
  expect(frameLocation('http://127.0.0.1:123/a/','?g=0&x=1',true)).toBe('http://127.0.0.1:123/a/?g=0&x=1&probe=1');
});

test('headings become the existing TOC shape, without untrusted extra fields', () => {
  expect(parseFrameMessage({type:'heading',id:''})).toEqual({type:'heading',id:''});
  expect(parseFrameMessage({type:'heading',id:3})).toBeNull();
  expect(parseFrameMessage({type:'gone',request:2,found:false,extra:true})).toEqual({type:'gone',request:2,found:false});
  expect(parseFrameMessage({type:'gone',request:-1,found:true})).toBeNull();
  expect(parseFrameMessage({type:'gone',request:2,found:'yes'})).toBeNull();
  expect(parseFrameMessage({type:'loaded',scrollable:true,extra:1})).toEqual({type:'loaded',scrollable:true});
  expect(parseFrameMessage({type:'loaded'})).toBeNull();
  const frame = {} as Window;
  const loaded = {type:'loaded',scrollable:true,load:'?g=0&x=1'};
  expect(frameMessage({source:frame,data:loaded},frame,'?g=0&x=1')).toEqual({type:'loaded',scrollable:true});
  expect(frameMessage({source:frame,data:loaded},frame,'?g=0&x=2')).toBeNull();
  expect(parseFrameMessage({type:'ready', title:'문서', headings:[{id:'part',level:2,text:'둘째',onclick:'bad'}]}))
    .toEqual({type:'ready',title:'문서',headings:[{id:'part',level:2,text:'둘째'}]});
});
test('malformed and duplicate headings cannot enter a keyed TOC', () => {
  for(const headings of [[{id:'',level:1,text:'a'}],[{id:'x',level:7,text:'a'}],[{id:'x',level:1,text:3}],
    [{id:'x',level:1,text:'a'},{id:'x',level:2,text:'b'}]]) expect(parseFrameMessage({type:'ready',title:'x',headings})).toBeNull();
});
test('an opaque origin is not identity: only the mounted frame may send messages', () => {
  const frame = {} as Window, other = {} as Window;
  const load = '?g=1&x=2';
  const data = {type:'blocked',n:2,load};
  expect(frameMessage({source:frame,data},frame,load)).toEqual({type:'blocked',n:2});
  expect(frameMessage({source:other,data},frame,load)).toBeNull();
  expect(frameMessage({source:null,data},null,load)).toBeNull();
  expect(frameMessage({source:frame,data:{...data,load:'?g=1&x=1'}},frame,load)).toBeNull();
  expect(frameMessage({source:frame,data},frame,'')).toBeNull();
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
  expect(parseFrameMessage({type:'shortcut',key:'bookmark'})).toEqual({type:'shortcut',key:'bookmark'});
  expect(parseFrameMessage({type:'shortcut',key:'bookmarks'})).toEqual({type:'shortcut',key:'bookmarks'});
  expect(parseFrameMessage({type:'shortcut',key:'find'})).toEqual({type:'shortcut',key:'find'});
  expect(parseFrameMessage({type:'shortcut',key:'raw'})).toEqual({type:'shortcut',key:'raw'});
  expect(parseFrameMessage({type:'shortcut',key:'escape'})).toEqual({type:'shortcut',key:'escape'});
  expect(parseFrameMessage({type:'shortcut',key:'focus'})).toEqual({type:'shortcut',key:'focus'});
  expect(parseFrameMessage({type:'shortcut',key:'Tab'})).toBeNull();
  expect(parseFrameMessage({type:'shortcut',key:'delete'})).toBeNull();
});

test('image orientation verdicts keep only known reasons, quarter decisions and non-negative measures', () => {
  const verdict = {type:'orientation',page:1,ms:41.2345,ink:0.0204,rowEnergy:0.0005,colEnergy:0.0032,decision:270,start:12.5,end:3,direction:90,reason:'sideways'};
  expect(parseFrameMessage({...verdict,extra:1})).toEqual(verdict);
  const sparse = {...verdict,rowEnergy:null,colEnergy:null,decision:null,start:null,end:null,direction:null,reason:'sparse'};
  expect(parseFrameMessage(sparse)).toEqual(sparse);
  for (const change of [{page:0},{page:1.5},{ms:null},{ms:-1},{ms:Infinity},{ink:NaN},{ink:'0.1'},{rowEnergy:-0.1},
    {decision:90},{decision:'270'},{decision:undefined},{start:-1},{end:NaN},{start:undefined},{direction:0},{direction:180},{direction:'90'},
    {direction:undefined},{reason:'slow'},{reason:undefined}]) {
    expect(parseFrameMessage({...verdict,...change}),JSON.stringify(change)).toBeNull();
  }
});
