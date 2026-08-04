# Author user-defined states

State names and transitions are declared in project JSON, not stored as video
metadata. See [preparing video and authoring states](authoring-video-and-states.md)
for the full source-preparation and timeline-mapping workflow.

The checked CC0 idle/engaged fixture demonstrates schema 1.0 with two arbitrary
states, a resident reversible transition with endpoint runways, and
`engagement.on/off` bindings.
Explanations remain in README so JSON stays valid.

Edit names freely within the identifier grammar. Define bodies and edges in the
project; do not add runtime state-specific JavaScript. Build with:

```sh
cd my-motion
npm run avl -- compile motion.json --out dist/motion
npm run avl -- validate dist/motion/h264.avl
```

The generated `provenance.json` records every source-frame and project digest
and the CC0-1.0 license.
