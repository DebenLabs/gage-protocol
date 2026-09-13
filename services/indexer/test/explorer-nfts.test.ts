import { describe, expect, it, vi } from "vitest";
import { explorerNftIds } from "../src/lib/explorer-nfts";
const w='0x1111111111111111111111111111111111111111',m='0x2222222222222222222222222222222222222222';
describe('wallet NFT discovery',()=>{
 it('paginates only canonical-manager candidates; ownership is verified separately',async()=>{
  const f=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({items:[{id:'1',token:{address_hash:m}},{id:'99',token:{address_hash:w}}],next_page_params:{token_id:'1'}}))).mockResolvedValueOnce(new Response(JSON.stringify({items:[{id:'2',token:{address_hash:m}}],next_page_params:null})));
  expect(await explorerNftIds('https://example.com/api/v2',w,m,f)).toEqual(['1','2']);
  expect(f.mock.calls[1]![0]).toContain('token_id=1');
 });
 it('does not call failed or incomplete responses an empty wallet',async()=>{
  await expect(explorerNftIds('https://example.com',w,m,vi.fn().mockResolvedValue(new Response('',{status:503})))).rejects.toThrow();
  const repeated={items:[],next_page_params:{token_id:'1'}};
  await expect(explorerNftIds('https://example.com',w,m,vi.fn().mockImplementation(async()=>new Response(JSON.stringify(repeated))))).rejects.toThrow('incomplete');
 });
});
