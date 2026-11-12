// @vitest-environment jsdom
import React from 'react';
import type { ReactNode } from 'react';
import { act,cleanup,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const state=vi.hoisted(()=>({holder:vi.fn(),addSample:vi.fn()}));
vi.mock('../src/hooks/usePluginState',()=>({usePluginState:()=>({lockStatus:{active:false}})}));
vi.mock('../src/context/SampleContext',()=>({useSamples:()=>({samples:[],addSample:state.addSample})}));
vi.mock('../src/utils/WebRTCManager',()=>({webRTCManager:{userId:'test-user'}}));
vi.mock('../src/utils/pluginSettings',()=>({isPluginSettingsHolder:state.holder,
  mergeKnown:(value:unknown)=>value,readPluginSettings:()=>null,writePluginSettings:()=>{}}));
vi.mock('../src/components/am/amUi',()=>({AmCard:({children,title}:{children:ReactNode;title:string})=><section>{title}{children}</section>,AmKnob:()=>null}));
import { SongMonkTerminal } from '../src/components/SongMonkTerminal';

describe('song command reaches the actual generation UI',()=>{
  beforeEach(()=>{
    state.holder.mockReturnValue(true);state.addSample.mockClear();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/wav'}})));
    vi.stubGlobal('Audio',class {volume=1;pause(){};addEventListener(){};play(){return Promise.resolve()}});
    vi.stubGlobal('URL',class extends URL {static createObjectURL(){return 'blob:test-song'}});
  });
  afterEach(()=>{cleanup();vi.unstubAllGlobals()});
  const request=()=>act(()=>{window.dispatchEvent(new CustomEvent('monk:song-generate',{detail:{prompt:'Warehouse techno 130 BPM'}}))});
  it('uses the requested prompt, generates real response data and adds the song to the library',async()=>{
    render(<SongMonkTerminal/>);request();request();
    await waitFor(()=>expect(state.addSample).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    const options=vi.mocked(fetch).mock.calls[0][1];
    expect(JSON.parse(String(options?.body)).prompt).toBe('Warehouse techno 130 BPM');
    expect(state.addSample.mock.calls[0][0]).toMatchObject({type:'Song',url:'blob:test-song'});
    expect((screen.getByLabelText('Song-Prompt') as HTMLTextAreaElement).value).toBe('Warehouse techno 130 BPM');
  });
  it('leaves a plugin held by another user untouched',()=>{
    state.holder.mockReturnValue(false);render(<SongMonkTerminal/>);request();
    expect(fetch).not.toHaveBeenCalled();expect(state.addSample).not.toHaveBeenCalled();
  });
  it('shows generation failure and does not invent a successful library entry',async()=>{
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable',{status:503}));
    render(<SongMonkTerminal/>);request();
    await waitFor(()=>expect(screen.getByText(/Song-API HTTP 503/)).toBeTruthy());
    expect(state.addSample).not.toHaveBeenCalled();
  });
});
