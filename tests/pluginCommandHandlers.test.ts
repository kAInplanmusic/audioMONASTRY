import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const boundary=vi.hoisted(()=>({setDrumKit:vi.fn(),program:vi.fn()}));
vi.mock('../src/utils/audioEngine',()=>({audioEngine:{setDrumKit:boundary.setDrumKit}}));
vi.mock('../src/core/instrument/InstrumentBackend',()=>({instrumentBackend:{handleProgramChange:boundary.program}}));
import '../src/core/voice/pluginCommandRegistry';
import { voiceControlService } from '../src/core/voice/VoiceControlService';
import { controlBus } from '../src/core/events/ControlBus';

describe('real registered command handlers',()=>{
  beforeEach(()=>vi.clearAllMocks());
  afterEach(()=>vi.unstubAllGlobals());
  it('selects the requested 909 rather than silently falling back to the 808 kit',async()=>{
    expect((await voiceControlService.executePluginCommand('test','drumsampler','kit(909)')).handled).toBe(true);
    expect(boundary.setDrumKit).toHaveBeenCalledWith('tr-909');
    expect((await voiceControlService.executePluginCommand('test','drumsampler','kit(unknown)')).handled).toBe(false);
  });
  it('forwards the actual library search query',async()=>{
    const receive=vi.fn();const off=controlBus.on('monk:library-search',receive);
    try {
      await voiceControlService.executePluginCommand('test','biblio','search(kick)');
      expect(receive).toHaveBeenCalledWith('kick');
    } finally {off();}
  });
  it('reports a failed cloud sync as a failed command',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:503})));
    const result=await voiceControlService.executePluginCommand('test','biblio','sync');
    expect(result.handled).toBe(false);
    expect(result.error).toContain('503');
  });
  it('waits for actual instrument loading before acknowledging the program change',async()=>{
    let finish!:()=>void;let settled=false;
    boundary.program.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}));
    const result=voiceControlService.executePluginCommand('test','instru','program(40)').then(value=>{settled=true;return value});
    await vi.waitFor(()=>expect(boundary.program).toHaveBeenCalledWith(40));
    expect(settled).toBe(false);finish();
    expect((await result).handled).toBe(true);
  });
});
