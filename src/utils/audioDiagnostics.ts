/**
 * Audio-System-Diagnose – delegiert an den Plattform-Adapter.
 * (Interface-Boundary-Regel: kein direkter AudioContext-Zugriff mehr hier.)
 */
export { checkAudioSystem } from './audioContextFactory';
