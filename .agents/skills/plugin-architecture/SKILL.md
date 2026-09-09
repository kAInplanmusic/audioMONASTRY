# Plugin Architecture Skill

## Purpose

Maintain the 16-plugin audioMONASTRY architecture without breaking
real-time audio, collaboration, locking or existing terminal UIs.

## Canonical IDs

`mixer`, `drop`, `song`, `effect`, `syntisampler`, `drumsampler`,
`instru`, `biblio`, `voice`, `sound`, `stem`, `spatial`,
`eq`, `dsp`, `master`, `record`.

## Required Boundaries

- React components are UI.
- Plugin adapters own plugin runtime behavior.
- Audio backends own browser/audio platform details.
- AI and network work is asynchronous.
- Audio `process()` is synchronous and real-time safe.
- Collaboration locks are centralized.
- Legacy IDs are aliases, not additional plugins.

## Required Verification

Run:

```bash
npm run lint
npm test -- --run
npm run verify
npm run build
python -m unittest discover -s tests -p 'plugin_interface_test.py'
```

Do not merge changes that introduce a second plugin registry,
a second lock truth or direct network work in the audio process callback.
