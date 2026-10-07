import { describe, expect, it, vi } from 'vitest';
import { COMPARE_MAX_BYTES, COMPARE_MAX_LINES, CompareRequests } from './compare';
import { loadComparison, type CompareReader } from './compareLoad';
const a = {id:1,byteLen:10,pagedLines:true}, b = {id:2,byteLen:10,pagedLines:true};
const emptyReader = (): CompareReader => ({lines:vi.fn(async () => ({total:0,lines:[]})),sourceText:vi.fn(async () => 'null')});
function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise,resolve}; }

describe('comparison source lifecycle without GUI', () => {
  it('refuses oversized metadata before issuing either source IPC', async () => {
    const reader = emptyReader();
    await expect(loadComparison({...a,byteLen:COMPARE_MAX_BYTES + 1},b,true,() => true,reader)).rejects.toThrow('limit');
    expect(reader.sourceText).not.toHaveBeenCalled(); expect(reader.lines).not.toHaveBeenCalled();
  });
  it('refuses already cancelled work before any IPC', async () => {
    const reader = emptyReader();
    await expect(loadComparison(a,b,false,() => false,reader)).rejects.toThrow('cancelled');
    expect(reader.lines).not.toHaveBeenCalled();
  });
  it('discards late JSON results on cancellation and succeeds with a new request', async () => {
    const pending = deferred<string>(), requests = new CompareRequests(), ticket = requests.begin();
    const reader = emptyReader(); reader.sourceText = vi.fn(() => pending.promise);
    const work = loadComparison(a,b,true,requests.guard(ticket),reader);
    requests.cancel(); pending.resolve('1');
    await expect(work).rejects.toThrow('cancelled');
    await expect(loadComparison(a,b,true,requests.guard(requests.begin()),emptyReader())).resolves.toMatchObject({changes:[]});
  });
  it('discards source text from either file after a generation update', async () => {
    for (const side of [0,1]) {
      const pending = deferred<string>(), generations = [1,1], requests = new CompareRequests();
      const current = requests.guard(requests.begin(), () => generations[0], () => generations[1]);
      const reader = emptyReader(); reader.sourceText = vi.fn(() => pending.promise);
      const work = loadComparison(a,b,true,current,reader); generations[side]++; pending.resolve('1');
      await expect(work).rejects.toThrow('cancelled');
    }
  });
  it('keeps full source lines in page order and requests only bounded batches', async () => {
    const long = 'x'.repeat(5000) + '\t"tail"';
    const one = [...Array.from({length:1000},(_,index) => `line ${index}`),long];
    const two = [...one]; two[1000] += '!';
    const reader = emptyReader();
    reader.lines = vi.fn(async (id,start,count) => ({total:1001,lines:(id === 1 ? one : two).slice(start,start+count)}));
    const result = await loadComparison(a,b,false,() => true,reader);
    expect(result.changes).toEqual([1000]); expect(result.rows[1000].left).toBe(long); expect(result.rows[1000].right).toBe(long+'!');
    expect(vi.mocked(reader.lines).mock.calls).toEqual([[1,0,1000],[2,0,1000],[1,1000,1000],[2,1000,1000]]);
    expect(reader.sourceText).not.toHaveBeenCalled();
  });
  it('uses bounded source text for raw JSON and Markdown instead of the text-only lines IPC', async () => {
    const reader = emptyReader();
    reader.lines = vi.fn(async () => { throw {code:'wrongView'}; });
    reader.sourceText = vi.fn(async id => id === 1 ? '{"2":9007199254740992,"1":null}' : '{"1":null,"2":9007199254740993}');
    const result = await loadComparison({...a,pagedLines:false},{...b,pagedLines:false},false,() => true,reader);
    expect(result.changes).toEqual([0]);
    expect(result.rows[0].left).toContain('9007199254740992');
    expect(result.rows[0].right).toContain('9007199254740993');
    expect(reader.lines).not.toHaveBeenCalled();
    reader.sourceText = vi.fn(async id => id === 1 ? '# Heading\r\nold\r\n' : '# Heading\r\nnew\r\n');
    const markdown = await loadComparison({...a,pagedLines:false},{...b,pagedLines:false},false,() => true,reader);
    expect(markdown.changes).toEqual([1]);
    expect(markdown.rows.at(-1)).toMatchObject({left:'',right:''});
  });
  it('can compare a paged text document with a bounded Markdown source', async () => {
    const reader = emptyReader();
    reader.lines = vi.fn(async id => { expect(id).toBe(1); return {total:2,lines:['same','old']}; });
    reader.sourceText = vi.fn(async id => { expect(id).toBe(2); return 'same\nnew'; });
    const result = await loadComparison(a,{...b,pagedLines:false},false,() => true,reader);
    expect(result.changes).toEqual([1]);
    expect(reader.lines).toHaveBeenCalledTimes(1); expect(reader.sourceText).toHaveBeenCalledTimes(1);
  });
  it('checks cancellation and actual bounds for late raw structured-source responses', async () => {
    const pending = deferred<string>(), reader = emptyReader(); let current = true;
    reader.sourceText = vi.fn(() => pending.promise);
    const work = loadComparison({...a,pagedLines:false},{...b,pagedLines:false},false,() => current,reader);
    current = false; pending.resolve('source');
    await expect(work).rejects.toThrow('cancelled');
    for(const source of ['x'.repeat(COMPARE_MAX_BYTES+1), '\n'.repeat(COMPARE_MAX_LINES)]) {
      reader.sourceText = vi.fn(async () => source);
      await expect(loadComparison({...a,pagedLines:false},{...b,pagedLines:false},false,() => true,reader)).rejects.toThrow('limit');
    }
  });
  it('stops paging when either document generation changes during the first batch', async () => {
    const pending = deferred<{total:number;lines:string[]}>(), requests = new CompareRequests(); let generation = 1;
    const current = requests.guard(requests.begin(), () => generation);
    const reader = emptyReader(); reader.lines = vi.fn(() => pending.promise);
    const work = loadComparison(a,b,false,current,reader); generation++;
    pending.resolve({total:1001,lines:Array(1000).fill('a')});
    await expect(work).rejects.toThrow('cancelled'); expect(reader.lines).toHaveBeenCalledTimes(2);
  });
  it('discards a cancelled later page before combining it with the first source batch', async () => {
    const started = deferred<void>(), tail = deferred<{total:number;lines:string[]}>(), requests = new CompareRequests();
    const current = requests.guard(requests.begin());
    const reader = emptyReader(); reader.lines = vi.fn(async (_id,start) => {
      if (start === 0) return {total:1001,lines:Array(1000).fill('first')};
      started.resolve(); return tail.promise;
    });
    const work = loadComparison(a,b,false,current,reader); await started.promise;
    requests.cancel(); tail.resolve({total:1001,lines:['late']});
    await expect(work).rejects.toThrow('cancelled');
    expect(reader.lines).toHaveBeenCalledWith(1,1000,1000);
    expect(vi.mocked(reader.lines).mock.calls.length).toBeLessThanOrEqual(4);
  });
  it('refuses oversized page totals, inconsistent totals, zero progress and overflow', async () => {
    for (const responses of [
      [{total:COMPARE_MAX_LINES+1,lines:[]}],
      [{total:2,lines:['a']},{total:3,lines:['b']}],
      [{total:2,lines:['a']},{total:2,lines:[]}],
      [{total:2,lines:['a']},{total:2,lines:['b','c']}],
      [{total:NaN,lines:[]}],
      [{total:0,lines:['a']}],
    ]) {
      const reader = emptyReader();
      const calls = new Map<number,number>();
      reader.lines = vi.fn(async id => { const count = calls.get(id) ?? 0; calls.set(id,count+1); return responses[Math.min(count,responses.length-1)]; });
      await expect(loadComparison(a,b,false,() => true,reader)).rejects.toThrow('limit');
    }
  });
  it('checks actual returned bytes when source metadata underestimates them', async () => {
    const reader = emptyReader(); reader.sourceText = vi.fn(async () => '"'+'x'.repeat(COMPARE_MAX_BYTES)+'"');
    await expect(loadComparison(a,b,true,() => true,reader)).rejects.toThrow('limit');
    reader.lines = vi.fn(async () => ({total:1,lines:['😀'.repeat(COMPARE_MAX_BYTES/4)+'x']}));
    await expect(loadComparison(a,b,false,() => true,reader)).rejects.toThrow('limit');
  });
});
