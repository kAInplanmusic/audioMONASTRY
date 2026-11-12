The historical adapter fixture is copied byte for byte from
`model_manifest.json` at commit `e486b1476046c31e02010e2b13ad0e2aa6069c19`.
SHA256: `cbaaee3fce0ed6dbf36c07a51444d44ea6c6a16eb4891fc3055cba7bc8340d64`.

It retains data needed to test retired handlers, incomplete pins and rejected
proposed models. It is used only while those test modules execute, then the
canonical manifest path is restored. It is never loaded by production startup,
the fleet planner, image builds or GPU acceptance. The active selected fleet
continues to use the canonical runtime manifest and asset lock unchanged.
